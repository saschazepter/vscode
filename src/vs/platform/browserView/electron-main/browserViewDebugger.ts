/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { CDPEvent, CDPTargetInfo, ICDPConnection, ICDPTarget } from '../common/cdp/types.js';
import { BrowserView } from './browserView.js';

/**
 * Wraps a browser view's Electron debugger with per-client session management.
 *
 * Each client gets their own Electron debugger session, providing true isolation
 * just like connecting multiple DevTools clients to a real Chrome instance.
 */
export class BrowserViewDebugger extends Disposable implements ICDPTarget {

	/** Map from Electron sessionId to the per-connection event emitter */
	private readonly _sessionEmitters = this._register(new DisposableMap<string, Emitter<CDPEvent>>());

	/**
	 * The real Electron targetId discovered from Target.getTargets().
	 * Ideally this could be fetched synchronously from the WebContents,
	 * but in practice we need to query Electron's debugger API asynchronously to find it.
	 */
	private _realTargetId: string | undefined;
	private readonly _messageHandler: (event: Electron.Event, method: string, params: unknown, sessionId?: string) => void;
	private readonly _electronDebugger: Electron.Debugger;

	constructor(
		private readonly view: BrowserView,
		private readonly logService: ILogService
	) {
		super();

		this._electronDebugger = view.webContents.debugger;

		// Set up message handler bound to this instance - note the sessionId parameter
		this._messageHandler = (_event: Electron.Event, method: string, params: unknown, sessionId?: string) => {
			this.routeCDPEvent(method, params, sessionId);
		};
	}

	/**
	 * Attach to this debugger.
	 * Creates a dedicated Electron debugger session and returns a connection.
	 * Dispose the returned connection to detach.
	 */
	async attach(): Promise<ICDPConnection> {
		// Ensure initialized
		await this.initialize();

		// Create a dedicated Electron session
		const result = await this._electronDebugger.sendCommand('Target.attachToTarget', {
			targetId: this._realTargetId,
			flatten: true
		}) as { sessionId: string };

		const sessionId = result.sessionId;
		const disposables = new DisposableStore();

		// Per-connection emitters
		const onEvent = new Emitter<CDPEvent>();
		const onClose = new Emitter<void>();
		disposables.add(onEvent);
		disposables.add(onClose);

		this._sessionEmitters.set(sessionId, onEvent);

		// Build the connection object
		const connection: ICDPConnection = {
			sessionId,
			onEvent: onEvent.event,
			onClose: onClose.event,
			sendMessage: (method: string, params?: unknown, _sessionId?: string): Promise<unknown> => {
				// This crashes Electron. Don't pass it through.
				if (method === 'Emulation.setDeviceMetricsOverride') {
					return Promise.resolve({});
				}

				return this._electronDebugger.sendCommand(method, params, sessionId);
			},
			dispose: () => {
				if (!this._sessionEmitters.has(sessionId)) {
					return; // already disposed
				}
				this._sessionEmitters.deleteAndDispose(sessionId);

				// Detach from the Electron session (fire and forget)
				this._electronDebugger.sendCommand('Target.detachFromTarget', { sessionId }).catch(() => { });

				onClose.fire();
				disposables.dispose();
			}
		};

		return connection;
	}

	/**
	 * Get CDP target info using Electron's real targetId.
	 * Initializes the debugger if not already done.
	 */
	async getTargetInfo(): Promise<CDPTargetInfo> {
		// Ensure initialized
		await this.initialize();

		return {
			targetId: this._realTargetId!,
			type: 'page',
			title: this.view.webContents.getTitle() || 'Browser View',
			url: this.view.webContents.getURL() || 'about:blank',
			attached: this._sessionEmitters.size > 0,
			canAccessOpener: false,
			browserContextId: this.view.session.id
		};
	}

	/**
	 * Initialize the debugger early to discover the real Electron targetId.
	 * This should be called before exposing the target to CDP clients.
	 */
	private async initialize(): Promise<void> {
		if (this._realTargetId) {
			return; // Already initialized
		}

		this.attachElectronDebugger();
		await this.discoverRealTargetId();

		if (!this._realTargetId) {
			throw new Error('Could not discover real targetId for this WebContents');
		}
	}

	/**
	 * Discover the real Electron targetId for this WebContents
	 */
	private async discoverRealTargetId(): Promise<void> {
		try {
			const result = await this._electronDebugger.sendCommand('Target.getTargetInfo') as { targetInfo: CDPTargetInfo };
			this._realTargetId = result.targetInfo.targetId;
			this.logService.warn(`[BrowserViewDebugger] Could not find real targetId for WebContents ${this.view.webContents.id}`);
		} catch (error) {
			this.logService.error(`[BrowserViewDebugger] Error discovering real targetId:`, error);
		}
	}

	/**
	 * Attach to the Electron debugger
	 */
	private attachElectronDebugger(): void {
		if (this._electronDebugger.isAttached()) {
			return;
		}

		this._electronDebugger.attach('1.3');
		this._electronDebugger.on('message', this._messageHandler);
	}

	/**
	 * Detach from the Electron debugger
	 */
	private detachElectronDebugger(): void {
		if (!this._electronDebugger.isAttached()) {
			return;
		}

		this._electronDebugger.removeListener('message', this._messageHandler);
		try {
			this._electronDebugger.detach();
		} catch (error) {
			this.logService.error(`[BrowserViewDebugger] Error detaching from WebContents:`, error);
		}
	}

	/**
	 * Route a CDP event to the correct connection by sessionId.
	 * Fires on the per-connection emitter for the proxy to handle.
	 */
	private routeCDPEvent(method: string, params: unknown, sessionId?: string): void {
		if (!sessionId) {
			// No sessionId - shouldn't happen with flatten: true, but broadcast just in case
			this.logService.warn(`[BrowserViewDebugger] Event without sessionId: ${method}`);
			for (const emitter of this._sessionEmitters.values()) {
				emitter.fire({ method, params });
			}
			return;
		}

		// Find the emitter for this sessionId and fire the event
		const emitter = this._sessionEmitters.get(sessionId);
		if (emitter) {
			emitter.fire({ method, params, sessionId });
		}
	}

	override dispose(): void {
		this.detachElectronDebugger();
		super.dispose();
	}
}
