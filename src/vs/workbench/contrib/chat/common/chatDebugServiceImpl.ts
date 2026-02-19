/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ChatDebugLogLevel, IChatDebugEvent, IChatDebugLogProvider, IChatDebugService } from './chatDebugService.js';

export class ChatDebugServiceImpl extends Disposable implements IChatDebugService {
	declare readonly _serviceBrand: undefined;

	private readonly _events: IChatDebugEvent[] = [];
	private readonly _onDidAddEvent = this._register(new Emitter<IChatDebugEvent>());
	readonly onDidAddEvent: Event<IChatDebugEvent> = this._onDidAddEvent.event;

	private readonly _providers = new Set<IChatDebugLogProvider>();
	private _currentInvocationCts: CancellationTokenSource | undefined;

	activeSessionId: string | undefined;
	activeViewHint: 'home' | 'overview' | 'logs' | undefined;

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
		console.log('[chatDebug][service.addEvent] Adding event:', { kind: event.kind, sessionId: event.sessionId, id: event.id });
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

	registerProvider(provider: IChatDebugLogProvider): IDisposable {
		this._providers.add(provider);
		return toDisposable(() => {
			this._providers.delete(provider);
		});
	}

	async invokeProviders(sessionId: string): Promise<void> {
		console.log('[chatDebug][service.invokeProviders] Called for sessionId:', sessionId, 'providers:', this._providers.size);
		// Cancel previous invocation so extension-side listeners are cleaned up
		this._currentInvocationCts?.cancel();
		this._currentInvocationCts?.dispose();

		const cts = new CancellationTokenSource();
		this._currentInvocationCts = cts;

		try {
			const promises = [...this._providers].map(async (provider) => {
				try {
					const events = await provider.provideChatDebugLog(sessionId, cts.token);
					console.log('[chatDebug][service.invokeProviders] Provider returned:', events?.length ?? 'undefined', 'events', events?.map(e => ({ kind: e.kind, id: e.id })));
					if (events) {
						for (const event of events) {
							console.log('[chatDebug][service.invokeProviders] Adding event from provider:', { kind: event.kind, id: event.id, sessionId: event.sessionId });
							this.addEvent({
								...event,
								sessionId: event.sessionId ?? sessionId,
							});
						}
					}
				} catch (err) {
					console.error('[chatDebug][service.invokeProviders] Provider error:', err);
				}
			});
			await Promise.allSettled(promises);
		} catch {
			// best effort
		}
		// Note: do NOT dispose the CTS here - the token is used by the
		// extension-side progress pipeline which stays alive for streaming.
		// It will be cancelled+disposed when the next invokeProviders call
		// starts or when the service is disposed.
	}

	async resolveEvent(eventId: string): Promise<string | undefined> {
		const cts = new CancellationTokenSource();
		try {
			for (const provider of this._providers) {
				if (provider.resolveChatDebugLogEvent) {
					const resolved = await provider.resolveChatDebugLogEvent(eventId, cts.token);
					if (resolved !== undefined) {
						return resolved;
					}
				}
			}
			return undefined;
		} finally {
			cts.dispose();
		}
	}

	override dispose(): void {
		this._currentInvocationCts?.cancel();
		this._currentInvocationCts?.dispose();
		this._currentInvocationCts = undefined;
		super.dispose();
	}
}
