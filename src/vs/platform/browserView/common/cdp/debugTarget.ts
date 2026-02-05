/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../log/common/log.js';
import { CDPTargetInfo } from './types.js';

// Forward reference to avoid circular dependency
export type CDPClientLike = {
	pageAttached: boolean;
	pageSessionId: string;
	sendEvent(method: string, params: unknown, sessionId?: string): void;
	dispose(): void;
};

/**
 * Represents a debug target (browser view's webContents).
 * Manages the Electron debugger attachment and connected clients.
 */
export class DebugTarget extends Disposable {
	private readonly _connectedClients = new Set<CDPClientLike>();

	constructor(
		readonly id: string,
		readonly getTitle: () => string,
		readonly getURL: () => string,
		readonly getFaviconURL: () => string | undefined,
		private readonly debug: Electron.Debugger,
		private readonly logService: ILogService
	) {
		super();
	}

	get connectedClients(): Set<CDPClientLike> {
		return this._connectedClients;
	}

	/**
	 * Attach the Electron debugger to this webContents
	 */
	attachDebugger(): void {
		if (this.debug.isAttached()) {
			return;
		}

		this.debug.attach('1.3');

		// Listen for CDP events from the debugger
		const messageHandler = (_event: Electron.Event, method: string, params: unknown) => {
			this.broadcastCDPEvent(method, params);
		};
		this.debug.on('message', messageHandler);

		this._register({
			dispose: () => {
				if (this.debug.isAttached()) {
					this.debug.removeListener('message', messageHandler);
					try {
						this.debug.detach();
					} catch (error) {
						this.logService.error(`[DebugTarget] Error detaching debugger from ${this.id}:`, error);
					}
				}
			}
		});

		this.logService.info(`[DebugTarget] Attached debugger to target ${this.id}`);
	}

	/**
	 * Send a CDP command to this target's debugger
	 */
	async sendCommand(method: string, params?: unknown): Promise<unknown> {
		return this.debug.sendCommand(method, params);
	}

	/**
	 * Add a client connection to this target.
	 * Returns true if the client was added, false if already registered.
	 */
	addClient(client: CDPClientLike): boolean {
		// Ensure debugger is attached
		this.attachDebugger();

		if (this._connectedClients.has(client)) {
			return false;
		}
		this._connectedClients.add(client);
		return true;
	}

	/**
	 * Remove a client connection from this target.
	 * When the last client disconnects, disables the debugger to reset state.
	 */
	removeClient(client: CDPClientLike): void {
		this._connectedClients.delete(client);

		// When the last client disconnects, disable the debugger to reset state
		// This ensures breakpoints, instrumentation breakpoints, etc. are cleared
		// so the next client gets a fresh session with all scriptParsed events
		if (this._connectedClients.size === 0 && this.debug.isAttached()) {
			this.debug.sendCommand('Debugger.disable').catch(error => {
				this.logService.debug(`[DebugTarget] Error disabling debugger on last client disconnect: ${error}`);
			});
		}
	}

	/**
	 * Get CDP target info for this target
	 */
	getTargetInfo(): CDPTargetInfo {
		return {
			targetId: this.id,
			type: 'page',
			title: this.getTitle() || 'Browser View',
			url: this.getURL() || 'about:blank',
			attached: false,
			canAccessOpener: false
		};
	}

	/**
	 * Broadcast a CDP event to all connected clients that are attached to the page session
	 */
	private broadcastCDPEvent(method: string, params: unknown): void {
		for (const client of this._connectedClients) {
			if (client.pageAttached) {
				client.sendEvent(method, params, client.pageSessionId);
				this.logService.debug(`[DebugTarget] <- Event to ${this.id}: ${method}`);
			}
		}
	}

	override dispose(): void {
		// Close all client connections
		for (const client of this._connectedClients) {
			client.dispose();
		}
		this._connectedClients.clear();

		super.dispose();
	}
}
