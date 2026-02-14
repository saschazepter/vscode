/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';

// #region Service Identifiers

export const ICopilotSdkService = createDecorator<ICopilotSdkService>('copilotSdkService');

/**
 * Main process service identifier. The main process implementation manages
 * the utility process lifecycle and proxies the channel.
 */
export const ICopilotSdkMainService = createDecorator<ICopilotSdkMainService>('copilotSdkMainService');

/**
 * IPC channel name used to register the Copilot SDK service.
 * Defined in the common layer so both main and renderer can reference it
 * without importing the utility process host module.
 */
export const CopilotSdkChannel = 'copilotSdk';

// #endregion

// #region Session Types

export interface ICopilotSessionConfig {
	readonly model?: string;
	readonly reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
	readonly streaming?: boolean;
	readonly systemMessage?: { readonly content: string; readonly mode?: 'append' | 'replace' };
	readonly workingDirectory?: string;
}

export interface ICopilotResumeSessionConfig {
	readonly streaming?: boolean;
}

export interface ICopilotSendOptions {
	readonly attachments?: readonly ICopilotAttachment[];
	readonly mode?: 'enqueue' | 'immediate';
}

export interface ICopilotAttachment {
	readonly type: 'file';
	readonly path: string;
	readonly displayName?: string;
}

// #endregion

// #region Session Metadata

export interface ICopilotSessionMetadata {
	readonly sessionId: string;
	readonly summary?: string;
	readonly startTime?: string;
	readonly modifiedTime?: string;
	readonly isRemote?: boolean;
	readonly workspacePath?: string;
	readonly repository?: string;
	readonly branch?: string;
}

// #endregion

// #region Events

/**
 * Event types emitted by the Copilot SDK session.
 *
 * These map directly to the SDK's event types:
 * - `user.message` -- user prompt added
 * - `assistant.message` -- complete assistant response
 * - `assistant.message_delta` -- streaming response chunk
 * - `assistant.reasoning` -- complete reasoning content
 * - `assistant.reasoning_delta` -- streaming reasoning chunk
 * - `tool.execution_start` -- tool call started
 * - `tool.execution_complete` -- tool call finished
 * - `session.idle` -- session finished processing
 * - `session.compaction_start` -- context compaction started
 * - `session.compaction_complete` -- context compaction finished
 */
export type CopilotSessionEventType =
	| 'user.message'
	| 'assistant.message'
	| 'assistant.message_delta'
	| 'assistant.reasoning'
	| 'assistant.reasoning_delta'
	| 'tool.execution_start'
	| 'tool.execution_complete'
	| 'session.idle'
	| 'session.compaction_start'
	| 'session.compaction_complete';

export interface ICopilotSessionEvent {
	readonly sessionId: string;
	readonly type: CopilotSessionEventType;
	/** Event payload. Shape varies by type -- matches the SDK's event.data. */
	readonly data: ICopilotSessionEventData;
}

export interface ICopilotSessionEventData {
	/** For `assistant.message`: the complete content. */
	readonly content?: string;
	/** For `assistant.message_delta`: the incremental content chunk. */
	readonly deltaContent?: string;
	/** For `tool.execution_start` / `tool.execution_complete`: the tool name. */
	readonly toolName?: string;
	/** Generic data passthrough for fields not explicitly typed. */
	readonly [key: string]: unknown;
}

/**
 * Session lifecycle events fired by the SDK client (not per-session).
 */
export type CopilotSessionLifecycleType =
	| 'session.created'
	| 'session.deleted'
	| 'session.updated';

export interface ICopilotSessionLifecycleEvent {
	readonly type: CopilotSessionLifecycleType;
	readonly sessionId: string;
}

// #endregion

// #region Model Info

export interface ICopilotModelInfo {
	readonly id: string;
	readonly name?: string;
}

// #endregion

// #region Assistant Message

export interface ICopilotAssistantMessage {
	readonly content: string;
}

export interface ICopilotProcessOutput {
	readonly stream: 'stdout' | 'stderr';
	readonly data: string;
}

// #endregion

// #region Service Interface

export interface ICopilotSdkService {
	readonly _serviceBrand: undefined;

	// --- Lifecycle ---

	/**
	 * Start the SDK client. Spawns the Copilot CLI if not already running.
	 * Called automatically on first use if the utility process is alive.
	 */
	start(): Promise<void>;

	/**
	 * Stop the SDK client and the underlying CLI process.
	 */
	stop(): Promise<void>;

	// --- Sessions ---

	/** Create a new session. Returns the session ID. */
	createSession(config: ICopilotSessionConfig): Promise<string>;

	/** Resume an existing session by ID. */
	resumeSession(sessionId: string, config?: ICopilotResumeSessionConfig): Promise<void>;

	/** Destroy a session (free resources, but don't delete from disk). */
	destroySession(sessionId: string): Promise<void>;

	/** List all available sessions. */
	listSessions(): Promise<ICopilotSessionMetadata[]>;

	/** Delete a session and its data from disk. */
	deleteSession(sessionId: string): Promise<void>;

	// --- Messaging ---

	/** Send a message to a session. Returns the message ID. */
	send(sessionId: string, prompt: string, options?: ICopilotSendOptions): Promise<string>;

	/** Send a message and wait until the session is idle. */
	sendAndWait(sessionId: string, prompt: string, options?: ICopilotSendOptions): Promise<ICopilotAssistantMessage | undefined>;

	/** Abort the active response in a session. */
	abort(sessionId: string): Promise<void>;

	/** Get all events/messages from a session. */
	getMessages(sessionId: string): Promise<ICopilotSessionEvent[]>;

	// --- Events ---

	/**
	 * Fires for all session events (streaming deltas, tool calls, idle, etc.).
	 * Multiplexed by sessionId -- consumers filter by the session they care about.
	 */
	readonly onSessionEvent: Event<ICopilotSessionEvent>;

	/**
	 * Fires for session lifecycle changes (created, deleted, updated).
	 */
	readonly onSessionLifecycle: Event<ICopilotSessionLifecycleEvent>;

	/**
	 * Fires for raw CLI process output (stdout/stderr from the utility process).
	 * Used for debugging -- shows the Copilot CLI's raw output.
	 */
	readonly onProcessOutput: Event<ICopilotProcessOutput>;

	// --- Models ---

	/** List available models. */
	listModels(): Promise<ICopilotModelInfo[]>;

	// --- Authentication ---

	/** Set the GitHub token used by the SDK for authentication. */
	setGitHubToken(token: string): Promise<void>;
}

// #endregion

// #region Main Process Service Interface

/**
 * Main process service that manages the Copilot SDK utility process.
 * Registered as a DI service in the main process and exposed via
 * `ProxyChannel.fromService()` for the renderer to consume.
 */
export interface ICopilotSdkMainService {
	readonly _serviceBrand: undefined;

	/**
	 * Get the IServerChannel for registering on the Electron IPC server.
	 * The channel lazily spawns the utility process on first use.
	 */
	getServerChannel(): IServerChannel<string>;
}

// #endregion
