/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { CDPRequest, CDPResponse, CDPConnectionContext, ICDPService, ICDPDebugTarget, ICDPDebuggerClient, CDPCommand, CDPEvent } from './types.js';

/**
 * Represents a CDP protocol handler that is transport-agnostic.
 * Combines protocol handling with session state management.
 */
export class CDPProxy extends Disposable implements ICDPDebuggerClient {
	private _disposed = false;

	// Session state
	readonly browserSessionId: string;
	private _pageSessionId: string = '';
	private _browserAttached = false;
	private _pageAttached = false;
	private _autoAttach = false;
	private _waitForDebuggerOnStart = false;
	private _autoAttachFlatten = false;
	private _targetId: string = '';
	private _targetAttachment: IDisposable | undefined;

	private readonly _onMessage = this._register(new Emitter<object>());
	/**
	 * Event fired when the proxy wants to send a message to the client.
	 * The transport layer should serialize this as JSON and send it.
	 */
	readonly onMessage: Event<object> = this._onMessage.event;

	private readonly _onClose = this._register(new Emitter<void>());
	/**
	 * Event fired when the proxy wants to close the connection.
	 */
	readonly onClose: Event<void> = this._onClose.event;

	private readonly _onCommand = this._register(new Emitter<CDPCommand>());
	/**
	 * Event fired when the proxy wants to send a CDP command to the target.
	 * The target subscribes to this during attach().
	 */
	readonly onCommand: Event<CDPCommand> = this._onCommand.event;

	constructor(
		private readonly service: ICDPService,
		private readonly productService: IProductService,
		context: CDPConnectionContext,
		private readonly logService: ILogService
	) {
		super();

		this.browserSessionId = `browser-session-${generateUuid()}`;

		// Initialize session state from connection context
		if (context.browserAttached) {
			this.attachToBrowser();
		}
		if (context.targetId) {
			this._targetId = context.targetId;
		}

		// If directly connected to a page, register with the target asynchronously
		if (context.pageAttached && context.targetId) {
			const target = this.service.getTarget(context.targetId);
			if (target) {
				target.attach(this).then(attachment => {
					this._targetAttachment = attachment;
					this.setPageAttached(context.targetId);
					this.logService.debug(`[CDPProxySession] Direct page connection to target ${context.targetId}`);
				}).catch(error => {
					this.logService.error(`[CDPProxySession] Failed to attach to target ${context.targetId}:`, error);
				});
			}
		}

		// Subscribe to service target events
		this._register(this.service.onTargetCreated(target => this.handleTargetCreated(target)));
		this._register(this.service.onTargetDestroyed(targetId => this.handleTargetDestroyed(targetId)));
	}

	// Session state getters
	get targetId(): string {
		return this._targetId;
	}

	set targetId(value: string) {
		this._targetId = value;
	}

	get browserAttached(): boolean {
		return this._browserAttached;
	}

	get pageAttached(): boolean {
		return this._pageAttached;
	}

	get pageSessionId(): string {
		return this._pageSessionId;
	}

	get autoAttachEnabled(): boolean {
		return this._autoAttach && this._autoAttachFlatten;
	}

	get waitForDebuggerOnStart(): boolean {
		return this._waitForDebuggerOnStart;
	}

	// Session state management
	attachToBrowser(): void {
		this._browserAttached = true;
		this.logService.debug(`[CDPProxySession] Browser attached: ${this.browserSessionId}`);
	}

	private setPageAttached(targetId: string): string {
		this._pageSessionId = `page-session-${targetId}`;
		this._pageAttached = true;
		this.logService.debug(`[CDPProxySession] Page attached: ${this._pageSessionId} (target: ${targetId})`);
		return this._pageSessionId;
	}

