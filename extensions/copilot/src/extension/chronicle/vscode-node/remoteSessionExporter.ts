/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ICopilotTokenManager } from '../../../platform/authentication/common/copilotTokenManager';
import { IChatSessionService } from '../../../platform/chat/common/chatSessionService';
import { CopilotChatAttr, GenAiAttr, GenAiOperationName } from '../../../platform/otel/common/genAiAttributes';
import { type ICompletedSpanData, IOTelService } from '../../../platform/otel/common/otelService';
import { getGitHubRepoInfoFromContext, IGitService } from '../../../platform/git/common/gitService';
import { IGithubRepositoryService } from '../../../platform/github/common/githubService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';
import { CircuitBreaker, CircuitState } from '../common/circuitBreaker';
import {
	createSessionTranslationState,
	makeShutdownEvent,
	translateSpan,
	type SessionTranslationState,
} from '../common/eventTranslator';
import type { GitHubRepository, McSessionIds, SessionEvent, WorkingDirectoryContext } from '../common/missionControlTypes';
import { filterSecretsFromObj, addSecretValues } from '../common/secretFilter';
import { MissionControlClient } from '../node/missionControlClient';

// ── Configuration ───────────────────────────────────────────────────────────────

/** How often to flush buffered events to MC (ms). */
const BATCH_INTERVAL_MS = 500;

/** Faster drain interval when buffer is above soft cap. */
const FAST_BATCH_INTERVAL_MS = 200;

/** Max events per flush request. */
const MAX_EVENTS_PER_FLUSH = 500;

/** Hard cap on buffered events (drop oldest beyond this). */
const MAX_BUFFER_SIZE = 1_000;

/** Soft cap — switch to faster drain. */
const SOFT_BUFFER_CAP = 500;

/** Timeout for the final flush on dispose (ms). */
const FINAL_FLUSH_TIMEOUT_MS = 5_000;

/**
 * Exports VS Code chat session events to Mission Control in real-time.
 *
 * - Listens to OTel spans, translates to MC SessionEvent format
 * - Buffers events and flushes in batches every 500ms
 * - Circuit breaker prevents cascading failures when MC is unavailable
 * - Lazy initialization: no work until the first real chat interaction
 *
 * All MC operations are fire-and-forget — never blocks or slows the chat session.
 */
export class RemoteSessionExporter extends Disposable implements IExtensionContribution {

	// ── Per-session state ────────────────────────────────────────────────────────

	/** Per-session MC IDs (created lazily on first interaction). */
	private readonly _mcSessions = new Map<string, McSessionIds>();

	/** Per-session translation state (parentId chaining, session.start tracking). */
	private readonly _translationStates = new Map<string, SessionTranslationState>();

	/** Sessions that failed MC initialization — don't retry. */
	private readonly _disabledSessions = new Set<string>();

	/** Sessions currently initializing (prevent concurrent init). */
	private readonly _initializingSessions = new Set<string>();

	// ── Shared state ─────────────────────────────────────────────────────────────

	private readonly _eventBuffer: SessionEvent[] = [];
	private readonly _mcClient: MissionControlClient;
	private readonly _circuitBreaker: CircuitBreaker;

	private _flushTimer: ReturnType<typeof setInterval> | undefined;
	private _isFlushing = false;

	/** Resolved lazily on first use. */
	private _repository: GitHubRepository | undefined;
	private _repositoryResolved = false;

