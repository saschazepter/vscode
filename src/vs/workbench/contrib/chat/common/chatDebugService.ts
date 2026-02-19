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
 * A single event in the chat debug log.
 */
export interface IChatDebugLogEvent {
	/**
	 * A unique identifier for this event.
	 */
	readonly id?: string;

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
	 * Optional details of the event.
	 */
	readonly details?: string;

	/**
	 * The severity level of the event.
	 */
	readonly level: ChatDebugLogLevel;

	/**
	 * The category classifying the kind of event.
	 */
	readonly category?: string;

	/**
	 * The id of a parent event, used to build a hierarchical tree.
	 */
	readonly parentEventId?: string;
}

/**
 * A single metric displayed in the session overview.
 */
export interface IChatDebugSessionOverviewMetric {
	readonly label: string;
	readonly value: string;
}

/**
 * An action button displayed in the session overview.
 */
export interface IChatDebugSessionOverviewAction {
	readonly group: string;
	readonly label: string;
	readonly commandId?: string;
	readonly commandArgs?: unknown[];
}

/**
 * Overview information for a chat debug session.
 */
export interface IChatDebugSessionOverview {
	readonly sessionTitle?: string;
	readonly metrics?: IChatDebugSessionOverviewMetric[];
	readonly actions?: IChatDebugSessionOverviewAction[];
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
	log(sessionId: string, name: string, details?: string, level?: ChatDebugLogLevel, options?: { id?: string; category?: string; parentEventId?: string }): void;

	/**
	 * Get all events for a specific session.
	 */
	getEvents(sessionId?: string): readonly IChatDebugLogEvent[];

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
	 * Register an external provider that can supply additional debug log events.
	 * This is used by the extension API (ChatDebugLogProvider).
	 */
	registerProvider(provider: IChatDebugLogProvider): IDisposable;

	/**
	 * Register an external provider that supplies session overview information.
	 * This is used by the extension API (ChatDebugSessionOverviewProvider).
	 */
	registerOverviewProvider(provider: IChatDebugSessionOverviewProvider): IDisposable;

	/**
	 * Invoke all registered providers for a given session ID.
	 * Called when the Debug View is opened to fetch events from extensions.
	 */
	invokeProviders(sessionId: string): Promise<void>;

	/**
	 * Resolve the full details of a log event by its id.
	 * Delegates to the registered provider's resolveChatDebugLogEvent.
	 */
	resolveEvent(eventId: string): Promise<string | undefined>;

	/**
	 * Get overview information for a session from registered overview providers.
	 */
	getOverview(sessionId: string): Promise<IChatDebugSessionOverview | undefined>;
}

/**
 * Provider interface for debug log events.
 */
export interface IChatDebugLogProvider {
	provideChatDebugLog(sessionId: string, token: CancellationToken): Promise<IChatDebugLogEvent[] | undefined>;
	resolveChatDebugLogEvent?(eventId: string, token: CancellationToken): Promise<string | undefined>;
}

/**
 * Provider interface for session overview information.
 */
export interface IChatDebugSessionOverviewProvider {
	provideChatDebugSessionOverview(sessionId: string, token: CancellationToken): Promise<IChatDebugSessionOverview | undefined>;
}
