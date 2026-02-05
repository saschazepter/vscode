/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { ILogService } from '../../log/common/log.js';
import { createServer, Server as HttpServer, IncomingMessage } from 'http';
import { AddressInfo, Socket } from 'net';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IBrowserViewDebugInfo } from '../common/browserView.js';
import { upgradeToISocket } from '../../../base/parts/ipc/node/ipc.net.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { DebugTarget } from '../common/cdp/debugTarget.js';
import { CDPClient, ICDPClientServiceCallback } from '../common/cdp/cdpClient.js';
import { CDPTargetInfo, CDPConnectionContext } from '../common/cdp/types.js';

export const IBrowserViewDebugProxyService = createDecorator<IBrowserViewDebugProxyService>('browserViewDebugProxyService');

/**
 * Event fired when a new browser view target should be created via CDP.
 */
export interface ICreateTargetRequest {
	/** The generated target ID */
	readonly targetId: string;
	/** The URL to navigate to */
	readonly url: string;
}

/**
 * Event fired when a browser view target should be closed via CDP.
 */
export interface ICloseTargetRequest {
	/** The target ID to close */
	readonly targetId: string;
}

export interface IBrowserViewDebugProxyService {
	readonly _serviceBrand: undefined;

	/**
	 * Event fired when a new target should be created (via CDP Target.createTarget).
	 * Listeners should create the browser view and call registerTarget when ready.
	 */
	readonly onDidRequestCreateTarget: Event<ICreateTargetRequest>;

	/**
	 * Event fired when a target should be closed (via CDP Target.closeTarget).
	 * Listeners should close the browser view - unregisterTarget will be called automatically.
	 */
	readonly onDidRequestCloseTarget: Event<ICloseTargetRequest>;

	/**
	 * Ensure the debug proxy server is started.
	 * Call this to start the server before any browser views are opened.
	 * @returns Debug connection information
	 */
	ensureStarted(): Promise<IBrowserViewDebugInfo>;

	/**
	 * Register a browser view's webContents for debugging
	 * @param targetId Unique identifier for this target
	 * @param webContents The Electron webContents to debug
	 * @returns Debug connection information
	 */
	registerTarget(targetId: string, webContents: Electron.WebContents): void;

	/**
	 * Unregister a browser view from debugging
	 * @param targetId The target identifier to unregister
	 */
	unregisterTarget(targetId: string): void;

	/**
	 * Check if a target is registered
	 */
	hasTarget(targetId: string): boolean;

	/**
	 * Get debug info for a specific target (or the service if no target specified)
	 */
	getDebugInfo(targetId?: string): IBrowserViewDebugInfo | undefined;
}

/**
 * Singleton service that provides a single WebSocket proxy server for all browser view debugging.
 * This allows VS Code's js-debug to attach to any registered BrowserView through a single port.
 *
 * ## Architecture
 *
 * - Single HTTP server listening on one port
 * - `/json/list` returns all registered browser views as targets
 * - WebSocket connections can connect to any target
 * - Each target has its own webContents.debugger attachment
 *
 * ## CDP Flow
 *
 * 1. Connect to WebSocket
 * 2. Call Target.attachToBrowserTarget() → returns browser sessionId
 * 3. Call Target.setDiscoverTargets({ discover: true }) → triggers targetCreated events for all targets
 * 4. Call Target.attachToTarget({ targetId, flatten: true }) → returns page sessionId
 * 5. Send debugging commands with page sessionId
 */
export class BrowserViewDebugProxyService extends Disposable implements IBrowserViewDebugProxyService, ICDPClientServiceCallback {
	declare readonly _serviceBrand: undefined;

	private server: HttpServer | undefined;
	private port: number | undefined;
	private readonly browserId: string;
	private readonly targets = new Map<string, DebugTarget>();
	private readonly clients = new Set<CDPClient>();
	private sessionCounter = 0;

	/** Pending target creation requests waiting for registration */
	private readonly pendingTargetCreations = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();

	private readonly _onDidRequestCreateTarget = this._register(new Emitter<ICreateTargetRequest>());
	readonly onDidRequestCreateTarget: Event<ICreateTargetRequest> = this._onDidRequestCreateTarget.event;

	private readonly _onDidRequestCloseTarget = this._register(new Emitter<ICloseTargetRequest>());
	readonly onDidRequestCloseTarget: Event<ICloseTargetRequest> = this._onDidRequestCloseTarget.event;

	constructor(
		@ILogService private readonly logService: ILogService
	) {
		super();
		this.browserId = generateUuid();
	}

	async ensureStarted(): Promise<IBrowserViewDebugInfo> {
		await this.ensureServerStarted();
		return this.getDebugInfo()!;
	}

