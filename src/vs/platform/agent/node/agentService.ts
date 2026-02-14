/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotClient, CopilotSession } from '@github/copilot-sdk';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IAgentCreateSessionConfig, IAgentProgressEvent, IAgentService, IAgentSessionMetadata } from '../common/agentService.js';

function log(level: string, ...args: unknown[]): void {
	console.log(`[AgentHost][${level}]`, ...args);
}

/**
 * The actual agent service implementation that runs inside the agent host
 * utility process. Wraps the Copilot SDK `CopilotClient`.
 */
export class AgentService extends Disposable implements IAgentService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidSessionProgress = this._register(new Emitter<IAgentProgressEvent>());
	readonly onDidSessionProgress = this._onDidSessionProgress.event;

	private _client: CopilotClient | undefined;
	private _githubToken: string | undefined;
	private readonly _sessions = new Map<string, CopilotSession>();

	// ---- auth ---------------------------------------------------------------

	async setAuthToken(token: string): Promise<void> {
		const tokenChanged = this._githubToken !== token;
		this._githubToken = token;
		log('info', `Auth token ${tokenChanged ? 'updated' : 'unchanged'} (${token.substring(0, 4)}...)`);
		// Only restart the client if no sessions are active. Otherwise the new
		// token will be picked up on the next client restart.
		if (tokenChanged && this._client && this._sessions.size === 0) {
			log('info', 'Restarting CopilotClient with new token');
			await this._client.stop();
			this._client = undefined;
		}
	}

	// ---- client lifecycle ---------------------------------------------------

	private async _ensureClient(): Promise<CopilotClient> {
		if (!this._client) {
			log('info', 'Starting CopilotClient...', this._githubToken ? '(with token)' : '(using logged-in user)');
			this._client = new CopilotClient({
				githubToken: this._githubToken,
				useLoggedInUser: !this._githubToken,
			});
			await this._client.start();
			log('info', 'CopilotClient started successfully');
		}
		return this._client;
	}

	// ---- session management -------------------------------------------------

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		log('debug', 'Listing sessions...');
		const client = await this._ensureClient();
		const sessions = await client.listSessions();
		const result = sessions.map(s => ({
			sessionId: s.sessionId,
			startTime: s.startTime.getTime(),
			modifiedTime: s.modifiedTime.getTime(),
			summary: s.summary,
		}));
		log('debug', `Found ${result.length} sessions`);
		return result;
	}

	async createSession(config?: IAgentCreateSessionConfig): Promise<string> {
		log('info', 'Creating session...', config?.model ? `model=${config.model}` : '');
		const client = await this._ensureClient();
		const session = await client.createSession({
			model: config?.model,
			sessionId: config?.sessionId,
			streaming: true,
		});

		this._sessions.set(session.sessionId, session);
		this._attachSessionListeners(session);

		log('info', `Session created: ${session.sessionId}`);
		return session.sessionId;
	}

	async sendMessage(sessionId: string, prompt: string): Promise<void> {
		log('info', `[${sessionId}] Sending message: "${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}"`);
		let session = this._sessions.get(sessionId);
		if (!session) {
			// Session not in memory - try to resume it
			log('info', `[${sessionId}] Session not in memory, resuming...`);
			const client = await this._ensureClient();
			session = await client.resumeSession(sessionId);
			this._sessions.set(sessionId, session);
			this._attachSessionListeners(session);
		}
		await session.send({ prompt });
		log('info', `[${sessionId}] Message sent, awaiting response...`);
	}

	async getSessionMessages(sessionId: string): Promise<IAgentProgressEvent[]> {
		const session = this._sessions.get(sessionId);
		if (!session) {
			// Try to resume the session so we can get its messages
			try {
				const client = await this._ensureClient();
				const resumed = await client.resumeSession(sessionId);
				this._sessions.set(sessionId, resumed);
				this._attachSessionListeners(resumed);
				const events = await resumed.getMessages();
				return this._mapSessionEvents(sessionId, events);
			} catch {
				return [];
			}
		}

		const events = await session.getMessages();
		return this._mapSessionEvents(sessionId, events);
	}

	private _mapSessionEvents(sessionId: string, events: { type: string; data?: Record<string, unknown> }[]): IAgentProgressEvent[] {
		return events
			.filter(e => e.type === 'assistant.message' || e.type === 'user.message')
			.map(e => ({
				sessionId,
				type: 'message' as const,
				content: (e as { data?: { content?: string } }).data?.content ?? '',
				role: e.type === 'user.message' ? 'user' as const : 'assistant' as const,
			}));
	}

	async destroySession(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (session) {
			await session.destroy();
			this._sessions.delete(sessionId);
		}
	}

	async ping(msg: string): Promise<string> {
		return `pong: ${msg}`;
	}

	// ---- helpers ------------------------------------------------------------

	private _attachSessionListeners(session: CopilotSession): void {
		const sessionId = session.sessionId;
		log('debug', `[${sessionId}] Attaching event listeners`);

		session.on('assistant.message_delta', (event) => {
			log('trace', `[${sessionId}] delta: ${event.data.deltaContent.length} chars`);
			this._onDidSessionProgress.fire({
				sessionId,
				type: 'delta',
				content: event.data.deltaContent,
			});
		});

		session.on('assistant.message', (event) => {
			log('info', `[${sessionId}] Full message received: ${event.data.content.length} chars`);
			this._onDidSessionProgress.fire({
				sessionId,
				type: 'message',
				content: event.data.content,
			});
		});

		session.on('tool.execution_start', (event) => {
			log('info', `[${sessionId}] Tool started: ${event.data.toolName}`);
			this._onDidSessionProgress.fire({
				sessionId,
				type: 'tool_start',
				content: event.data.toolName,
			});
		});

		session.on('tool.execution_complete', (event) => {
			log('info', `[${sessionId}] Tool completed: ${event.data.toolCallId}`);
			this._onDidSessionProgress.fire({
				sessionId,
				type: 'tool_complete',
				content: event.data.toolCallId,
			});
		});

		session.on('session.idle', () => {
			log('info', `[${sessionId}] Session idle`);
			this._onDidSessionProgress.fire({
				sessionId,
				type: 'idle',
			});
		});
	}

	override dispose(): void {
		// Clean up SDK resources
		for (const session of this._sessions.values()) {
			session.destroy().catch(() => { /* best-effort */ });
		}
		this._sessions.clear();
		this._client?.stop().catch(() => { /* best-effort */ });
		super.dispose();
	}
}
