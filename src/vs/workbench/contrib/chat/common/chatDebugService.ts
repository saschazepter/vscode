/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

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
 * A single event in the chat debug log.
 */
export interface IChatDebugLogEvent {
	/**
	 * The session ID this event belongs to.
	 */
	readonly sessionId: string;

	/**
	 * The timestamp when the event was created.
	 */
	readonly created: Date;

	/**
	 * A short name describing the event (e.g., "Resolved skills (start)").
	 */
	readonly name: string;

	/**
	 * Optional contents or details of the event.
	 */
	readonly contents?: string;

	/**
	 * The severity level of the event.
	 */
	readonly level: ChatDebugLogLevel;
}

export const IChatDebugService = createDecorator<IChatDebugService>('chatDebugService');

/**
 * Service for collecting and exposing chat debug log events.
 * Internal components (e.g. PromptsService) can log events,
 * and the debug editor pane can display them.
 */
export interface IChatDebugService extends IDisposable {
	readonly _serviceBrand: undefined;

	/**
	 * Fired when a new log event is added.
	 */
	readonly onDidAddEvent: Event<IChatDebugLogEvent>;

	/**
	 * Log an event to the debug service.
	 */
	log(sessionId: string, name: string, contents?: string, level?: ChatDebugLogLevel): void;

	/**
	 * Get all events for a specific session.
	 */
	getEvents(sessionId?: string): readonly IChatDebugLogEvent[];

	/**
	 * The currently active session ID for debugging.
	 */
	activeSessionId: string | undefined;

	/**
	 * Clear all logged events.
	 */
	clear(): void;

	/**
	 * Register an external provider that can supply additional debug log events.
	 * This is used by the extension API (ChatDebugLogProvider).
	 */
	registerProvider(provider: IChatDebugLogProvider): IDisposable;

	/**
	 * Invoke all registered providers for a given session ID.
	 * Called when the Debug View is opened to fetch events from extensions.
	 */
	invokeProviders(sessionId: string): Promise<void>;
}

import { CancellationToken } from '../../../../base/common/cancellation.js';

/**
 * Provider interface matching the extension API shape.
 */
export interface IChatDebugLogProvider {
	provideChatDebugLog(sessionId: string, token: CancellationToken): Promise<IChatDebugLogEvent[] | undefined>;
}