	enableAutoAttach(waitForDebuggerOnStart: boolean, flatten: boolean, sessionId?: string): void {
		this._autoAttach = true;
		this._waitForDebuggerOnStart = waitForDebuggerOnStart;
		this._autoAttachFlatten = flatten;
		this.logService.debug(`[CDPProxySession] Auto-attach enabled (waitForDebugger: ${waitForDebuggerOnStart}, flatten: ${flatten})`);

		// Only auto-attach to existing targets when called from browser session (not page session)
		const isPageSession = sessionId?.startsWith('page-session-');
		if (flatten && !isPageSession && !this.pageAttached) {
			setImmediate(() => {
				for (const target of this.service.getTargets()) {
					const targetInfo = target.getTargetInfo();
					// Send targetCreated first
					this.sendEvent('Target.targetCreated', { targetInfo }, sessionId);

					// Then auto-attach if not already attached
					if (!this.pageAttached) {
						this.attachToPageTarget(targetInfo.targetId);
					}
				}
			});
		}
	}

	disableAutoAttach(): void {
		this._autoAttach = false;
		this._waitForDebuggerOnStart = false;
		this._autoAttachFlatten = false;
		this.logService.debug(`[CDPProxySession] Auto-attach disabled`);
	}

	enableTargetDiscovery(): void {
		this.logService.debug(`[CDPProxySession] Target discovery enabled`);

		setImmediate(() => {
			for (const target of this.service.getTargets()) {
				const targetInfo = target.getTargetInfo();
				this.sendEvent('Target.targetCreated', { targetInfo }, this.browserSessionId);
			}
		});
	}

	disableTargetDiscovery(): void {
		this.logService.debug(`[CDPProxySession] Target discovery disabled`);
	}

	/**
	 * Handle an incoming CDP message from the transport layer.
	 * Call this when you receive a parsed JSON message.
	 */
	handleMessage(message: CDPRequest): void {
		this.logService.debug(`[CDPProxySession] >>> ${JSON.stringify(message)}`);

		if (this.shouldHandleRequestInternally(message)) {
			this.handleRequestInternally(message)
				.then(result => {
					if (result) {
						this.sendResponse(message.id, result ?? {}, message.sessionId);
					} else {
						this.sendError(message.id, -32601, 'Method not found', message.sessionId);
					}
				})
				.catch(error => this.sendError(message.id, -32000, error.message || 'Unknown error', message.sessionId));
			return;
		}

		// All other commands need to be routed to a page session
		if (message.sessionId?.startsWith('page-session-')) {
			const targetId = message.sessionId.replace('page-session-', '');
			this.handlePageSessionCommand(message, targetId);
		} else if (this._pageAttached && this._targetId) {
			// If we're attached to a page, forward commands there
			this.forwardToDebugger(message, this._targetId, message.sessionId);
		} else {
			// No page attached, return empty response
			this.logService.warn(`[CDPProxySession] No page session for ${message.method}, sessionId=${message.sessionId}`);
			this.sendResponse(message.id, {}, message.sessionId);
		}
	}

	/**
	 * Notify the proxy that the transport has disconnected.
	 * Call this when the underlying connection closes.
	 */
	handleDisconnect(): void {
		this.logService.debug('[CDPProxySession] Transport disconnected');
		// Detach from any target
		this._targetAttachment?.dispose();
		this.reset();
	}

