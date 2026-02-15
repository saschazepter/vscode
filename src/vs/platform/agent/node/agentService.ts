/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotClient, CopilotSession, type SessionEvent, type SessionEventPayload } from '@github/copilot-sdk';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IAgentCreateSessionConfig, IAgentProgressEvent, IAgentMessageEvent, IAgentService, IAgentSessionMetadata } from '../common/agentService.js';
import { CopilotSessionWrapper } from './copilotSessionWrapper.js';

function tryStringify(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
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
	private readonly _sessions = this._register(new DisposableMap<string, CopilotSessionWrapper>());

	constructor(
		private readonly _logService: ILogService,
	) {
		super();
		this._logService.info('AgentService initialized');
	}

	// ---- auth ---------------------------------------------------------------

	async setAuthToken(token: string): Promise<void> {
		const tokenChanged = this._githubToken !== token;
		this._githubToken = token;
		this._logService.info(`Auth token ${tokenChanged ? 'updated' : 'unchanged'} (${token.substring(0, 4)}...)`);
		if (tokenChanged && this._client && this._sessions.size === 0) {
			this._logService.info('Restarting CopilotClient with new token');
			await this._client.stop();
			this._client = undefined;
		}
	}

	// ---- client lifecycle ---------------------------------------------------

	private async _ensureClient(): Promise<CopilotClient> {
		if (!this._client) {
			this._logService.info(`Starting CopilotClient... ${this._githubToken ? '(with token)' : '(using logged-in user)'}`);
			this._client = new CopilotClient({
				githubToken: this._githubToken,
				useLoggedInUser: !this._githubToken,
			});
			await this._client.start();
			this._logService.info('CopilotClient started successfully');
		}
		return this._client;
	}

	// ---- session management -------------------------------------------------

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		this._logService.info('Listing sessions...');
		const client = await this._ensureClient();
		const sessions = await client.listSessions();
		const result = sessions.map(s => ({
			sessionId: s.sessionId,
			startTime: s.startTime.getTime(),
			modifiedTime: s.modifiedTime.getTime(),
			summary: s.summary,
		}));
		this._logService.info(`Found ${result.length} sessions`);
		return result;
	}

	async createSession(config?: IAgentCreateSessionConfig): Promise<string> {
		this._logService.info(`Creating session... ${config?.model ? `model=${config.model}` : ''}`);
		const client = await this._ensureClient();
		const raw = await client.createSession({
			model: config?.model,
			sessionId: config?.sessionId,
			streaming: true,
		});

		const wrapper = this._trackSession(raw);
		this._logService.info(`Session created: ${wrapper.sessionId}`);
		return wrapper.sessionId;
	}

	async sendMessage(sessionId: string, prompt: string): Promise<void> {
		this._logService.info(`[${sessionId}] sendMessage called: "${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}"`);
		const entry = this._sessions.get(sessionId) ?? await this._resumeSession(sessionId);
		this._logService.info(`[${sessionId}] Found session wrapper, calling session.send()...`);
		await entry.session.send({ prompt });
		this._logService.info(`[${sessionId}] session.send() returned`);
	}

	async getSessionMessages(sessionId: string): Promise<IAgentMessageEvent[]> {
		const entry = this._sessions.get(sessionId) ?? await this._resumeSession(sessionId).catch(() => undefined);
		if (!entry) {
			return [];
		}

		const events = await entry.session.getMessages();
		return this._mapSessionEvents(sessionId, events);
	}

	async disposeSession(sessionId: string): Promise<void> {
		this._sessions.deleteAndDispose(sessionId);
	}

	async shutdown(): Promise<void> {
		this._logService.info('AgentService: shutting down...');
		this._sessions.clearAndDisposeAll();
		await this._client?.stop();
		this._client = undefined;
	}

	// ---- helpers ------------------------------------------------------------

	private _trackSession(raw: CopilotSession): CopilotSessionWrapper {
		const wrapper = new CopilotSessionWrapper(raw);
		const sessionId = wrapper.sessionId;

		// Event subscriptions below are automatically disposed when the wrapper
		// is disposed - the wrapper's _sdkEvent() registers both the emitter and
		// the SDK unsubscribe callback on its internal DisposableStore.

		wrapper.onMessageDelta(e => {
			this._logService.trace(`[${sessionId}] delta: ${e.data.deltaContent}`);
			this._onDidSessionProgress.fire({
				sessionId,
				type: 'delta',
				messageId: e.data.messageId,
				content: e.data.deltaContent,
				totalResponseSizeBytes: e.data.totalResponseSizeBytes,
				parentToolCallId: e.data.parentToolCallId,
			});
		});

		wrapper.onMessage(e => {
			this._logService.info(`[${sessionId}] Full message received: ${e.data.content.length} chars`);
			this._onDidSessionProgress.fire({
				sessionId,
				type: 'message',
				role: 'assistant',
				messageId: e.data.messageId,
				content: e.data.content,
				toolRequests: e.data.toolRequests?.map(tr => ({
					toolCallId: tr.toolCallId,
					name: tr.name,
					arguments: tr.arguments !== undefined ? tryStringify(tr.arguments) : undefined,
					type: tr.type,
				})),
				reasoningOpaque: e.data.reasoningOpaque,
				reasoningText: e.data.reasoningText,
				encryptedContent: e.data.encryptedContent,
				parentToolCallId: e.data.parentToolCallId,
			});
		});

		wrapper.onToolStart(e => {
			this._logService.info(`[${sessionId}] Tool started: ${e.data.toolName}`);
			this._onDidSessionProgress.fire({
				sessionId,
				type: 'tool_start',
				toolCallId: e.data.toolCallId,
				toolName: e.data.toolName,
				toolArguments: e.data.arguments !== undefined ? tryStringify(e.data.arguments) : undefined,
				mcpServerName: e.data.mcpServerName,
				mcpToolName: e.data.mcpToolName,
				parentToolCallId: e.data.parentToolCallId,
			});
		});

		wrapper.onToolComplete(e => {
			this._logService.info(`[${sessionId}] Tool completed: ${e.data.toolCallId}`);
			this._onDidSessionProgress.fire({
				sessionId,
				type: 'tool_complete',
				toolCallId: e.data.toolCallId,
				success: e.data.success,
				isUserRequested: e.data.isUserRequested,
				result: e.data.result,
				error: e.data.error,
				toolTelemetry: e.data.toolTelemetry !== undefined ? tryStringify(e.data.toolTelemetry) : undefined,
				parentToolCallId: e.data.parentToolCallId,
			});
		});

		wrapper.onIdle(() => {
			this._logService.info(`[${sessionId}] Session idle`);
			this._onDidSessionProgress.fire({ sessionId, type: 'idle' });
		});

		// --- Just for logging ---

		wrapper.onSessionStart(e => {
			this._logService.trace(`[${sessionId}] Session started: model=${e.data.selectedModel ?? 'default'}, producer=${e.data.producer}`);
		});

		wrapper.onSessionResume(e => {
			this._logService.trace(`[${sessionId}] Session resumed: eventCount=${e.data.eventCount}`);
		});

		wrapper.onSessionError(e => {
			this._logService.error(`[${sessionId}] Session error: ${e.data.errorType} - ${e.data.message}`);
		});

		wrapper.onSessionInfo(e => {
			this._logService.trace(`[${sessionId}] Session info [${e.data.infoType}]: ${e.data.message}`);
		});

		wrapper.onSessionModelChange(e => {
			this._logService.trace(`[${sessionId}] Model changed: ${e.data.previousModel ?? '(none)'} -> ${e.data.newModel}`);
		});

		wrapper.onSessionHandoff(e => {
			this._logService.trace(`[${sessionId}] Session handoff: sourceType=${e.data.sourceType}, remoteSessionId=${e.data.remoteSessionId ?? '(none)'}`);
		});

		wrapper.onSessionTruncation(e => {
			this._logService.trace(`[${sessionId}] Session truncation: removed ${e.data.tokensRemovedDuringTruncation} tokens, ${e.data.messagesRemovedDuringTruncation} messages`);
		});

		wrapper.onSessionSnapshotRewind(e => {
			this._logService.trace(`[${sessionId}] Snapshot rewind: upTo=${e.data.upToEventId}, eventsRemoved=${e.data.eventsRemoved}`);
		});

		wrapper.onSessionShutdown(e => {
			this._logService.trace(`[${sessionId}] Session shutdown: type=${e.data.shutdownType}, premiumRequests=${e.data.totalPremiumRequests}, apiDuration=${e.data.totalApiDurationMs}ms`);
		});

		wrapper.onSessionUsageInfo(e => {
			this._logService.trace(`[${sessionId}] Usage info: ${e.data.currentTokens}/${e.data.tokenLimit} tokens, ${e.data.messagesLength} messages`);
		});

		wrapper.onSessionCompactionStart(() => {
			this._logService.trace(`[${sessionId}] Compaction started`);
		});

		wrapper.onSessionCompactionComplete(e => {
			this._logService.trace(`[${sessionId}] Compaction complete: success=${e.data.success}, tokensRemoved=${e.data.tokensRemoved ?? '?'}`);
		});

		wrapper.onUserMessage(e => {
			this._logService.trace(`[${sessionId}] User message: ${e.data.content.length} chars, ${e.data.attachments?.length ?? 0} attachments`);
		});

		wrapper.onPendingMessagesModified(() => {
			this._logService.trace(`[${sessionId}] Pending messages modified`);
		});

		wrapper.onTurnStart(e => {
			this._logService.trace(`[${sessionId}] Turn started: ${e.data.turnId}`);
		});

		wrapper.onIntent(e => {
			this._logService.trace(`[${sessionId}] Intent: ${e.data.intent}`);
		});

		wrapper.onReasoning(e => {
			this._logService.trace(`[${sessionId}] Reasoning: ${e.data.content.length} chars`);
		});

		wrapper.onReasoningDelta(e => {
			this._logService.trace(`[${sessionId}] Reasoning delta: ${e.data.deltaContent.length} chars`);
		});

		wrapper.onTurnEnd(e => {
			this._logService.trace(`[${sessionId}] Turn ended: ${e.data.turnId}`);
		});

		wrapper.onUsage(e => {
			this._logService.trace(`[${sessionId}] Usage: model=${e.data.model}, in=${e.data.inputTokens ?? '?'}, out=${e.data.outputTokens ?? '?'}, cacheRead=${e.data.cacheReadTokens ?? '?'}`);
		});

		wrapper.onAbort(e => {
			this._logService.trace(`[${sessionId}] Aborted: ${e.data.reason}`);
		});

		wrapper.onToolUserRequested(e => {
			this._logService.trace(`[${sessionId}] Tool user-requested: ${e.data.toolName} (${e.data.toolCallId})`);
		});

		wrapper.onToolPartialResult(e => {
			this._logService.trace(`[${sessionId}] Tool partial result: ${e.data.toolCallId} (${e.data.partialOutput.length} chars)`);
		});

		wrapper.onToolProgress(e => {
			this._logService.trace(`[${sessionId}] Tool progress: ${e.data.toolCallId} - ${e.data.progressMessage}`);
		});

		wrapper.onSkillInvoked(e => {
			this._logService.trace(`[${sessionId}] Skill invoked: ${e.data.name} (${e.data.path})`);
		});

		wrapper.onSubagentStarted(e => {
			this._logService.trace(`[${sessionId}] Subagent started: ${e.data.agentName} (${e.data.agentDisplayName})`);
		});

		wrapper.onSubagentCompleted(e => {
			this._logService.trace(`[${sessionId}] Subagent completed: ${e.data.agentName}`);
		});

		wrapper.onSubagentFailed(e => {
			this._logService.error(`[${sessionId}] Subagent failed: ${e.data.agentName} - ${e.data.error}`);
		});

		wrapper.onSubagentSelected(e => {
			this._logService.trace(`[${sessionId}] Subagent selected: ${e.data.agentName}`);
		});

		wrapper.onHookStart(e => {
			this._logService.trace(`[${sessionId}] Hook started: ${e.data.hookType} (${e.data.hookInvocationId})`);
		});

		wrapper.onHookEnd(e => {
			this._logService.trace(`[${sessionId}] Hook ended: ${e.data.hookType} (${e.data.hookInvocationId}), success=${e.data.success}`);
		});

		wrapper.onSystemMessage(e => {
			this._logService.trace(`[${sessionId}] System message [${e.data.role}]: ${e.data.content.length} chars`);
		});

		this._sessions.set(sessionId, wrapper);
		return wrapper;
	}

	private async _resumeSession(sessionId: string): Promise<CopilotSessionWrapper> {
		this._logService.info(`[${sessionId}] Session not in memory, resuming...`);
		const client = await this._ensureClient();
		const raw = await client.resumeSession(sessionId);
		return this._trackSession(raw);
	}

	private _mapSessionEvents(sessionId: string, events: readonly SessionEvent[]): IAgentMessageEvent[] {
		const result: IAgentMessageEvent[] = [];
		for (const e of events) {
			if (e.type !== 'assistant.message' && e.type !== 'user.message') {
				continue;
			}
			const d = (e as SessionEventPayload<'assistant.message'>).data;
			result.push({
				sessionId,
				type: 'message',
				role: e.type === 'user.message' ? 'user' : 'assistant',
				messageId: d?.messageId ?? '',
				content: d?.content ?? '',
				toolRequests: d?.toolRequests?.map(tr => ({
					toolCallId: tr.toolCallId,
					name: tr.name,
					arguments: tr.arguments !== undefined ? tryStringify(tr.arguments) : undefined,
					type: tr.type,
				})),
				reasoningOpaque: d?.reasoningOpaque,
				reasoningText: d?.reasoningText,
				encryptedContent: d?.encryptedContent,
				parentToolCallId: d?.parentToolCallId,
			});
		}
		return result;
	}

	override dispose(): void {
		this._client?.stop().catch(() => { /* best-effort */ });
		super.dispose();
	}
}
