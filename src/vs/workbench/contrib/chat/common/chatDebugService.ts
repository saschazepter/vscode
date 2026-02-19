/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';

/**
 * The severity level of a chat debug log event.
 */
export enum ChatDebugLogLevel {
	Trace = 0,
	Info = 1,
	Warning = 2,
	Error = 3
}

/**
 * Common properties shared by all chat debug event types.
 */
export interface IChatDebugEventCommon {
	readonly id?: string;
	readonly sessionId: string;
	readonly created: Date;
	readonly parentEventId?: string;
}

/**
 * A tool call event in the chat debug log.
 */
export interface IChatDebugToolCallEvent extends IChatDebugEventCommon {
	readonly kind: 'toolCall';
	readonly toolName: string;
	readonly toolCallId?: string;
	readonly input?: string;
	readonly output?: string;
	readonly result?: 'success' | 'error';
	readonly durationInMillis?: number;
}

/**
 * A model turn event representing an LLM request/response.
 */
export interface IChatDebugModelTurnEvent extends IChatDebugEventCommon {
	readonly kind: 'modelTurn';
	readonly model?: string;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly totalTokens?: number;
	readonly cost?: number;
	readonly durationInMillis?: number;
}

/**
 * A generic log event for unstructured or miscellaneous messages.
 */
export interface IChatDebugGenericEvent extends IChatDebugEventCommon {
	readonly kind: 'generic';
	readonly name: string;
	readonly details?: string;
	readonly level: ChatDebugLogLevel;
	readonly category?: string;
}

/**
 * A subagent invocation event, representing a spawned sub-agent within a session.
 */
export interface IChatDebugSubagentInvocationEvent extends IChatDebugEventCommon {
	readonly kind: 'subagentInvocation';
	readonly agentName: string;
	readonly description?: string;
	readonly status?: 'running' | 'completed' | 'failed';
	readonly durationInMillis?: number;
	readonly toolCallCount?: number;
	readonly modelTurnCount?: number;
}

/**
 * Union of all internal chat debug event types.
 */
export type IChatDebugEvent = IChatDebugToolCallEvent | IChatDebugModelTurnEvent | IChatDebugGenericEvent | IChatDebugSubagentInvocationEvent;

export const IChatDebugService = createDecorator<IChatDebugService>('chatDebugService');

/**
 * Service for collecting and exposing chat debug events.
 * Internal components can log events,
 * and the debug editor pane can display them.
 */
export interface IChatDebugService extends IDisposable {
	readonly _serviceBrand: undefined;

	/**
	 * Fired when a new event is added.
	 */
	readonly onDidAddEvent: Event<IChatDebugEvent>;

	/**
	 * Log a generic event to the debug service.
	 */
	log(sessionId: string, name: string, details?: string, level?: ChatDebugLogLevel, options?: { id?: string; category?: string; parentEventId?: string }): void;

	/**
	 * Add a typed event to the debug service.
	 */
	addEvent(event: IChatDebugEvent): void;

	/**
	 * Get all events for a specific session.
	 */
	getEvents(sessionId?: string): readonly IChatDebugEvent[];

	/**
	 * Get all session IDs that have logged events.
	 */
	getSessionIds(): readonly string[];

	/**
	 * The currently active session ID for debugging.
	 */
	activeSessionId: string | undefined;

	/**
	 * Optional hint for which view the editor should show next.
	 * Set before opening the editor, then consumed and cleared by the editor.
	 * - 'home': home view
	 * - 'overview': session overview
	 * - 'logs': log event table
	 */
	activeViewHint: 'home' | 'overview' | 'logs' | undefined;

	/**
	 * Clear all logged events.
	 */
	clear(): void;

	/**
	 * Register an external provider that can supply additional debug events.
	 * This is used by the extension API (ChatDebugLogProvider).
	 */
	registerProvider(provider: IChatDebugLogProvider): IDisposable;

	/**
	 * Invoke all registered providers for a given session ID.
	 * Called when the Debug View is opened to fetch events from extensions.
	 */
	invokeProviders(sessionId: string): Promise<void>;

	/**
	 * Resolve the full details of an event by its id.
	 * Delegates to the registered provider's resolveChatDebugLogEvent.
	 */
	resolveEvent(eventId: string): Promise<string | undefined>;
}

/**
 * Provider interface for debug events.
 */
export interface IChatDebugLogProvider {
	provideChatDebugLog(sessionId: string, token: CancellationToken): Promise<IChatDebugEvent[] | undefined>;
	resolveChatDebugLogEvent?(eventId: string, token: CancellationToken): Promise<string | undefined>;
}