	/**
	 * Reset session state
	 */
	private reset(): void {
		this._browserAttached = false;
		this._pageAttached = false;
		this._pageSessionId = '';
		this._targetId = '';
		this._targetAttachment = undefined;
		this._autoAttach = false;
		this._waitForDebuggerOnStart = false;
		this._autoAttachFlatten = false;
		this.logService.debug(`[CDPProxySession] Session reset: ${this.browserSessionId}`);
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

		this._onCommand.fire({
			method: message.method,
			params: message.params,
			resolve: (result) => {
				this.logService.debug(`[CDPProxySession] <- ${message.method} response for ${targetId}`);
				this.sendResponse(message.id, result ?? {}, pageSessionId);
			},
			reject: (error) => {
				this.logService.error(`[CDPProxySession] <- ${message.method} error for ${targetId}:`, error);
				this.sendError(message.id, -32000, error.message || 'Unknown error', pageSessionId);
			}
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

		this._onCommand.fire({
			method: message.method,
			params: message.params,
			resolve: (result) => this.sendResponse(message.id, result ?? {}, sessionId),
			reject: (error) => {
				this.logService.error(`[CDPProxySession] <- ${message.method} error:`, error);
				this.sendError(message.id, -32000, error.message || 'Unknown error', sessionId);
			}
		});
	}

	/**
	 * Handle target created event from service
	 */
	private handleTargetCreated(target: ICDPDebugTarget): void {
		if (this._browserAttached) {
			const targetInfo = target.getTargetInfo();
			this.sendEvent('Target.targetCreated', { targetInfo }, this.browserSessionId);

			// Auto-attach if enabled
			if (this.autoAttachEnabled) {
				setImmediate(() => {
					this.autoAttachToTarget(targetInfo.targetId, target);
				});
			}
		}
	}

	/**
	 * Handle target destroyed event from service
	 */
	private handleTargetDestroyed(targetId: string): void {
		if (this._browserAttached) {
			this.sendEvent('Target.targetDestroyed', { targetId }, this.browserSessionId);
		}

		// If our attached target was destroyed, close the connection
		if (this._pageAttached && this._targetId === targetId) {
			this.close();
		}
	}

	/**
	 * Attach to a page target (called from TargetDomain)
	 */
	attachToPageTarget(targetId: string): string {
		const target = this.service.getTarget(targetId);
		if (!target) {
			throw new Error(`Unknown target: ${targetId}`);
		}

		this._targetId = targetId;
		const pageSessionId = this.setPageAttached(targetId);
		void target.attach(this).then(attachment => {
			this._targetAttachment = attachment;
			const info = target.getTargetInfo();
			// Send attachedToTarget on the browser session (parent), not the page session
			const browserSessionId = this._browserAttached ? this.browserSessionId : undefined;
			this.sendEvent('Target.attachedToTarget', {
				sessionId: pageSessionId,
				targetInfo: { ...info, attached: true },
				waitingForDebugger: false
			}, browserSessionId);
		});
		return pageSessionId;
	}

	/**
	 * Auto-attach to a target if autoAttach is enabled and not already attached to a page.
	 */
	async autoAttachToTarget(targetId: string, target: ICDPDebugTarget): Promise<void> {
		if (!this.autoAttachEnabled || this._pageAttached) {
			return;
		}

		this._targetId = targetId;
		this._targetAttachment = await target.attach(this);
		this.setPageAttached(targetId);

		const pageSessionId = this._pageSessionId;
		const targetInfo = target.getTargetInfo();

		// Send attachedToTarget event on the browser session (if attached)
		const browserSessionId = this._browserAttached ? this.browserSessionId : undefined;
		this.sendEvent('Target.attachedToTarget', {
			sessionId: pageSessionId,
			targetInfo: { ...targetInfo, attached: true },
			waitingForDebugger: this._waitForDebuggerOnStart
		}, browserSessionId);
		this.logService.debug(`[CDPProxySession] Auto-attached to target ${targetId}`);
	}

	/**
	 * Send a CDP response to the client
	 */
	sendResponse(id: number, result: unknown, sessionId?: string): void {
		const response: CDPResponse & { sessionId?: string } = { id, result };
		if (sessionId) {
			response.sessionId = sessionId;
		}
		this.logService.debug(`[CDPProxySession] <<< Response id=${id}${sessionId ? ` session=${sessionId}` : ''}: ${JSON.stringify(result)}`);
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
		this.logService.debug(`[CDPProxySession] <<< Error id=${id}${sessionId ? ` session=${sessionId}` : ''}: code=${code} message=${message}`);
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
		this.logService.debug(`[CDPProxySession] <<< Event ${method}${sessionId ? ` session=${sessionId}` : ''}: ${JSON.stringify(params)}`);
		this.send(event);
	}

	/**
	 * Handle a debugger event from Electron.
	 * Routes events to the appropriate CDP session.
	 */
	handleEvent({ method, params }: CDPEvent): void {
		// Target.detachedFromTarget goes to browser session - use internal targetId
		if (method === 'Target.detachedFromTarget') {
			if (this._browserAttached && this._targetId) {
				this.sendEvent('Target.detachedFromTarget', {
					sessionId: this._pageSessionId,
					targetId: this._targetId
				}, this.browserSessionId);
			}
			return;
		}

		// We dispatch all other Target.* events internally.
		if (method.startsWith('Target.')) {
			return;
		}

		// All other events go to the page session
		if (this._pageAttached) {
			this.sendEvent(method, params, this._pageSessionId);
		}
	}

	private shouldHandleRequestInternally(message: CDPRequest): boolean {
		return message.method.startsWith('Browser.') || message.method.startsWith('Target.');
	}

	private async handleRequestInternally(message: CDPRequest): Promise<object | undefined> {
		const { method, params } = message;
		switch (method) {
			case 'Browser.getVersion':
				return {
					protocolVersion: '1.3',
					product: `${this.productService.nameShort}/${this.productService.version}`,
					revision: this.productService.commit || 'unknown',
					userAgent: 'Electron',
					jsVersion: process.versions.v8
				};

			case 'Browser.close':
				// We don't actually close the browser, just acknowledge
				return {};

			case 'Target.getBrowserContexts':
				return { browserContextIds: [] };

			case 'Target.attachToBrowserTarget':
				this.attachToBrowser();
				// Set the initial target ID to the first available target
				this.targetId = this.service.getTargets().next().value?.id || 'default';
				return { sessionId: this.browserSessionId };

			case 'Target.setAutoAttach': {
				const autoAttachParams = params as { autoAttach?: boolean; waitForDebuggerOnStart?: boolean; flatten?: boolean };
				const autoAttach = autoAttachParams?.autoAttach ?? false;
				const waitForDebuggerOnStart = autoAttachParams?.waitForDebuggerOnStart ?? false;
				const flatten = autoAttachParams?.flatten ?? false;

				if (autoAttach) {
					this.enableAutoAttach(waitForDebuggerOnStart, flatten, message.sessionId);
				} else {
					this.disableAutoAttach();
				}
				return {};
			}

			case 'Target.setDiscoverTargets': {
				const discoverParams = params as { discover?: boolean };
				if (discoverParams?.discover) {
					this.enableTargetDiscovery();
				} else {
					this.disableTargetDiscovery();
				}
				return {};
			}

			case 'Target.getTargets': {
				const targets = Array.from(this.service.getTargets());
				const targetInfos = targets.map(target => target.getTargetInfo());
				return { targetInfos };
			}

			case 'Target.attachToTarget': {
				const attachParams = params as { targetId: string; flatten?: boolean };

				const pageSessionId = this.attachToPageTarget(attachParams.targetId);
				return { sessionId: pageSessionId };
			}

			case 'Target.createTarget': {
				const createParams = params as { url?: string; browserContextId?: string };
				const url = createParams.url || 'about:blank';

				const { targetId } = await this.service.createTarget(url);
				return { targetId };
			}

			case 'Target.closeTarget': {
				const closeParams = params as { targetId: string };
				const targetId = closeParams.targetId;

				// Check if target exists first
				if (!this.service.getTarget(targetId)) {
					return { success: false };
				}

				// Close the target on next tick so response is sent before cleanup
				// The cleanup process fires events that disconnect the transport
				setImmediate(() => void this.service.closeTarget(targetId));

				return { success: true };
			}

			default:
				return undefined;
		}
	}

	/**
	 * Request to close the connection.
	 * The transport layer should listen to `onClose` and close the underlying connection.
	 */
	close(): void {
		this._onClose.fire();
	}

	/**
	 * Emit a message to the transport layer
	 */
	private send(data: object): void {
		if (!this._disposed) {
			this._onMessage.fire(data);
		}
	}

	override dispose(): void {
		this._disposed = true;
		this.handleDisconnect();
		super.dispose();
	}
}
