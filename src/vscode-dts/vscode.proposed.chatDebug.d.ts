/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// version: 2

declare module 'vscode' {

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
	export interface ChatDebugLogEvent {
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

	/**
	 * A provider that supplies debug log events for a chat session.
	 */
	export interface ChatDebugLogProvider {
		/**
		 * Called when the debug view is opened for a chat session.
		 * The provider should return initial log events and can use
		 * the progress callback to stream additional events over time.
		 *
		 * @param sessionId The ID of the chat session being debugged.
		 * @param progress A progress callback to stream log events.
		 * @param token A cancellation token.
		 * @returns Initial log events, if any.
		 */
		provideChatDebugLog(
			sessionId: string,
			progress: Progress<ChatDebugLogEvent>,
			token: CancellationToken
		): ProviderResult<ChatDebugLogEvent[]>;
	}

	export namespace chat {
		/**
		 * Register a provider that supplies debug log events for chat sessions.
		 * Only one provider can be registered at a time.
		 *
		 * @param provider The chat debug log provider.
		 * @returns A disposable that unregisters the provider.
		 */
		export function registerChatDebugLogProvider(provider: ChatDebugLogProvider): Disposable;
	}
}
