/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ICopilotTokenManager } from '../../../platform/authentication/common/copilotTokenManager';
import type { CreateSessionFailureReason, CreateSessionResult, MissionControlSession, SessionEvent } from '../common/missionControlTypes';

/** Timeout for individual MC API requests (ms). */
const REQUEST_TIMEOUT_MS = 10_000;

/** MC sessions endpoint path through copilot-api proxy. */
const SESSIONS_PATH = '/agents/sessions';

/**
 * HTTP client for Mission Control's Session API.
 *
 * Mirrors the CLI's MissionControlClient — creates sessions and submits
 * event batches. All methods are non-blocking: failures are logged but
 * never thrown to avoid disrupting the chat session.
 *
 * Auth uses the GitHub OAuth token (preferred) or Copilot proxy token.
 * The MC base URL is derived from the Copilot API endpoint.
 */
export class MissionControlClient {

	constructor(
		private readonly _tokenManager: ICopilotTokenManager,
		private readonly _authService: IAuthenticationService,
	) { }

	/**
	 * Create a session in Mission Control.
	 *
	 * MC automatically creates/links a task for the session.
	 * The response includes both the session ID and the associated task ID.
	 */
	async createSession(
		ownerId: number,
		repoId: number,
		sessionId: string,
	): Promise<CreateSessionResult> {
		try {
			const { url, headers } = await this._buildRequest(SESSIONS_PATH);
			if (!url) {
				return { ok: false, reason: 'error' };
			}

			const body = {
				owner_id: ownerId,
				repo_id: repoId,
				agent_task_id: sessionId,
				indexing_level: 'user',
			};

			const res = await fetch(url, {
				method: 'POST',
				headers,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				const text = await res.text().catch(() => '');
				console.error(`[MissionControlClient] createSession ${res.status}: ${text.slice(0, 200)}`);
				const reason: CreateSessionFailureReason = res.status === 403 ? 'policy_blocked' : 'error';
				return { ok: false, reason };
			}

			const response = await res.json() as { id: string; task_id?: string; agent_task_id?: string };
			return { ok: true, response };
		} catch (err) {
			console.error('[MissionControlClient] createSession failed:', err);
			return { ok: false, reason: 'error' };
		}
	}

	/**
	 * Submit a batch of events to a session.
	 * @returns true if the submission succeeded.
	 */
	async submitSessionEvents(
		sessionId: string,
		events: SessionEvent[],
	): Promise<boolean> {
		try {
			const { url, headers } = await this._buildRequest(`${SESSIONS_PATH}/${sessionId}/events`);
			if (!url) {
				return false;
			}

			const res = await fetch(url, {
				method: 'POST',
				headers,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				body: JSON.stringify({ events }),
			});

			if (!res.ok) {
				const text = await res.text().catch(() => '');
				console.error(`[MissionControlClient] submitEvents ${res.status}: ${text.slice(0, 200)}`);
				return false;
			}

			console.log(`[MissionControlClient] submitEvents OK: ${events.length} events to session ${sessionId}`);
			return true;
		} catch (err) {
			console.error('[MissionControlClient] submitEvents failed:', err);
			return false;
		}
	}

	/**
	 * Get a session by ID (used for reattach verification).
	 */
	async getSession(sessionId: string): Promise<MissionControlSession | undefined> {
		try {
			const { url, headers } = await this._buildRequest(`${SESSIONS_PATH}/${sessionId}`);
			if (!url) {
				return undefined;
			}

			const res = await fetch(url, {
				method: 'GET',
				headers,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});

			if (!res.ok) {
				return undefined;
			}

			return (await res.json()) as MissionControlSession;
		} catch {
			return undefined;
		}
	}

	/**
	 * Build the full URL and auth headers for an MC API request.
	 * Derives the base URL from the Copilot API endpoint.
	 */
	private async _buildRequest(path: string): Promise<{ url: string | undefined; headers: Record<string, string> }> {
		try {
			const copilotToken = await this._tokenManager.getCopilotToken();
			const baseUrl = copilotToken.endpoints?.api;
			if (!baseUrl) {
				console.log('[MissionControlClient] No API endpoint available');
				return { url: undefined, headers: {} };
			}

			// Prefer GitHub OAuth token (like CLI does), fallback to Copilot proxy token
			const githubToken = this._authService.anyGitHubSession?.accessToken;
			const bearerToken = githubToken ?? copilotToken.token;

			const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${bearerToken}`,
				'Copilot-Integration-Id': 'vscode-chat',
			};

			return { url, headers };
		} catch (err) {
			console.error('[MissionControlClient] Failed to build request:', err);
			return { url: undefined, headers: {} };
		}
	}
}
