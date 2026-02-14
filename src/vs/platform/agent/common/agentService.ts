/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const enum AgentHostIpcChannels {
	/** Channel for the agent host service on the main-process side */
	AgentHost = 'agentHost',
	/** Channel for log forwarding from the agent host process */
	Logger = 'agentHostLogger',
}

// ---- IPC data types (serializable across MessagePort) -----------------------

export interface IAgentSessionMetadata {
	readonly sessionId: string;
	readonly startTime: number;
	readonly modifiedTime: number;
	readonly summary?: string;
}

export interface IAgentCreateSessionConfig {
	readonly model?: string;
	readonly sessionId?: string;
}

export interface IAgentProgressEvent {
	readonly sessionId: string;
	readonly type: 'delta' | 'message' | 'idle' | 'tool_start' | 'tool_complete';
	readonly content?: string;
	readonly role?: 'user' | 'assistant';
}

// ---- Service interfaces -----------------------------------------------------

export const IAgentService = createDecorator<IAgentService>('agentService');

/**
 * Service contract for communicating with the agent host process. Methods here
 * are proxied across MessagePort via `ProxyChannel`.
 */
export interface IAgentService {
	readonly _serviceBrand: undefined;

	/** Fires when the agent host streams progress for a session. */
	readonly onDidSessionProgress: Event<IAgentProgressEvent>;

	/** Set the GitHub auth token used by the Copilot SDK. */
	setAuthToken(token: string): Promise<void>;

	/** List all available sessions from the Copilot CLI. */
	listSessions(): Promise<IAgentSessionMetadata[]>;

	/** Create a new Copilot SDK session. Returns the session ID. */
	createSession(config?: IAgentCreateSessionConfig): Promise<string>;

	/** Send a user message into an existing session. */
	sendMessage(sessionId: string, prompt: string): Promise<void>;

	/** Retrieve all session events/messages for reconstruction. */
	getSessionMessages(sessionId: string): Promise<IAgentProgressEvent[]>;

	/** Dispose a session and free its resources. */
	disposeSession(sessionId: string): Promise<void>;

	/** Simple connectivity check. */
	ping(msg: string): Promise<string>;

	/** Gracefully shut down all sessions and the underlying client. */
	shutdown(): Promise<void>;
}

export const IAgentHostService = createDecorator<IAgentHostService>('agentHostService');

/**
 * The local wrapper around the agent host process (manages lifecycle, restart,
 * exposes the proxied service). Consumed by the main process and workbench.
 */
export interface IAgentHostService extends IAgentService {

	readonly onAgentHostExit: Event<number>;
	readonly onAgentHostStart: Event<void>;

	restartAgentHost(): Promise<void>;
}
