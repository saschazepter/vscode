/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISocket } from '../../../../base/parts/ipc/common/ipc.net.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ILogService } from '../../../log/common/log.js';
import { CDPSession } from './cdpSession.js';
import { DebugTarget, CDPClientLike } from './debugTarget.js';
import { CDPRequest, CDPResponse, CDPConnectionContext, ICDPService, ICDPClient } from './types.js';
import { hasCDPDomain, handleCDPMethod } from './domains/index.js';

// Import domains to register them
import './domains/browserDomain.js';
import './domains/targetDomain.js';

/**
 * Callback interface for service-level operations from CDPClient
 */
export interface ICDPClientServiceCallback extends ICDPService {
	/**
	 * Handle client disconnection
	 */
	handleClientDisconnected(client: CDPClient): void;
}

/**
 * Represents a WebSocket client connection to the debug proxy.
 * Handles CDP protocol communication with the debug client.
 */
export class CDPClient extends Disposable implements CDPClientLike, ICDPClient {
	private readonly session: CDPSession;
	private _disposed = false;

	constructor(
		private readonly socket: ISocket,
		private readonly service: ICDPClientServiceCallback,
		sessionIndex: number,
		context: CDPConnectionContext,
		private readonly logService: ILogService
	) {
		super();
		this._register(socket);

		this.session = new CDPSession(sessionIndex, logService);

		// Initialize session state from connection context
		if (context.browserAttached) {
			this.session.attachToBrowser();
		}
		if (context.targetId) {
			this.session.targetId = context.targetId;
		}

		// If directly connected to a page, register with the target
		if (context.pageAttached && context.targetId) {
			const target = this.service.getTarget(context.targetId);
			if (target) {
				target.addClient(this);
				this.session.attachToPage(context.targetId);
				this.logService.debug(`[CDP] Direct page connection to target ${context.targetId}`);
			}
		}

		this.setupSocket();
	}

	// Public getters - delegate to session for CDP state
	get targetId(): string {
		return this.session.targetId;
	}

	get browserAttached(): boolean {
		return this.session.browserAttached;
	}

	get browserSessionId(): string {
		return this.session.browserSessionId;
	}

	get autoAttachEnabled(): boolean {
		return this.session.autoAttachEnabled;
	}

	// CDPClientLike interface implementation
	get pageAttached(): boolean {
		return this.session.pageAttached;
	}

	get pageSessionId(): string {
		return this.session.pageSessionId;
	}

	// ITargetDomainClient implementation
	getSession(): CDPSession {
		return this.session;
	}

	/**
	 * Set up ISocket message and close handlers
	 */
	private setupSocket(): void {
		this._register(this.socket.onData((rawData: VSBuffer) => {
			try {
				const messageStr = rawData.toString();
				this.logService.debug(`[CDP] >>> ${messageStr}`);
				const message = JSON.parse(messageStr) as CDPRequest;
				this.handleMessage(message);
			} catch (error) {
				this.logService.error('[CDP] Error parsing message:', error);
			}
		}));

		this._register(this.socket.onClose(() => {
			this.logService.debug('[CDP] Client disconnected');
			this.service.handleClientDisconnected(this);
		}));
	}

	/**
	 * Handle an incoming CDP message from the client
	 */
	private handleMessage(message: CDPRequest): void {
		// Check if we have a domain handler for this method
		const [domainName] = message.method.split('.');
		if (hasCDPDomain(domainName)) {
			this.handleDomainCommand(message);
			return;
		}

		// All other commands need to be routed to a page session
		if (message.sessionId?.startsWith('page-session-')) {
			const targetId = message.sessionId.replace('page-session-', '');
			this.handlePageSessionCommand(message, targetId);
		} else if (this.session.pageAttached && this.session.targetId) {
			// If we're attached to a page, forward commands there
			this.forwardToDebugger(message, this.session.targetId, message.sessionId);
		} else {
			// No page attached, return empty response
			this.logService.warn(`[CDP] No page session for ${message.method}, sessionId=${message.sessionId}`);
			this.sendResponse(message.id, {}, message.sessionId);
		}
	}

	/**
	 * Handle commands through a registered domain handler
	 */
	private handleDomainCommand(message: CDPRequest): void {
		const context = {
			sessionId: message.sessionId,
			client: this,
			service: this.service
		};

		handleCDPMethod(message.method, message.params, context)
			.then(result => {
				if (result.error) {
					this.sendError(message.id, result.error.code, result.error.message, message.sessionId);
				} else {
					this.sendResponse(message.id, result.result ?? {}, message.sessionId);
				}
			})
			.catch(error => {
				this.sendError(message.id, -32000, error.message || 'Unknown error', message.sessionId);
			});
	}