	registerTarget(targetId: string, webContents: Electron.WebContents) {
		if (this.targets.has(targetId)) {
			this.logService.debug(`[BrowserViewDebugProxy] Target ${targetId} already registered`);
			return;
		}

		const target = new DebugTarget(
			targetId,
			() => webContents.getTitle(),
			() => webContents.getURL(),
			() => undefined, // TODO
			webContents.debugger,
			this.logService
		);

		webContents.on('destroyed', () => {
			this.logService.debug(`[BrowserViewDebugProxy] WebContents for target ${targetId} destroyed`);
			this.unregisterTarget(targetId);
		});

		this.targets.set(targetId, target);
		this.broadcastTargetCreated(targetId);

		// Resolve any pending creation request for this target
		const pending = this.pendingTargetCreations.get(targetId);
		if (pending) {
			pending.resolve();
			this.pendingTargetCreations.delete(targetId);
		}

		this.logService.debug(`[BrowserViewDebugProxy] Registered target ${targetId}`);
	}

	unregisterTarget(targetId: string): void {
		const target = this.targets.get(targetId);
		if (!target) {
			return;
		}

		this.broadcastTargetDestroyed(targetId);

		// Remove clients that were connected to this target
		for (const client of target.connectedClients) {
			this.clients.delete(client as CDPClient);
		}

		target.dispose();
		this.targets.delete(targetId);
		this.logService.debug(`[BrowserViewDebugProxy] Unregistered target ${targetId}`);
	}

	hasTarget(targetId: string): boolean {
		return this.targets.has(targetId);
	}

	getDebugInfo(targetId?: string): IBrowserViewDebugInfo | undefined {
		if (!this.port) {
			return undefined;
		}

		if (targetId && !this.targets.has(targetId)) {
			return undefined;
		}

		return {
			port: this.port,
			webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}`
		};
	}

	/**
	 * Get a target by ID (used by CDPClient)
	 */
	getTarget(targetId: string): DebugTarget | undefined {
		return this.targets.get(targetId);
	}

	/**
	 * Get the first available target ID (used by CDPClient)
	 */
	getFirstTargetId(): string | undefined {
		return this.targets.keys().next().value;
	}

	/**
	 * Get all target infos for CDP protocol (used by CDPClient)
	 */
	getAllTargetInfos(): CDPTargetInfo[] {
		const infos: CDPTargetInfo[] = [];
		for (const target of this.targets.values()) {
			const info = target.getTargetInfo();
			if (info) {
				infos.push(info);
			}
		}
		return infos;
	}

	/**
	 * Create a new target (ICDPClientServiceCallback).
	 * Generates a target ID, fires an event, and waits for the target to be registered.
	 */
	async createTarget(url: string): Promise<{ targetId: string }> {
		const targetId = `cdp-created-${generateUuid()}`;

		// Create a promise that will be resolved when the target is registered
		const registrationPromise = new Promise<void>((resolve, reject) => {
			this.pendingTargetCreations.set(targetId, { resolve, reject });

			// Timeout after 30 seconds
			setTimeout(() => {
				if (this.pendingTargetCreations.has(targetId)) {
					this.pendingTargetCreations.delete(targetId);
					reject(new Error(`Timeout waiting for target ${targetId} to be registered`));
				}
			}, 30000);
		});

		// Fire the event to request target creation
		this._onDidRequestCreateTarget.fire({ targetId, url });

		// Wait for the target to be registered
		await registrationPromise;

		return { targetId };
	}

	/**
	 * Close a target (ICDPClientServiceCallback).
	 * Fires an event to request closure and unregisters the target.
	 */
	async closeTarget(targetId: string): Promise<boolean> {
		if (!this.targets.has(targetId)) {
			return false;
		}

		// Fire the event to request target closure
		this._onDidRequestCloseTarget.fire({ targetId });

		// Unregister the target
		this.unregisterTarget(targetId);

		return true;
	}

	/**
	 * Handle client disconnection (called by CDPClient)
	 */
	handleClientDisconnected(client: CDPClient): void {
		const target = this.targets.get(client.targetId);
		if (target) {
			target.removeClient(client);
		}
		this.clients.delete(client);
		client.dispose();
	}

	private async ensureServerStarted(): Promise<void> {
		if (this.server) {
			return;
		}

		this.server = createServer();

		await new Promise<void>((resolve, reject) => {
			this.server!.listen(0, '127.0.0.1', () => resolve());
			this.server!.once('error', reject);
		});

		const address = this.server.address() as AddressInfo;
		this.port = address.port;

		this.server.on('request', (req, res) => this.handleHttpRequest(req, res));
		this.server.on('upgrade', (req: IncomingMessage, socket: Socket) => this.handleWebSocketUpgrade(req, socket));

		this.logService.debug(`[BrowserViewDebugProxy] Started debug proxy service on port ${this.port}`);
		this.logService.debug(`[BrowserViewDebugProxy] Target list available at: http://127.0.0.1:${this.port}/json`);
	}

