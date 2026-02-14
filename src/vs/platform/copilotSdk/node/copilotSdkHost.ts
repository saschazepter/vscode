/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { Server as UtilityProcessServer } from '../../../base/parts/ipc/node/ipc.mp.js';
import {
	CopilotSdkChannel,
	type ICopilotAssistantMessage,
	type ICopilotModelInfo,
	type ICopilotResumeSessionConfig,
	type ICopilotSdkService,
	type ICopilotSendOptions,
	type ICopilotSessionConfig,
	type ICopilotSessionEvent,
	type ICopilotSessionLifecycleEvent,
	type ICopilotSessionMetadata,
} from '../common/copilotSdkService.js';
// eslint-disable-next-line local/code-import-patterns
import type { CopilotClient, CopilotSession, SessionEvent, SessionLifecycleEvent } from '@github/copilot-sdk';

/**
 * The Copilot SDK host runs in a utility process and wraps the
 * `@github/copilot-sdk` `CopilotClient`. It implements `ICopilotSdkService`
 * so that `ProxyChannel.fromService()` can auto-generate an IPC channel
 * from it -- all methods become RPC calls and all `onFoo` events are
 * forwarded over the channel automatically.
 */
class CopilotSdkHost extends Disposable implements ICopilotSdkService {
	declare readonly _serviceBrand: undefined;

	private _client: CopilotClient | undefined;
	private readonly _sessions = new Map<string, CopilotSession>();
	private _githubToken: string | undefined;

	// --- Events ---
	private readonly _onSessionEvent = this._register(new Emitter<ICopilotSessionEvent>());
	readonly onSessionEvent: Event<ICopilotSessionEvent> = this._onSessionEvent.event;

	private readonly _onSessionLifecycle = this._register(new Emitter<ICopilotSessionLifecycleEvent>());
	readonly onSessionLifecycle: Event<ICopilotSessionLifecycleEvent> = this._onSessionLifecycle.event;

	private readonly _onProcessOutput = this._register(new Emitter<{ stream: 'stdout' | 'stderr'; data: string }>());
	readonly onProcessOutput: Event<{ stream: 'stdout' | 'stderr'; data: string }> = this._onProcessOutput.event;

	// --- Lifecycle ---

