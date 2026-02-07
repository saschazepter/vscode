/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ICDPTarget, ICDPClient, CDPCommand, CDPEvent, CDPServerError } from './types.js';

/**
 * Callback interface for when a session needs to send an event to the proxy.
 */
export interface ISessionEventSink {
	/**
	 * Called when the session receives an event from the target.
	 * @param event The CDP event with sessionId already set appropriately
	 */
	onSessionEvent(event: CDPEvent): void;
}

/**
 * Represents a single CDP session attached to a target.
 * Each session has its own command/event channel to the target.
 *
 * For named sessions (created via Target.attachToTarget), commands are sent
 * with a sessionId and events are received with that sessionId.
 *
 * For the default session (direct /devtools/page connection), commands and
 * events have no sessionId.
 */
export class CDPPageSession extends Disposable implements ICDPClient {
	private readonly _onCommand = this._register(new Emitter<CDPCommand>());
	readonly onCommand: Event<CDPCommand> = this._onCommand.event;

	private _attachment: { dispose(): void } | undefined;
	private _pendingCommands = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
	private _nextCommandId = 1;

	constructor(
		readonly sessionId: string, // Empty string for default session
		readonly targetId: string,
		private readonly target: ICDPTarget,
		private readonly eventSink: ISessionEventSink
	) {
		super();
	}

	/**
	 * Whether this is the default session (no sessionId in protocol messages)
	 */
	get isDefault(): boolean {
		return this.sessionId === '';
	}

	/**
	 * Attach to the target. Must be called before sending commands.
	 */
	async attach(): Promise<void> {
		if (this._attachment) {
			return;
		}

		this._attachment = await this.target.attach(this);
	}

	/**
	 * Send a CDP command to the target.
	 */
	sendCommand(method: string, params?: unknown): Promise<unknown> {
		return new Promise<unknown>((resolve, reject) => {
			const commandId = this._nextCommandId++;

			this._pendingCommands.set(commandId, { resolve, reject });

			this._onCommand.fire({
				method,
				params,
				resolve: (result) => {
					const pending = this._pendingCommands.get(commandId);
					if (pending) {
						this._pendingCommands.delete(commandId);
						pending.resolve(result ?? {});
					}
				},
				reject: (error) => {
					const pending = this._pendingCommands.get(commandId);
					if (pending) {
						this._pendingCommands.delete(commandId);
						pending.reject(new CDPServerError(error.message || 'Unknown error'));
					}
				}
			});
		});
	}

	/**
	 * Handle an event from the target.
	 * Implements ICDPClient interface.
	 */
	handleEvent(event: CDPEvent): void {
		// Filter out Target.* events - these are handled at the CDPProxy level.
		if (event.method.startsWith('Target.')) {
			return;
		}

		// Forward to the event sink with our sessionId (or undefined for default)
		this.eventSink.onSessionEvent({
			method: event.method,
			params: event.params,
			sessionId: this.isDefault ? undefined : this.sessionId
		});
	}

	override dispose(): void {
		// Reject any pending commands
		for (const { reject } of this._pendingCommands.values()) {
			reject(new Error('Session disposed'));
		}
		this._pendingCommands.clear();

		// Detach from target
		this._attachment?.dispose();
		this._attachment = undefined;

		super.dispose();
	}
}