	private handleHttpRequest(req: IncomingMessage, res: import('http').ServerResponse): void {
		this.logService.debug(`[BrowserViewDebugProxy] HTTP request: ${req.method} ${req.url}`);

		if (req.url === '/json' || req.url === '/json/list') {
			const targets = this.getTargetListForHttp();
			this.logService.debug(`[BrowserViewDebugProxy] Returning ${targets.length} targets`);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(targets));
		} else if (req.url === '/json/version') {
			// This format is what Puppeteer expects when connecting via browserURL
			// The webSocketDebuggerUrl must be a browser target URL (not a page target)
			const version = {
				'Browser': 'VS Code Integrated Browser',
				'Protocol-Version': '1.3',
				'User-Agent': 'Electron',
				'V8-Version': process.versions.v8,
				'WebKit-Version': process.versions.chrome,
				// Puppeteer expects format: ws://HOST:PORT/devtools/browser/<id>
				'webSocketDebuggerUrl': `ws://127.0.0.1:${this.port}/devtools/browser/${this.browserId}`
			};
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(version));
		} else {
			res.writeHead(404);
			res.end();
		}
	}

	private getTargetListForHttp(): Array<{
		id: string;
		type: string;
		title: string;
		url: string;
		webSocketDebuggerUrl: string;
		devtoolsFrontendUrl: string;
		faviconUrl: string;
	}> {
		const targets: Array<{
			id: string;
			type: string;
			title: string;
			url: string;
			webSocketDebuggerUrl: string;
			devtoolsFrontendUrl: string;
			faviconUrl: string;
		}> = [];

		for (const target of this.targets.values()) {
			const { targetId, ...info } = target.getTargetInfo();
			targets.push({
				id: targetId,
				...info,
				webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}`,
				devtoolsFrontendUrl: `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${this.port}`,
				faviconUrl: ''
			});
		}

		return targets;
	}

	/**
	 * Parse the WebSocket URL path to determine connection context.
	 * - /devtools/browser/<id> - Browser-level connection
	 * - /devtools/page/<targetId> - Direct page connection
	 * - / - Root connection
	 */
	private parseConnectionContext(url: string): CDPConnectionContext | undefined {
		const isRootPath = url === '/' || url === '';
		const browserMatch = url.match(/^\/devtools\/browser\/(.+)$/);
		const pageMatch = url.match(/^\/devtools\/page\/(.+)$/);

		if (browserMatch) {
			// Browser-level connection - can create/manage targets
			const firstTargetId = this.getFirstTargetId() || 'default';
			return {
				browserAttached: true,
				pageAttached: false,
				targetId: firstTargetId
			};
		}

		if (pageMatch) {
			// Direct page connection - immediately attached to a specific target
			const targetId = pageMatch[1];
			if (!this.targets.has(targetId)) {
				this.logService.warn(`[BrowserViewDebugProxy] Page connection to unknown target: ${targetId}`);
				return undefined;
			}
			return {
				browserAttached: false,
				pageAttached: true,
				targetId
			};
		}

		if (isRootPath) {
			// Root connection - needs to explicitly attach
			return {
				browserAttached: false,
				pageAttached: false,
				targetId: ''
			};
		}

		// Unknown path
		return undefined;
	}

	private handleWebSocketUpgrade(req: IncomingMessage, socket: Socket): void {
		const url = req.url || '/';
		this.logService.debug(`[BrowserViewDebugProxy] WebSocket upgrade request: ${url} from ${socket.remoteAddress}`);

		const context = this.parseConnectionContext(url);
		if (!context) {
			this.logService.warn(`[BrowserViewDebugProxy] Rejecting WebSocket on unknown path: ${url}`);
			socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
			socket.end();
			return;
		}

		const upgraded = upgradeToISocket(req, socket, {
			debugLabel: 'browser-view-cdp-' + generateUuid(),
			enableMessageSplitting: false,
		});

		if (upgraded) {
			const sessionIndex = this.sessionCounter++;
			const client = new CDPClient(upgraded, this, sessionIndex, context, this.logService);
			this.clients.add(client);
			this.logService.debug(`[BrowserViewDebugProxy] Client connected via ${url} (browser=${context.browserAttached}, page=${context.pageAttached}, target=${context.targetId})`);
		}
	}

	private broadcastTargetCreated(targetId: string): void {
		const target = this.targets.get(targetId);
		const targetInfo = target?.getTargetInfo();
		if (!target || !targetInfo) {
			return;
		}

		for (const client of this.clients) {
			if (client.browserAttached) {
				// Include sessionId if browser session is attached
				const sessionId = client.browserAttached ? client.browserSessionId : undefined;
				client.sendEvent('Target.targetCreated', { targetInfo }, sessionId);

				// Auto-attach if enabled
				if (client.autoAttachEnabled) {
					setImmediate(() => client.autoAttachToTarget(targetId, target));
				}
			}
		}
	}

	private broadcastTargetDestroyed(targetId: string): void {
		for (const client of this.clients) {
			if (client.browserAttached) {
				// Include sessionId if browser session is attached
				const sessionId = client.browserAttached ? client.browserSessionId : undefined;
				client.sendEvent('Target.targetDestroyed', { targetId }, sessionId);
			}
		}
	}

	override dispose(): void {
		this.logService.debug('[BrowserViewDebugProxy] Disposing debug proxy service');

		for (const targetId of [...this.targets.keys()]) {
			this.unregisterTarget(targetId);
		}

		for (const client of this.clients) {
			client.close();
			client.dispose();
		}
		this.clients.clear();

		if (this.server) {
			this.server.close();
			this.server = undefined;
		}

		super.dispose();
	}
}