	async start(): Promise<void> {
		if (this._client) {
			return;
		}

		const sdk = await import('@github/copilot-sdk');

		// Resolve the native CLI binary path. The @github/copilot package includes
		// platform-specific native binaries via optional deps (@github/copilot-${platform}-${arch}).
		// Using the native binary avoids the Electron helper app crashes that occur
		// when running the JS entry (index.js) inside a VS Code utility process.
		let cliPath: string | undefined;
		try {
			const { fileURLToPath } = await import('node:url');
			const pkgName = `@github/copilot-${process.platform}-${process.arch}`;
			cliPath = fileURLToPath(import.meta.resolve(pkgName));
			process.stderr.write(`[SDK-DEBUG] Resolved native CLI: ${cliPath}\n`);
		} catch (e) {
			process.stderr.write(`[SDK-DEBUG] Native CLI not found: ${e instanceof Error ? e.message : String(e)}\n`);
		}

		// Build a clean environment for the CLI. The utility process inherits
		// many VS Code/Electron-specific env vars that can interfere with the
		// CLI (which is itself an Electron app). Strip problematic vars.
		const cliEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value === undefined) {
				continue;
			}
			// Skip VS Code internal vars
			if (key.startsWith('VSCODE_')) {
				continue;
			}
			// Skip Electron vars that would confuse the CLI's own Electron
			if (key.startsWith('ELECTRON_')) {
				continue;
			}
			cliEnv[key] = value;
		}

		this._client = new sdk.CopilotClient({
			autoStart: true,
			autoRestart: true,
			useStdio: true,
			...(cliPath ? { cliPath } : {}),
			env: cliEnv,
			...(this._githubToken ? { githubToken: this._githubToken } : {}),
		});

		// Log state transitions for debugging the "Connection is disposed" issue
		process.stderr.write(`[SDK-DEBUG] Starting client with cliPath=${cliPath ?? 'default'}\n`);
		await this._client.start();
		process.stderr.write(`[SDK-DEBUG] Client started, state=${this._client.getState()}\n`);

		// Log SDK client state changes
		const state = this._client.getState();
		this._onProcessOutput.fire({ stream: 'stderr', data: `[SDK] Client started, state: ${state}` });

		// Intercept stderr to capture CLI subprocess output and forward as events.
		// The SDK writes CLI stderr lines to process.stderr via its internal
		// `[CLI subprocess]` handler.
		const originalStderrWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (chunk: string | Uint8Array, ...args: unknown[]): boolean => {
			const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
			if (text.trim()) {
				this._onProcessOutput.fire({ stream: 'stderr', data: text.trimEnd() });
			}
			return originalStderrWrite(chunk, ...args as [BufferEncoding?, ((err?: Error | null) => void)?]);
		};

		// Forward client lifecycle events
		this._client.on('session.created', (event: SessionLifecycleEvent) => {
			this._onSessionLifecycle.fire({ type: 'session.created', sessionId: event.sessionId });
		});
		this._client.on('session.deleted', (event: SessionLifecycleEvent) => {
			this._onSessionLifecycle.fire({ type: 'session.deleted', sessionId: event.sessionId });
		});
		this._client.on('session.updated', (event: SessionLifecycleEvent) => {
			this._onSessionLifecycle.fire({ type: 'session.updated', sessionId: event.sessionId });
		});
	}

	async stop(): Promise<void> {
		if (!this._client) {
			return;
		}

		for (const [, session] of this._sessions) {
			try { await session.destroy(); } catch { /* best-effort */ }
		}
		this._sessions.clear();

		await this._client.stop();
		this._client = undefined;
	}

	// --- Sessions ---

	async createSession(config: ICopilotSessionConfig): Promise<string> {
		const client = await this._ensureClient();
		this._onProcessOutput.fire({ stream: 'stderr', data: `[SDK] createSession called, client state: ${client.getState()}` });
		const session = await client.createSession({
			model: config.model,
			reasoningEffort: config.reasoningEffort,
			streaming: config.streaming ?? true,
			systemMessage: config.systemMessage,
			workingDirectory: config.workingDirectory,
		});
		this._onProcessOutput.fire({ stream: 'stderr', data: `[SDK] session created: ${session.sessionId}, client state: ${client.getState()}` });

		this._sessions.set(session.sessionId, session);
		this._attachSessionEvents(session);

		return session.sessionId;
	}

	async resumeSession(sessionId: string, config?: ICopilotResumeSessionConfig): Promise<void> {
		const client = await this._ensureClient();
		const session = await client.resumeSession(sessionId, {
			streaming: config?.streaming ?? true,
		});

		this._sessions.set(session.sessionId, session);
		this._attachSessionEvents(session);
	}

	async destroySession(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (session) {
			await session.destroy();
			this._sessions.delete(sessionId);
		}
	}

	async listSessions(): Promise<ICopilotSessionMetadata[]> {
		const client = await this._ensureClient();
		const sessions = await client.listSessions();
		return sessions.map((s: { sessionId: string; summary?: string; startTime?: Date; modifiedTime?: Date; isRemote?: boolean; context?: { cwd?: string; repository?: string; branch?: string } }) => ({
			sessionId: s.sessionId,
			summary: s.summary,
			startTime: s.startTime?.toISOString(),
			modifiedTime: s.modifiedTime?.toISOString(),
			isRemote: s.isRemote,
			workspacePath: s.context?.cwd,
			repository: s.context?.repository,
			branch: s.context?.branch,
		}));
	}

	async deleteSession(sessionId: string): Promise<void> {
		const client = await this._ensureClient();
		this._sessions.delete(sessionId);
		await client.deleteSession(sessionId);
	}

	// --- Messaging ---

	async send(sessionId: string, prompt: string, options?: ICopilotSendOptions): Promise<string> {
		const session = this._getSession(sessionId);
		process.stderr.write(`[SDK-DEBUG] send called, sessionId=${sessionId.substring(0, 8)}, clientState=${this._client?.getState()}\n`);
		try {
			const result = await session.send({
				prompt,
				attachments: options?.attachments?.map(a => ({ type: a.type as 'file', path: a.path, displayName: a.displayName })),
				mode: options?.mode,
			});
			process.stderr.write(`[SDK-DEBUG] send completed, result=${result}\n`);
			return result;
		} catch (err) {
			process.stderr.write(`[SDK-DEBUG] send FAILED: ${err instanceof Error ? `${err.message}\n${err.stack}` : String(err)}\n`);
			throw err;
		}
	}

	async sendAndWait(sessionId: string, prompt: string, options?: ICopilotSendOptions): Promise<ICopilotAssistantMessage | undefined> {
		const session = this._getSession(sessionId);
		const result = await session.sendAndWait({
			prompt,
			attachments: options?.attachments?.map(a => ({ type: a.type as 'file', path: a.path, displayName: a.displayName })),
			mode: options?.mode,
		});
		if (!result) {
			return undefined;
		}
		return { content: result.data.content };
	}

	async abort(sessionId: string): Promise<void> {
		const session = this._getSession(sessionId);
		await session.abort();
	}

	async getMessages(sessionId: string): Promise<ICopilotSessionEvent[]> {
		const session = this._getSession(sessionId);
		const events = await session.getMessages();
		return events.map((e: SessionEvent) => ({
			sessionId,
			type: e.type as ICopilotSessionEvent['type'],
			data: (e as { data?: Record<string, unknown> }).data ?? {},
		}));
	}

	// --- Models ---

	async listModels(): Promise<ICopilotModelInfo[]> {
		const client = await this._ensureClient();
		const models = await client.listModels();
		return models.map((m: { id: string; name?: string }) => ({
			id: m.id,
			name: m.name,
		}));
	}

	// --- Authentication ---

	async setGitHubToken(token: string): Promise<void> {
		this._githubToken = token;
	}

	// --- Private helpers ---

	private async _ensureClient(): Promise<CopilotClient> {
		if (!this._client) {
			await this.start();
		}
		return this._client!;
	}

	private _getSession(sessionId: string): CopilotSession {
		const session = this._sessions.get(sessionId);
		if (!session) {
			throw new Error(`No active session with ID: ${sessionId}`);
		}
		return session;
	}

	private _attachSessionEvents(session: CopilotSession): void {
		const sessionId = session.sessionId;

		session.on((event: SessionEvent) => {
			this._onSessionEvent.fire({
				sessionId,
				type: event.type as ICopilotSessionEvent['type'],
				data: (event as { data?: Record<string, unknown> }).data ?? {},
			});
		});
	}
}

// --- Entry point ---
// Only start when running as an Electron utility process (not when imported by the main process).
import { isUtilityProcess } from '../../../base/parts/sandbox/node/electronTypes.js';
if (isUtilityProcess(process)) {
	const disposables = new DisposableStore();
	const host = new CopilotSdkHost();
	disposables.add(host);
	const channel = ProxyChannel.fromService(host, disposables);
	const server = new UtilityProcessServer();
	server.registerChannel(CopilotSdkChannel, channel);

	process.once('exit', () => {
		host.stop().catch(() => { /* best-effort cleanup */ });
		disposables.dispose();
	});
}