	/**
	 * Handle page session commands by forwarding to the debugger
	 */
	private handlePageSessionCommand(message: CDPRequest, targetId: string): void {
		const pageSessionId = `page-session-${targetId}`;
		const target = this.service.getTarget(targetId);

		if (!target) {
			this.sendError(message.id, -32000, `Target ${targetId} not found`, pageSessionId);
			return;
		}

		target.sendCommand(message.method, message.params)
			.then((result) => {
				this.logService.debug(`[CDP] <- ${message.method} response for ${targetId}`);
				this.sendResponse(message.id, result ?? {}, pageSessionId);
			})
			.catch((error) => {
				this.logService.error(`[CDP] <- ${message.method} error for ${targetId}:`, error);
				this.sendError(message.id, -32000, (error as Error).message || 'Unknown error', pageSessionId);
			});
	}

	/**
	 * Forward a command to the debugger
	 */
	private forwardToDebugger(message: CDPRequest, targetId: string, sessionId?: string): void {
		const target = this.service.getTarget(targetId);
		if (!target) {
			this.sendError(message.id, -32000, `Target ${targetId} not found`, sessionId);
			return;
		}

		target.sendCommand(message.method, message.params)
			.then((result) => this.sendResponse(message.id, result ?? {}, sessionId))
			.catch((error) => {
				this.logService.error(`[CDP] <- ${message.method} error:`, error);
				this.sendError(message.id, -32000, error.message || 'Unknown error', sessionId);
			});
	}

	/**
	 * Attach to a page target (called from TargetDomain)
	 */
	attachToPageTarget(targetId: string, target: DebugTarget): string {
		this.session.targetId = targetId;
		target.addClient(this);
		return this.session.attachToPage(targetId);
	}

	/**
	 * Auto-attach to a target if autoAttach is enabled and not already attached to a page.
	 */
	autoAttachToTarget(targetId: string, target: DebugTarget): void {
		if (!this.session.autoAttachEnabled || this.session.pageAttached) {
			return;
		}

		this.session.targetId = targetId;
		target.addClient(this);
		this.session.attachToPage(targetId);

		const pageSessionId = this.session.pageSessionId;
		const targetInfo = target.getTargetInfo();

		// Send attachedToTarget event on the browser session (if attached)
		const browserSessionId = this.session.browserAttached ? this.browserSessionId : undefined;
		this.sendEvent('Target.attachedToTarget', {
			sessionId: pageSessionId,
			targetInfo: targetInfo ? { ...targetInfo, attached: true } : { targetId, type: 'page', title: 'Browser View', url: 'about:blank', attached: true, canAccessOpener: false },
			waitingForDebugger: this.session.waitForDebuggerOnStart
		}, browserSessionId);
		this.logService.debug(`[CDP] Auto-attached to target ${targetId}`);
	}

	/**
	 * Send a CDP response to the client
	 */
	sendResponse(id: number, result: unknown, sessionId?: string): void {
		const response: CDPResponse & { sessionId?: string } = { id, result };
		if (sessionId) {
			response.sessionId = sessionId;
		}
		this.logService.debug(`[CDP] <<< Response id=${id}${sessionId ? ` session=${sessionId}` : ''}: ${JSON.stringify(result)}`);
		this.send(response);
	}

	/**
	 * Send a CDP error to the client
	 */
	sendError(id: number, code: number, message: string, sessionId?: string): void {
		const response: CDPResponse & { sessionId?: string } = {
			id,
			error: { code, message }
		};
		if (sessionId) {
			response.sessionId = sessionId;
		}
		this.logService.debug(`[CDP] <<< Error id=${id}${sessionId ? ` session=${sessionId}` : ''}: code=${code} message=${message}`);
		this.send(response);
	}

	/**
	 * Send a CDP event to the client
	 */
	sendEvent(method: string, params: unknown, sessionId?: string): void {
		const event: { method: string; params: unknown; sessionId?: string } = { method, params };
		if (sessionId) {
			event.sessionId = sessionId;
		}
		this.logService.debug(`[CDP] <<< Event ${method}${sessionId ? ` session=${sessionId}` : ''}: ${JSON.stringify(params)}`);
		this.send(event);
	}

	/**
	 * Close the client connection
	 */
	close(): void {
		this.socket.end();
	}

	/**
	 * Send a message through the socket
	 */
	private send(data: object): void {
		if (!this._disposed) {
			this.socket.write(VSBuffer.fromString(JSON.stringify(data)));
		}
	}

	override dispose(): void {
		this._disposed = true;

		// Remove from any attached target
		const targetId = this.session.targetId;
		if (targetId) {
			const target = this.service.getTarget(targetId);
			if (target) {
				target.removeClient(this);
			}
		}

		this.session.reset();
		super.dispose();
	}
}
