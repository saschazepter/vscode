/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { webContents } from 'electron';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { CDPTargetInfo, ICDPDebugTarget, ICDPDebuggerClient } from '../common/cdp/types.js';

interface TargetInfo {
	targetId: string;
	type: string;
	title: string;
	url: string;
	attached: boolean;
	canAccessOpener: boolean;
}

/**
 * Wraps a browser view's Electron debugger with per-client session management.
 *
 * Each client gets their own Electron debugger session, providing true isolation
 * just like connecting multiple DevTools clients to a real Chrome instance.
 */
export class BrowserViewDebugger extends Disposable implements ICDPDebugTarget {
	/** Map from client to their real Electron sessionId */
	private readonly _clientSessions = new Map<ICDPDebuggerClient, string>();
	/** Map from client to their onCommand subscription */
	private readonly _clientSubscriptions = new Map<ICDPDebuggerClient, IDisposable>();
	/** Reverse map: Electron sessionId to client */
	private readonly _sessionToClient = new Map<string, ICDPDebuggerClient>();
	/** The real Electron targetId discovered from Target.getTargets() */
	private _realTargetId: string | undefined;
	private _attached = false;
	private readonly _messageHandler: (event: Electron.Event, method: string, params: unknown, sessionId?: string) => void;

	constructor(
		private readonly id: string,
		readonly getTitle: () => string,
		readonly getURL: () => string,
		readonly getFaviconURL: () => string | undefined,
		private readonly electronDebugger: Electron.Debugger,
		private readonly webContentsId: number,
		private readonly logService: ILogService
	) {
		super();

		// Set up message handler bound to this instance - note the sessionId parameter
		this._messageHandler = (_event: Electron.Event, method: string, params: unknown, sessionId?: string) => {
			this.routeCDPEvent(method, params, sessionId);
		};
	}

	/**
	 * Number of clients currently connected to this debugger
	 */
	get clientCount(): number {
		return this._clientSessions.size;
	}

	/**
	 * Whether the Electron debugger is currently attached
	 */
	get isAttached(): boolean {
		return this._attached;
	}

	/**
	 * The real Electron targetId for this WebContents
	 */
	get realTargetId(): string | undefined {
		return this._realTargetId;
	}

	/**
	 * Attach a client to this debugger.
	 * Creates a dedicated Electron debugger session for this client.
	 * @returns A disposable that detaches the client when disposed
	 */
	async attach(client: ICDPDebuggerClient): Promise<IDisposable> {
		if (this._clientSessions.has(client)) {
			return toDisposable(() => this.detachClient(client));
		}

		// First client: attach to Electron debugger and discover real targetId
		if (!this._attached) {
			this.attachElectronDebugger();
			await this.discoverRealTargetId();
		}

		if (!this._realTargetId) {
			throw new Error('Could not discover real targetId for this WebContents');
		}

		// Create a dedicated Electron session for this client
		const result = await this.electronDebugger.sendCommand('Target.attachToTarget', {
			targetId: this._realTargetId,
			flatten: true
		}) as { sessionId: string };

		const sessionId = result.sessionId;
		this._clientSessions.set(client, sessionId);
		this._sessionToClient.set(sessionId, client);

		// Subscribe to client's command events
		const subscription = client.onCommand(command => {
			this.electronDebugger.sendCommand(command.method, command.params, sessionId)
				.then(result => command.resolve(result))
				.catch(error => command.reject(error));
		});
		this._clientSubscriptions.set(client, subscription);

		this.logService.debug(`[BrowserViewDebugger] Client attached to ${this.id} with session ${sessionId} (total: ${this._clientSessions.size})`);

		return toDisposable(() => this.detachClient(client));
	}

	/**
	 * Detach a client from this debugger.
	 * Cleans up the dedicated Electron session for this client.
	 */
	private detachClient(client: ICDPDebuggerClient): void {
		const sessionId = this._clientSessions.get(client);
		if (!sessionId) {
			return;
		}

		// Dispose command subscription
		this._clientSubscriptions.get(client)?.dispose();
		this._clientSubscriptions.delete(client);

		// Detach from the Electron session (fire and forget)
		this.electronDebugger.sendCommand('Target.detachFromTarget', { sessionId }).catch(error => {
			this.logService.debug(`[BrowserViewDebugger] Error detaching session ${sessionId}: ${error}`);
		});

		this._clientSessions.delete(client);
		this._sessionToClient.delete(sessionId);

		this.logService.debug(`[BrowserViewDebugger] Client detached from ${this.id} (remaining: ${this._clientSessions.size})`);
	}

