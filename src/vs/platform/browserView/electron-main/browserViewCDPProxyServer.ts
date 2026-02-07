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
import { CDPConnectionContext, CDPEvent, CDPRequest, CDPError, CDPErrorCode, ICDPTargetService } from '../common/cdp/types.js';
import { IProductService } from '../../product/common/productService.js';

/**
 * WebSocket server that provides CDP debugging for browser views.
 */
export class BrowserViewCDPProxyServer extends Disposable {
	private server: HttpServer | undefined;
	private port: number | undefined;
	private readonly browserId: string;

	constructor(
		private readonly targetService: ICDPTargetService,
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
			// Listen on all interfaces (both IPv4 and IPv6) for localhost connections
			this.server!.listen(54000, () => resolve());
			this.server!.once('error', reject);
		});

		const address = this.server.address() as AddressInfo;
		this.port = address.port;

		this.server.on('request', (req, res) => this.handleHttpRequest(req, res));
		this.server.on('upgrade', (req: IncomingMessage, socket: Socket) => this.handleWebSocketUpgrade(req, socket));
	}

	private handleHttpRequest(req: IncomingMessage, res: import('http').ServerResponse): void {
		// Normalize URL by removing trailing slash
		const url = req.url?.replace(/\/$/, '') || '';

		if (url === '/json' || url === '/json/list') {
			this.getTargetListForHttp().then(targets => {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(targets));
			}).catch(error => {
				this.logService.error(`[BrowserViewDebugProxy] Error getting target list:`, error);
				res.writeHead(500);
				res.end();
			});
		} else if (url === '/json/version') {
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

		for (const target of this.targetService.getTargets()) {
			const { targetId, ...info } = await target.getTargetInfo();
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
			// No need to resolve a specific targetId - browser connections manage all targets
			return {
				browserAttached: true,
				pageAttached: false,
				targetId: ''
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

		const context = this.parseConnectionContext(url);
		if (!context) {
			this.logService.warn(`[BrowserViewDebugProxy] Rejecting WebSocket on unknown path: ${url}`);
			socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
			socket.end();
			return;
		}

		this.logService.debug(`[BrowserViewDebugProxy] WebSocket connected: ${url}`);

		const upgraded = upgradeToISocket(req, socket, {
			debugLabel: 'browser-view-cdp-' + generateUuid(),
			enableMessageSplitting: false,
		});

		if (upgraded) {
			const client = new CDPProxy(context, this.targetService, this.productService, this.logService);

			// Wire socket to CDPProxy - using a disposable store for cleanup
			const socketDisposables = new DisposableStore();

			// Socket -> CDPProxy: parse JSON, call sendMessage, send response/error
			socketDisposables.add(upgraded.onData((rawData: VSBuffer) => {
				try {
					const message = rawData.toString();
					const { id, method, params, sessionId } = JSON.parse(message) as CDPRequest;
					this.logService.debug(`[BrowserViewDebugProxy] <- ${message}`);
					client.sendMessage(method, params, sessionId)
						.then(result => {
							const response = { id, result, sessionId };
							const responseStr = JSON.stringify(response);
							this.logService.debug(`[BrowserViewDebugProxy] -> ${responseStr}`);
							upgraded.write(VSBuffer.fromString(responseStr));
						})
						.catch(error => {
							const response = {
								id,
								error: {
									code: error instanceof CDPError ? error.code : CDPErrorCode.ServerError,
									message: error.message || 'Unknown error'
								},
								sessionId
							};
							const responseStr = JSON.stringify(response);
							this.logService.debug(`[BrowserViewDebugProxy] -> ${responseStr}`);
							upgraded.write(VSBuffer.fromString(responseStr));
						});
				} catch (error) {
					this.logService.error('[BrowserViewDebugProxy] Error parsing message:', error);
				}
			}));

			// CDPProxy -> Socket: serialize events and write
			socketDisposables.add(client.onEvent((event: CDPEvent) => {
				const eventStr = JSON.stringify(event);
				this.logService.debug(`[BrowserViewDebugProxy] -> ${eventStr}`);
				upgraded.write(VSBuffer.fromString(eventStr));
			}));

			// CDPProxy wants to close -> close socket
			socketDisposables.add(client.onClose(() => {
				this.logService.debug(`[BrowserViewDebugProxy] WebSocket closing`);
				upgraded.end();
			}));

			// Socket closed -> cleanup
			socketDisposables.add(upgraded.onClose(() => {
				this.logService.debug(`[BrowserViewDebugProxy] WebSocket closed`);
				client.dispose();
				socketDisposables.dispose();
			}));

			// Make sure socket is disposed when service is disposed
			this._register(socketDisposables);
			this._register(upgraded);
		}
	}

	override dispose(): void {
		if (this.server) {
			this.server.close();
			this.server = undefined;
		}

		super.dispose();
	}
}
