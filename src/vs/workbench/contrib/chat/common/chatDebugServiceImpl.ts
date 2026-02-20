/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ChatDebugLogLevel, IChatDebugEvent, IChatDebugLogProvider, IChatDebugResolvedEventContent, IChatDebugService } from './chatDebugService.js';

export class ChatDebugServiceImpl extends Disposable implements IChatDebugService {
	declare readonly _serviceBrand: undefined;

	private static readonly MAX_EVENTS = 10_000;

	private readonly _events: IChatDebugEvent[] = [];
	private readonly _onDidAddEvent = this._register(new Emitter<IChatDebugEvent>());
	readonly onDidAddEvent: Event<IChatDebugEvent> = this._onDidAddEvent.event;

	private readonly _providers = new Set<IChatDebugLogProvider>();
	private readonly _invocationCts = new Map<string, CancellationTokenSource>();

	activeSessionId: string | undefined;

	log(sessionId: string, name: string, details?: string, level: ChatDebugLogLevel = ChatDebugLogLevel.Info, options?: { id?: string; category?: string; parentEventId?: string }): void {
		this.addEvent({
			kind: 'generic',
			id: options?.id,
			sessionId,
			created: new Date(),
			name,
			details,
			level,
			category: options?.category,
			parentEventId: options?.parentEventId,
		});
	}

	addEvent(event: IChatDebugEvent): void {
		if (this._events.length >= ChatDebugServiceImpl.MAX_EVENTS) {
			this._events.splice(0, this._events.length - ChatDebugServiceImpl.MAX_EVENTS + 1);
		}
		this._events.push(event);
		this._onDidAddEvent.fire(event);
	}

	getEvents(sessionId?: string): readonly IChatDebugEvent[] {
		if (sessionId) {
			return this._events.filter(e => e.sessionId === sessionId);
		}
		return this._events;
	}

	getSessionIds(): readonly string[] {
		return [...new Set(this._events.map(e => e.sessionId).filter(id => !!id))];
	}

	clear(): void {
		this._events.length = 0;
	}

	clearSession(sessionId: string): void {
		for (let i = this._events.length - 1; i >= 0; i--) {
			if (this._events[i].sessionId === sessionId) {
				this._events.splice(i, 1);
			}
		}
	}

	registerProvider(provider: IChatDebugLogProvider): IDisposable {
		this._providers.add(provider);

		// Invoke the new provider for all sessions that already have active
		// pipelines. This handles the case where invokeProviders() was called
		// before this provider was registered (e.g. extension activated late).
		for (const [sessionId, cts] of this._invocationCts) {
			if (!cts.token.isCancellationRequested) {
				this._invokeProvider(provider, sessionId, cts.token);
			}
		}

		return toDisposable(() => {
			this._providers.delete(provider);
		});
	}

	async invokeProviders(sessionId: string): Promise<void> {
		// Cancel only the previous invocation for THIS session, not others.
		// Each session has its own pipeline so events from multiple sessions
		// can be streamed concurrently.
		const existingCts = this._invocationCts.get(sessionId);
		if (existingCts) {
			existingCts.cancel();
			existingCts.dispose();
		}

		const cts = new CancellationTokenSource();
		this._invocationCts.set(sessionId, cts);

		try {
			const promises = [...this._providers].map(provider =>
				this._invokeProvider(provider, sessionId, cts.token)
			);
			await Promise.allSettled(promises);
		} catch {
			// best effort
		}
		// Note: do NOT dispose the CTS here - the token is used by the
		// extension-side progress pipeline which stays alive for streaming.
		// It will be cancelled+disposed when re-invoking the same session
		// or when the service is disposed.
	}

	private async _invokeProvider(provider: IChatDebugLogProvider, sessionId: string, token: CancellationToken): Promise<void> {
		try {
			const events = await provider.provideChatDebugLog(sessionId, token);
			if (events) {
				for (const event of events) {
					this.addEvent({
						...event,
						sessionId: event.sessionId ?? sessionId,
					});
				}
			}
		} catch {
			// best effort
		}
	}

	async resolveEvent(eventId: string): Promise<IChatDebugResolvedEventContent | undefined> {
		for (const provider of this._providers) {
			if (provider.resolveChatDebugLogEvent) {
				const resolved = await provider.resolveChatDebugLogEvent(eventId, CancellationToken.None);
				if (resolved !== undefined) {
					return resolved;
				}
			}
		}
		return undefined;
	}

	override dispose(): void {
		for (const cts of this._invocationCts.values()) {
			cts.cancel();
			cts.dispose();
		}
		this._invocationCts.clear();
		super.dispose();
	}
}