	/**
	 * Get CDP target info using internal browser view ID.
	 */
	getTargetInfo(): CDPTargetInfo {
		return {
			targetId: this.id,
			type: 'page',
			title: this.getTitle() || 'Browser View',
			url: this.getURL() || 'about:blank',
			attached: this._clientSessions.size > 0,
			canAccessOpener: false
		};
	}

	/**
	 * Discover the real Electron targetId for this WebContents
	 */
	private async discoverRealTargetId(): Promise<void> {
		try {
			const result = await this.electronDebugger.sendCommand('Target.getTargets') as { targetInfos: TargetInfo[] };
			const targetInfos = result.targetInfos;

			// Find the target that matches this WebContents
			for (const targetInfo of targetInfos) {
				if (targetInfo.type !== 'page') {
					continue;
				}
				// Use Electron's API to match targetId to WebContents
				const targetWebContents = webContents.fromDevToolsTargetId(targetInfo.targetId);
				if (targetWebContents?.id === this.webContentsId) {
					this._realTargetId = targetInfo.targetId;
					this.logService.debug(`[BrowserViewDebugger] Discovered real targetId: ${this._realTargetId} for ${this.id}`);
					return;
				}
			}

			this.logService.warn(`[BrowserViewDebugger] Could not find real targetId for WebContents ${this.webContentsId}`);
		} catch (error) {
			this.logService.error(`[BrowserViewDebugger] Error discovering real targetId:`, error);
		}
	}

	/**
	 * Attach to the Electron debugger
	 */
	private attachElectronDebugger(): void {
		if (this._attached || this.electronDebugger.isAttached()) {
			this._attached = true;
			return;
		}

		this.electronDebugger.attach('1.3');
		this._attached = true;
		this.electronDebugger.on('message', this._messageHandler);
		this.logService.info(`[BrowserViewDebugger] Attached to Electron debugger for ${this.id}`);
	}

	/**
	 * Detach from the Electron debugger
	 */
	private detachElectronDebugger(): void {
		if (!this._attached) {
			return;
		}

		this.electronDebugger.removeListener('message', this._messageHandler);
		try {
			if (this.electronDebugger.isAttached()) {
				this.electronDebugger.detach();
			}
		} catch (error) {
			this.logService.error(`[BrowserViewDebugger] Error detaching from ${this.id}:`, error);
		}
		this._attached = false;
		this.logService.info(`[BrowserViewDebugger] Detached from Electron debugger for ${this.id}`);
	}

	/**
	 * Route a CDP event to the correct client by sessionId.
	 * Simply forwards raw events to the proxy for translation and routing.
	 */
	private routeCDPEvent(method: string, params: unknown, sessionId?: string): void {
		if (!sessionId) {
			// No sessionId - shouldn't happen with flatten: true, but broadcast just in case
			this.logService.warn(`[BrowserViewDebugger] Event without sessionId: ${method}`);
			for (const client of this._clientSessions.keys()) {
				client.handleEvent({ method, params });
			}
			return;
		}

		// Find the client for this sessionId and forward the raw event
		const client = this._sessionToClient.get(sessionId);
		if (client) {
			client.handleEvent({ method, params, sessionId });
			this.logService.debug(`[BrowserViewDebugger] <- Event ${method} to session ${sessionId}`);
		} else {
			this.logService.debug(`[BrowserViewDebugger] No client found for session ${sessionId}, event: ${method}`);
		}
	}

	override dispose(): void {
		// Dispose all client subscriptions
		for (const subscription of this._clientSubscriptions.values()) {
			subscription.dispose();
		}
		this._clientSubscriptions.clear();
		this._clientSessions.clear();
		this._sessionToClient.clear();

		// Detach from Electron debugger
		this.detachElectronDebugger();

		super.dispose();
	}
}
