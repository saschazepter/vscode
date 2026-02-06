/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { createServer, Server as HttpServer, IncomingMessage } from 'http';
import { AddressInfo, Socket } from 'net';
import { IBrowserViewDebugInfo } from '../common/browserView.js';
import { upgradeToISocket } from '../../../base/parts/ipc/node/ipc.net.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { CDPProxy } from '../common/cdp/proxy.js';
import { CDPConnectionContext, CDPRequest, ICDPService } from '../common/cdp/types.js';
import { IProductService } from '../../product/common/productService.js';

/**
 * WebSocket server that provides CDP debugging for browser views.
 */
export class BrowserViewCDPProxyServer extends Disposable {
	private server: HttpServer | undefined;
	private port: number | undefined;
	private readonly browserId: string;

	constructor(
		private readonly service: ICDPService,
		private readonly productService: IProductService,
		private readonly logService: ILogService
	) {
		super();
		this.browserId = generateUuid();
	}

	async ensureStarted(): Promise<IBrowserViewDebugInfo> {
		await this.ensureServerStarted();
		return this.getDebugInfo()!;
	}

	getDebugInfo(): IBrowserViewDebugInfo | undefined {
		if (!this.port) {
			return undefined;
		}

		return {
			port: this.port,
			webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}`
		};
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

		this.logService.debug(`[BrowserViewDebugProxy] Started debug proxy on port ${this.port}`);
		this.logService.debug(`[BrowserViewDebugProxy] Target list available at: http://127.0.0.1:${this.port}/json`);
	}

	private handleHttpRequest(req: IncomingMessage, res: import('http').ServerResponse): void {
		this.logService.debug(`[BrowserViewDebugProxy] HTTP request: ${req.method} ${req.url}`);

		if (req.url === '/json' || req.url === '/json/list') {
			this.getTargetListForHttp().then(targets => {
				this.logService.debug(`[BrowserViewDebugProxy] Returning ${targets.length} targets`);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(targets));
			}).catch(error => {
				this.logService.error(`[BrowserViewDebugProxy] Error getting target list:`, error);
				res.writeHead(500);
				res.end();
			});
		} else if (req.url === '/json/version') {
			// This format is what Puppeteer expects when connecting via browserURL
			// The webSocketDebuggerUrl must be a browser target URL (not a page target)
			const version = {
				'Browser': `${this.productService.nameShort}/${this.productService.version}`,
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

	private async getTargetListForHttp(): Promise<Array<{
		id: string;
		type: string;
		title: string;
		url: string;
		webSocketDebuggerUrl: string;
		devtoolsFrontendUrl: string;
		faviconUrl: string;
	}>> {
		const targets: Array<{
			id: string;
			type: string;
			title: string;
			url: string;
			webSocketDebuggerUrl: string;
			devtoolsFrontendUrl: string;
			faviconUrl: string;
		}> = [];

		for (const target of this.service.getTargets()) {
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
			const firstTargetId = this.service.getTargets().next().value?.getTargetInfo().targetId || 'default';
			return {
				browserAttached: true,
				pageAttached: false,
				targetId: firstTargetId
			};
		}

		if (pageMatch) {
			// Direct page connection - immediately attached to a specific target
			const targetId = pageMatch[1];
			// Target validation happens in CDPProxy.findTargetByRealId
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
			const client = new CDPProxy(this.service, this.productService, context, this.logService);

			// Wire socket to CDPProxy - using a disposable store for cleanup
			const socketDisposables = new DisposableStore();

			// Socket -> CDPProxy: parse JSON and call handleMessage
			socketDisposables.add(upgraded.onData((rawData: VSBuffer) => {
				try {
					const message = JSON.parse(rawData.toString()) as CDPRequest;
					client.handleMessage(message);
				} catch (error) {
					this.logService.error('[BrowserViewDebugProxy] Error parsing message:', error);
				}
			}));

			// CDPProxy -> Socket: serialize JSON and write
			socketDisposables.add(client.onMessage((data: object) => {
				upgraded.write(VSBuffer.fromString(JSON.stringify(data)));
			}));

			// CDPProxy wants to close -> close socket
			socketDisposables.add(client.onClose(() => {
				upgraded.end();
			}));

			// Socket closed -> cleanup
			socketDisposables.add(upgraded.onClose(() => {
				this.logService.debug('[BrowserViewDebugProxy] Client disconnected');
				client.handleDisconnect();
				client.dispose();
				socketDisposables.dispose();
			}));

			// Make sure socket is disposed when service is disposed
			this._register(socketDisposables);
			this._register(upgraded);

			this.logService.debug(`[BrowserViewDebugProxy] Client connected via ${url} (browser=${context.browserAttached}, page=${context.pageAttached}, target=${context.targetId})`);
		}
	}

	override dispose(): void {
		this.logService.debug('[BrowserViewDebugProxy] Disposing debug proxy');

		if (this.server) {
			this.server.close();
			this.server = undefined;
		}

		super.dispose();
	}
}
