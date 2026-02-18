/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ChatDebugLogLevel, IChatDebugLogEvent, IChatDebugLogProvider, IChatDebugService } from './chatDebugService.js';

export class ChatDebugServiceImpl extends Disposable implements IChatDebugService {
	declare readonly _serviceBrand: undefined;

	private readonly _events: IChatDebugLogEvent[] = [];
	private readonly _onDidAddEvent = this._register(new Emitter<IChatDebugLogEvent>());
	readonly onDidAddEvent: Event<IChatDebugLogEvent> = this._onDidAddEvent.event;

	private readonly _providers = new Set<IChatDebugLogProvider>();
	private _currentInvocationCts: CancellationTokenSource | undefined;

	activeSessionId: string | undefined;

	log(sessionId: string, name: string, details?: string, level: ChatDebugLogLevel = ChatDebugLogLevel.Info, options?: { id?: string; category?: string; parentEventId?: string }): void {
		const event: IChatDebugLogEvent = {
			id: options?.id,
			sessionId,
			created: new Date(),
			name,
			details,
			level,
			category: options?.category,
			parentEventId: options?.parentEventId,
		};
		this._events.push(event);
		this._onDidAddEvent.fire(event);
	}

	getEvents(sessionId?: string): readonly IChatDebugLogEvent[] {
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
		console.log(`[ChatDebugService] registerProvider called, total providers: ${this._providers.size + 1}`);
		this._providers.add(provider);
		return toDisposable(() => {
			console.log(`[ChatDebugService] provider unregistered, total providers: ${this._providers.size - 1}`);
			this._providers.delete(provider);
		});
	}

	async invokeProviders(sessionId: string): Promise<void> {
		console.log(`[ChatDebugService] invokeProviders called for session "${sessionId}", ${this._providers.size} provider(s) registered`);

		// Cancel previous invocation so extension-side listeners are cleaned up
		this._currentInvocationCts?.cancel();
		this._currentInvocationCts?.dispose();

		const cts = new CancellationTokenSource();
		this._currentInvocationCts = cts;

		try {
			const promises = [...this._providers].map(async (provider, i) => {
				console.log(`[ChatDebugService] calling provider ${i} for session "${sessionId}"`);
				try {
					const events = await provider.provideChatDebugLog(sessionId, cts.token);
					console.log(`[ChatDebugService] provider ${i} returned ${events?.length ?? 0} events`);
					if (events) {
						for (const event of events) {
							this.log(event.sessionId ?? sessionId, event.name, event.details, event.level, {
								id: event.id,
								category: event.category,
								parentEventId: event.parentEventId,
							});
						}
					}
				} catch (err) {
					console.error(`[ChatDebugService] provider ${i} threw:`, err);
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
