/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotSession, SessionEventPayload, SessionEventType } from '@github/copilot-sdk';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';

/**
 * Thin wrapper around {@link CopilotSession} that exposes each SDK event as a
 * proper VS Code `Event<T>`. All subscriptions and the underlying SDK session
 * are cleaned up on dispose.
 */
export class CopilotSessionWrapper extends Disposable {

	constructor(readonly session: CopilotSession) {
		super();
		this._register(toDisposable(() => {
			session.destroy().catch(() => { /* best-effort */ });
		}));
	}

	get sessionId(): string { return this.session.sessionId; }

	private _onMessageDelta: Event<SessionEventPayload<'assistant.message_delta'>> | undefined;
	get onMessageDelta(): Event<SessionEventPayload<'assistant.message_delta'>> {
		return this._onMessageDelta ??= this._sdkEvent('assistant.message_delta');
	}

	private _onMessage: Event<SessionEventPayload<'assistant.message'>> | undefined;
	get onMessage(): Event<SessionEventPayload<'assistant.message'>> {
		return this._onMessage ??= this._sdkEvent('assistant.message');
	}

	private _onToolStart: Event<SessionEventPayload<'tool.execution_start'>> | undefined;
	get onToolStart(): Event<SessionEventPayload<'tool.execution_start'>> {
		return this._onToolStart ??= this._sdkEvent('tool.execution_start');
	}

	private _onToolComplete: Event<SessionEventPayload<'tool.execution_complete'>> | undefined;
	get onToolComplete(): Event<SessionEventPayload<'tool.execution_complete'>> {
		return this._onToolComplete ??= this._sdkEvent('tool.execution_complete');
	}

	private _onIdle: Event<SessionEventPayload<'session.idle'>> | undefined;
	get onIdle(): Event<SessionEventPayload<'session.idle'>> {
		return this._onIdle ??= this._sdkEvent('session.idle');
	}

	/**
	 * Track an external disposable on this wrapper so it is cleaned up
	 * when the session is disposed.
	 */
	addDisposable<T extends IDisposable>(disposable: T): T {
		return this._register(disposable);
	}

	private _sdkEvent<K extends SessionEventType>(eventType: K): Event<SessionEventPayload<K>> {
		const emitter = this._register(new Emitter<SessionEventPayload<K>>());
		const unsubscribe = this.session.on(eventType, (data) => emitter.fire(data));
		this._register(toDisposable(unsubscribe));
		return emitter.event;
	}
}