	constructor(
		@IOTelService private readonly _otelService: IOTelService,
		@IChatSessionService private readonly _chatSessionService: IChatSessionService,
		@ICopilotTokenManager private readonly _tokenManager: ICopilotTokenManager,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@IGitService private readonly _gitService: IGitService,
		@IGithubRepositoryService private readonly _githubRepoService: IGithubRepositoryService,
	) {
		super();

		this._mcClient = new MissionControlClient(this._tokenManager, this._authService);
		this._circuitBreaker = new CircuitBreaker({
			failureThreshold: 5,
			resetTimeoutMs: 1_000,
			maxResetTimeoutMs: 30_000,
		});

		// Register known auth tokens as dynamic secrets for filtering
		this._registerAuthSecrets();

		// Listen to completed OTel spans — deferred off the callback
		this._register(this._otelService.onDidCompleteSpan(span => {
			queueMicrotask(() => this._handleSpan(span));
		}));

		// Clean up on session disposal
		this._register(this._chatSessionService.onDidDisposeChatSession(sessionId => {
			this._handleSessionDispose(sessionId);
		}));
	}

	override dispose(): void {
		if (this._flushTimer !== undefined) {
			clearInterval(this._flushTimer);
			this._flushTimer = undefined;
		}

		// Best-effort final flush with timeout
		const pending = this._eventBuffer.length;
		if (pending > 0) {
			console.log(`[RemoteSessionExporter] Disposing with ${pending} buffered events, attempting final flush`);
			// Fire-and-forget with timeout — cannot block dispose
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), FINAL_FLUSH_TIMEOUT_MS);
			this._flushBatch().finally(() => clearTimeout(timeout));
		}

		this._mcSessions.clear();
		this._translationStates.clear();
		this._disabledSessions.clear();
		this._initializingSessions.clear();

		super.dispose();
	}

	// ── Span handling ────────────────────────────────────────────────────────────

	private _handleSpan(span: ICompletedSpanData): void {
		try {
			const sessionId = this._getSessionId(span);
			if (!sessionId || this._disabledSessions.has(sessionId)) {
				return;
			}

			const operationName = span.attributes[GenAiAttr.OPERATION_NAME] as string | undefined;

			// Only start tracking on invoke_agent (real user interaction)
			if (!this._mcSessions.has(sessionId) && !this._initializingSessions.has(sessionId)) {
				if (operationName !== GenAiOperationName.INVOKE_AGENT) {
					return;
				}
				// Trigger lazy initialization — don't await, buffer events in the meantime
				this._initializeSession(sessionId, span);
			}

			// Translate span to MC events
			const state = this._getOrCreateTranslationState(sessionId);
			const context = this._extractContext(span);
			const events = translateSpan(span, state, context);

			if (events.length > 0) {
				this._bufferEvents(events);
				this._ensureFlushTimer();
			}
		} catch (err) {
			console.error('[RemoteSessionExporter] Error handling span:', err);
		}
	}

	private _getSessionId(span: ICompletedSpanData): string | undefined {
		return (span.attributes[CopilotChatAttr.CHAT_SESSION_ID] as string | undefined)
			?? (span.attributes[GenAiAttr.CONVERSATION_ID] as string | undefined)
			?? (span.attributes[CopilotChatAttr.SESSION_ID] as string | undefined);
	}

	private _getOrCreateTranslationState(sessionId: string): SessionTranslationState {
		let state = this._translationStates.get(sessionId);
		if (!state) {
			state = createSessionTranslationState();
			this._translationStates.set(sessionId, state);
		}
		return state;
	}

	private _extractContext(span: ICompletedSpanData): WorkingDirectoryContext | undefined {
		const branch = span.attributes[CopilotChatAttr.REPO_HEAD_BRANCH_NAME] as string | undefined;
		const remoteUrl = span.attributes[CopilotChatAttr.REPO_REMOTE_URL] as string | undefined;
		const commitHash = span.attributes[CopilotChatAttr.REPO_HEAD_COMMIT_HASH] as string | undefined;
		if (!branch && !remoteUrl) {
			return undefined;
		}
		return {
			repository: remoteUrl,
			branch,
			headCommit: commitHash,
		};
	}

	// ── Secret registration ─────────────────────────────────────────────────────

	/**
	 * Register known authentication tokens as dynamic secrets so they are
	 * redacted from any event data sent to Mission Control.
	 */
	private _registerAuthSecrets(): void {
		// GitHub OAuth token
		const githubToken = this._authService.anyGitHubSession?.accessToken;
		if (githubToken) {
			addSecretValues(githubToken);
		}

		// Copilot proxy token (async — register when available)
		this._tokenManager.getCopilotToken().then(token => {
			if (token.token) {
				addSecretValues(token.token);
			}
		}).catch(() => { /* non-fatal */ });
	}

	// ── Lazy session initialization ──────────────────────────────────────────────

	private async _initializeSession(sessionId: string, _triggerSpan: ICompletedSpanData): Promise<void> {
		this._initializingSessions.add(sessionId);

		try {
			const repo = await this._resolveRepository();
			if (!repo) {
				console.log('[RemoteSessionExporter] No GitHub repository detected, disabling for session', sessionId);
				this._disabledSessions.add(sessionId);
				return;
			}

			const result = await this._mcClient.createSession(
				repo.repoIds.ownerId,
				repo.repoIds.repoId,
				sessionId,
			);

			if (!result.ok) {
				console.error(`[RemoteSessionExporter] Failed to create MC session: ${result.reason}`);
				this._disabledSessions.add(sessionId);
				return;
			}

			if (!result.response.task_id) {
				console.error('[RemoteSessionExporter] MC session created without task_id');
				this._disabledSessions.add(sessionId);
				return;
			}

			const mcIds: McSessionIds = {
				mcSessionId: result.response.id,
				mcTaskId: result.response.task_id,
			};

			this._mcSessions.set(sessionId, mcIds);
			console.log(`[RemoteSessionExporter] MC session created: ${mcIds.mcSessionId} for chat session ${sessionId}`);
		} catch (err) {
			console.error('[RemoteSessionExporter] Session initialization failed:', err);
			this._disabledSessions.add(sessionId);
		} finally {
			this._initializingSessions.delete(sessionId);
		}
	}

	/**
	 * Resolve the GitHub repository context (cached after first resolution).
	 * Uses the active git repository to get owner/repo names, then resolves
	 * numeric IDs via the GitHub REST API.
	 */
	private async _resolveRepository(): Promise<GitHubRepository | undefined> {
		if (this._repositoryResolved) {
			return this._repository;
		}
		this._repositoryResolved = true;

		try {
			const repoContext = this._gitService.activeRepository?.get();
			if (!repoContext) {
				return undefined;
			}

			const repoInfo = getGitHubRepoInfoFromContext(repoContext);
			if (!repoInfo) {
				return undefined;
			}

			const { id: repoId } = repoInfo;
			const apiResponse = await this._githubRepoService.getRepositoryInfo(repoId.org, repoId.repo);

			this._repository = {
				owner: repoId.org,
				repo: repoId.repo,
				repoIds: {
					ownerId: apiResponse.owner.id,
					repoId: apiResponse.id,
				},
			};
			console.log(`[RemoteSessionExporter] Resolved repo: ${repoId.org}/${repoId.repo} (owner=${apiResponse.owner.id}, repo=${apiResponse.id})`);
			return this._repository;
		} catch (err) {
			console.error('[RemoteSessionExporter] Failed to resolve repository:', err);
			return undefined;
		}
	}

	// ── Session disposal ─────────────────────────────────────────────────────────

	private _handleSessionDispose(sessionId: string): void {
		const state = this._translationStates.get(sessionId);
		if (state && this._mcSessions.has(sessionId)) {
			// Emit session.shutdown event
			const event = makeShutdownEvent(state);
			this._bufferEvents([event]);
		}

		this._mcSessions.delete(sessionId);
		this._translationStates.delete(sessionId);
		this._disabledSessions.delete(sessionId);
		this._initializingSessions.delete(sessionId);
	}

	// ── Buffering ────────────────────────────────────────────────────────────────

	private _bufferEvents(events: SessionEvent[]): void {
		this._eventBuffer.push(...events);

		// Hard cap — drop oldest events
		if (this._eventBuffer.length > MAX_BUFFER_SIZE) {
			const dropped = this._eventBuffer.length - MAX_BUFFER_SIZE;
			this._eventBuffer.splice(0, dropped);
			console.log(`[RemoteSessionExporter] Buffer hard cap hit, dropped ${dropped} oldest events`);
		}
	}

	// ── Flush timer ──────────────────────────────────────────────────────────────

	private _ensureFlushTimer(): void {
		if (this._flushTimer !== undefined) {
			return;
		}

		const interval = this._eventBuffer.length > SOFT_BUFFER_CAP
			? FAST_BATCH_INTERVAL_MS
			: BATCH_INTERVAL_MS;

		this._flushTimer = setInterval(() => {
			this._flushBatch().catch(err => {
				console.error('[RemoteSessionExporter] Flush error:', err);
			});
		}, interval);
	}

	private _stopFlushTimer(): void {
		if (this._flushTimer !== undefined) {
			clearInterval(this._flushTimer);
			this._flushTimer = undefined;
		}
	}

	// ── Batch flush ──────────────────────────────────────────────────────────────

	private async _flushBatch(): Promise<void> {
		if (this._isFlushing) {
			return;
		}

		// Nothing to send and no active MC sessions — stop the timer
		if (this._eventBuffer.length === 0) {
			if (this._mcSessions.size === 0) {
				this._stopFlushTimer();
			}
			return;
		}

		// Circuit breaker check
		if (!this._circuitBreaker.canRequest()) {
			// Cap buffer while circuit is open
			if (this._eventBuffer.length > MAX_BUFFER_SIZE) {
				const dropped = this._eventBuffer.length - MAX_BUFFER_SIZE;
				this._eventBuffer.splice(0, dropped);
			}
			return;
		}

		this._isFlushing = true;
		const events = this._eventBuffer.splice(0, MAX_EVENTS_PER_FLUSH);

		try {
			// Find the MC session to send to. For now, use the first active session.
			// Events from different sessions could theoretically be routed to different
			// MC sessions, but keep it simple for now
			const mcSessionId = this._getTargetMcSession();
			if (!mcSessionId) {
				// No active MC session yet — re-queue events
				this._eventBuffer.unshift(...events);
				return;
			}

			// Redact secrets before transmitting to Mission Control.
			// filterSecretsFromObj returns new objects so the originals in
			// the buffer stay intact for local persistence / re-queue on failure.
			const filteredEvents = events.map(e => filterSecretsFromObj(e));

			const success = await this._mcClient.submitSessionEvents(mcSessionId, filteredEvents);

			if (success) {
				this._circuitBreaker.recordSuccess();
			} else {
				// Re-queue and record failure
				this._eventBuffer.unshift(...events);
				this._circuitBreaker.recordFailure();

				if (this._circuitBreaker.getState() === CircuitState.OPEN) {
					console.warn(
						`[RemoteSessionExporter] Circuit opened after ${this._circuitBreaker.getFailureCount()} failures`
					);
				}
			}
		} catch (err) {
			// Re-queue on unexpected error
			this._eventBuffer.unshift(...events);
			this._circuitBreaker.recordFailure();
			console.error('[RemoteSessionExporter] Unexpected flush error:', err);
		} finally {
			this._isFlushing = false;
		}

		// Adjust timer interval based on buffer pressure
		if (this._eventBuffer.length > SOFT_BUFFER_CAP && this._flushTimer !== undefined) {
			this._stopFlushTimer();
			this._ensureFlushTimer();
		}
	}

	private _getTargetMcSession(): string | undefined {
		// Return the first active MC session ID
		for (const [, mcIds] of this._mcSessions) {
			return mcIds.mcSessionId;
		}
		return undefined;
	}
}
