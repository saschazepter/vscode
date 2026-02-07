/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { webContents } from 'electron';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { CDPTargetInfo, ICDPTarget, ICDPClient } from '../common/cdp/types.js';

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
export class BrowserViewDebugger extends Disposable implements ICDPTarget {
	/** Map from client to their real Electron sessionId */
	private readonly _clientSessions = new Map<ICDPClient, string>();
	/** Map from client to their onCommand subscription */
	private readonly _clientSubscriptions = new Map<ICDPClient, IDisposable>();
	/** Reverse map: Electron sessionId to client */
	private readonly _sessionToClient = new Map<string, ICDPClient>();
	/** The real Electron targetId discovered from Target.getTargets() */
	private _realTargetId: string | undefined;
	private _attached = false;
	private readonly _messageHandler: (event: Electron.Event, method: string, params: unknown, sessionId?: string) => void;

	constructor(
		private readonly id: string,
		private readonly browserContextId: string,
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
	 * Initialize the debugger early to discover the real Electron targetId.
	 * This should be called before exposing the target to CDP clients.
	 */
	async initialize(): Promise<void> {
		if (this._realTargetId) {
			return; // Already initialized
		}

		this.attachElectronDebugger();
		await this.discoverRealTargetId();
	}

	/**
	 * Attach a client to this debugger.
	 * Creates a dedicated Electron debugger session for this client.
	 * @returns A disposable that detaches the client when disposed
	 */
	async attach(client: ICDPClient): Promise<IDisposable> {
		if (this._clientSessions.has(client)) {
			return toDisposable(() => this.detachClient(client));
		}

		// Ensure initialized (should already be, but just in case)
		if (!this._attached) {
			await this.initialize();
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

		return toDisposable(() => this.detachClient(client));
	}

	/**
	 * Detach a client from this debugger.
	 * Cleans up the dedicated Electron session for this client.
	 */
	private detachClient(client: ICDPClient): void {
		const sessionId = this._clientSessions.get(client);
		if (!sessionId) {
			return;
		}

		// Dispose command subscription
		this._clientSubscriptions.get(client)?.dispose();
		this._clientSubscriptions.delete(client);

		// Detach from the Electron session (fire and forget)
		this.electronDebugger.sendCommand('Target.detachFromTarget', { sessionId }).catch(() => { });

		this._clientSessions.delete(client);
		this._sessionToClient.delete(sessionId);
	}

	/**
	 * Get CDP target info using Electron's real targetId.
	 * Initializes the debugger if not already done.
	 */
	async getTargetInfo(): Promise<CDPTargetInfo> {
		if (!this._realTargetId) {
			await this.initialize();
		}

		if (!this._realTargetId) {
			throw new Error('Could not discover real targetId for this WebContents');
		}

		return {
			targetId: this._realTargetId,
			type: 'page',
			title: this.getTitle() || 'Browser View',
			url: this.getURL() || 'about:blank',
			attached: this._clientSessions.size > 0,
			canAccessOpener: false,
			browserContextId: this.browserContextId
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
