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

	activeSessionId: string | undefined;

	log(sessionId: string, name: string, contents?: string, level: ChatDebugLogLevel = ChatDebugLogLevel.Info): void {
		const event: IChatDebugLogEvent = {
			sessionId,
			created: new Date(),
			name,
			contents,
			level,
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

	clear(): void {
		this._events.length = 0;
	}

	registerProvider(provider: IChatDebugLogProvider): IDisposable {
		this._providers.add(provider);
		return toDisposable(() => this._providers.delete(provider));
	}

	async invokeProviders(sessionId: string): Promise<void> {
		const cts = new CancellationTokenSource();
		try {
			const promises = [...this._providers].map(async provider => {
				const events = await provider.provideChatDebugLog(sessionId, cts.token);
				if (events) {
					for (const event of events) {
						this.log(event.sessionId ?? sessionId, event.name, event.contents, event.level);
					}
				}
			});
			await Promise.allSettled(promises);
		} finally {
			cts.dispose();
		}
	}
}
