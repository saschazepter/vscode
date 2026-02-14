/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotClient, CopilotSession } from '@github/copilot-sdk';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IAgentCreateSessionConfig, IAgentProgressEvent, IAgentService, IAgentSessionMetadata } from '../common/agentService.js';
import { CopilotSessionWrapper } from './copilotSessionWrapper.js';

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

	async getSessionMessages(sessionId: string): Promise<IAgentProgressEvent[]> {
		const entry = this._sessions.get(sessionId) ?? await this._resumeSession(sessionId).catch(() => undefined);
		if (!entry) {
			return [];
		}

		const events = await entry.session.getMessages();
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

	async disposeSession(sessionId: string): Promise<void> {
		this._sessions.deleteAndDispose(sessionId);
	}

	async ping(msg: string): Promise<string> {
		return `pong: ${msg}`;
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

		wrapper.addDisposable(wrapper.onMessageDelta(e => {
			this._logService.trace(`[${sessionId}] delta: ${e.data.deltaContent.length} chars`);
			this._onDidSessionProgress.fire({ sessionId, type: 'delta', content: e.data.deltaContent });
		}));

		wrapper.addDisposable(wrapper.onMessage(e => {
			this._logService.info(`[${sessionId}] Full message received: ${e.data.content.length} chars`);
			this._onDidSessionProgress.fire({ sessionId, type: 'message', content: e.data.content });
		}));

		wrapper.addDisposable(wrapper.onToolStart(e => {
			this._logService.info(`[${sessionId}] Tool started: ${e.data.toolName}`);
			this._onDidSessionProgress.fire({ sessionId, type: 'tool_start', content: e.data.toolName });
		}));

		wrapper.addDisposable(wrapper.onToolComplete(e => {
			this._logService.info(`[${sessionId}] Tool completed: ${e.data.toolCallId}`);
			this._onDidSessionProgress.fire({ sessionId, type: 'tool_complete', content: e.data.toolCallId });
		}));

		wrapper.addDisposable(wrapper.onIdle(() => {
			this._logService.info(`[${sessionId}] Session idle`);
			this._onDidSessionProgress.fire({ sessionId, type: 'idle' });
		}));

		this._sessions.set(sessionId, wrapper);
		return wrapper;
	}

	private async _resumeSession(sessionId: string): Promise<CopilotSessionWrapper> {
		this._logService.info(`[${sessionId}] Session not in memory, resuming...`);
		const client = await this._ensureClient();
		const raw = await client.resumeSession(sessionId);
		return this._trackSession(raw);
	}

	override dispose(): void {
		this._client?.stop().catch(() => { /* best-effort */ });
		super.dispose();
	}
}
