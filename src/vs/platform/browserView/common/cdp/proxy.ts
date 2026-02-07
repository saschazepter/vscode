/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { CDPConnectionContext, ICDPTargetService, ICDPTarget, CDPEvent, CDPError, CDPServerError, ICDPServer } from './types.js';
import { CDPPageSession, ISessionEventSink } from './session.js';

type CDPMethodHandler = (params: unknown, sessionId?: string) => Promise<object> | object;

/**
 * Represents a CDP protocol handler that is transport-agnostic.
 * Manages browser-level session state and multiple page sessions.
 *
 * Supports two modes of operation:
 * 1. Browser connection (/devtools/browser) - Can create/manage targets, uses sessionIds
 * 2. Direct page connection (/devtools/page) - Attached to a single target, no sessionId needed
 */
export class CDPProxy extends Disposable implements ICDPServer, ISessionEventSink {

	// Browser session state
	readonly browserSessionId = `browser-session-${generateUuid()}`;
	private _browserAttached = false;
	private _autoAttach = false;

	// Named page sessions: sessionId -> CDPPageSession
	private readonly _sessions = this._register(new DisposableMap<string, CDPPageSession>());
	// targetId -> sessionId for quick lookup
	private _targetToSession = new WeakMap<ICDPTarget, string>();

	// Target cache: cdpTargetId -> ICDPTarget (populated from onTargetCreated)
	private readonly _targets = new Map<string, ICDPTarget>();

	// Default session for direct page connections (no sessionId in protocol messages)
	private _defaultSession: CDPPageSession | undefined;

	// Events to external client (ICDPServer)
	private readonly _onEvent = this._register(new Emitter<CDPEvent>());
	readonly onEvent: Event<CDPEvent> = this._onEvent.event;
	private readonly _onClose = this._register(new Emitter<void>());
	readonly onClose: Event<void> = this._onClose.event;

	// CDP method handlers map
	private readonly _handlers: Map<string, CDPMethodHandler>;

	constructor(
		context: CDPConnectionContext,
		private readonly targetService: ICDPTargetService,
		private readonly productService: IProductService,
		private readonly logService: ILogService
	) {
		super();

		// Register CDP method handlers
		this._handlers = new Map<string, CDPMethodHandler>([
			// Browser.* methods
			['Browser.getVersion', () => this.handleBrowserGetVersion()],
			['Browser.close', () => ({})],
			['Browser.setDownloadBehavior', () => ({})],
			['Browser.getWindowForTarget', () => this.handleBrowserGetWindowForTarget()],
			['Browser.setWindowBounds', () => ({})],
			// Target.* methods
			['Target.getBrowserContexts', () => this.handleTargetGetBrowserContexts()],
			['Target.createBrowserContext', () => this.handleTargetCreateBrowserContext()],
			['Target.disposeBrowserContext', (p) => this.handleTargetDisposeBrowserContext(p as { browserContextId: string })],
			['Target.attachToBrowserTarget', () => this.handleTargetAttachToBrowserTarget()],
			['Target.setAutoAttach', (p, s) => this.handleTargetSetAutoAttach(p as { autoAttach?: boolean; flatten?: boolean }, s)],
			['Target.setDiscoverTargets', (p) => this.handleTargetSetDiscoverTargets(p as { discover?: boolean })],
			['Target.getTargets', () => this.handleTargetGetTargets()],
			['Target.getTargetInfo', (p) => this.handleTargetGetTargetInfo(p as { targetId?: string } | undefined)],
			['Target.attachToTarget', (p) => this.handleTargetAttachToTarget(p as { targetId: string; flatten?: boolean })],
			['Target.createTarget', (p) => this.handleTargetCreateTarget(p as { url?: string; browserContextId?: string })],
			['Target.closeTarget', (p) => this.handleTargetCloseTarget(p as { targetId: string })],
		]);

		// Initialize session state from connection context
		if (context.browserAttached) {
			this._browserAttached = true;
		}

		// If directly connected to a page, find and attach to the target
		if (context.pageAttached && context.targetId) {
			void this.initializePageConnection(context.targetId);
		}

		// Subscribe to service target events
		this._register(this.targetService.onTargetCreated(target => this.handleTargetCreated(target)));
		this._register(this.targetService.onTargetDestroyed(target => this.handleTargetDestroyed(target)));
	}

	// #region Public API

	/**
	 * Send a CDP message and await the result.
	 */
	async sendMessage(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
		try {
			// Check for internally handled methods (Browser.* and Target.*)
			const handler = this._handlers.get(method);
			if (handler) {
				return await handler(params, sessionId);
			}

			// Stub: crashes Electron
			if (method === 'Emulation.setDeviceMetricsOverride') {
				return {};
			}

			// Route to appropriate page session
			const session = sessionId ? this._sessions.get(sessionId) : this._defaultSession;
			if (!session) {
				return {};
			}

			return session.sendCommand(method, params);
		} catch (error) {
			if (error instanceof CDPError) {
				throw error;
			}
			throw new CDPServerError(error instanceof Error ? error.message : 'Unknown error');
		}
	}

	// ISessionEventSink - receives events from page sessions
	onSessionEvent(event: CDPEvent): void {
		this._onEvent.fire(event);
	}

	override dispose(): void {
		for (const [sessionId, session] of this._sessions) {
			this.sendBrowserEvent('Target.detachedFromTarget', { sessionId, targetId: session.targetId });
		}
		this._sessions.clearAndDisposeAll();
		this._targetToSession = new WeakMap();
		this._defaultSession?.dispose();
		this._defaultSession = undefined;
		this._browserAttached = false;
		this._autoAttach = false;
		this._targets.clear();
		super.dispose();
	}

	// #endregion

	// #region CDP - Browser.*

	private handleBrowserGetVersion() {
		return {
			protocolVersion: '1.3',
			product: `${this.productService.nameShort}/${this.productService.version}`,
			revision: this.productService.commit || 'unknown',
			userAgent: 'Electron',
			jsVersion: process.versions.v8
		};
	}

	private handleBrowserGetWindowForTarget() {
		// Return a synthetic window with reasonable bounds (Playwright uses this to verify target validity)
		return {
			windowId: 1,
			bounds: { left: 0, top: 0, width: 1280, height: 720, windowState: 'normal' }
		};
	}

	// #endregion

	// #region CDP - Target.*

	private handleTargetGetBrowserContexts() {
		return { browserContextIds: this.targetService.getBrowserContexts() };
	}

	private async handleTargetCreateBrowserContext() {
		const browserContextId = await this.targetService.createBrowserContext();
		return { browserContextId };
	}

	private async handleTargetDisposeBrowserContext(params: { browserContextId: string }) {
		await this.targetService.disposeBrowserContext(params.browserContextId);
		return {};
	}

	private handleTargetAttachToBrowserTarget() {
		this._browserAttached = true;
		return { sessionId: this.browserSessionId };
	}

	private async handleTargetSetAutoAttach(params: { autoAttach?: boolean; flatten?: boolean }, sessionId?: string) {
		const { autoAttach, flatten } = params;

		if (!flatten) {
			throw new Error('This implementation only supports auto-attach with flatten=true');
		}

		this._autoAttach = autoAttach ?? false;

		// Auto-attach to existing targets when called from browser session (not from a page session)
		if (this._autoAttach && !(sessionId && this._sessions.has(sessionId))) {
			for (const target of this.targetService.getTargets()) {
				const targetInfo = await target.getTargetInfo();
				this.cacheTarget(targetInfo.targetId, target);
				this.sendBrowserEvent('Target.targetCreated', { targetInfo });

				if (!this._targetToSession.has(target)) {
					void this.attachToTarget(target);
				}
			}
		}

		return {};
	}

	private async handleTargetSetDiscoverTargets(params: { discover?: boolean }) {
		const { discover } = params;
		if (discover) {
			for (const target of this.targetService.getTargets()) {
				const targetInfo = await target.getTargetInfo();
				this.cacheTarget(targetInfo.targetId, target);
				this.sendBrowserEvent('Target.targetCreated', { targetInfo });
			}
		}
		return {};
	}

	private async handleTargetGetTargets() {
		const targetInfos = await Promise.all(
			Array.from(this.targetService.getTargets()).map(async target => {
				const info = await target.getTargetInfo();
				this.cacheTarget(info.targetId, target);
				return info;
			})
		);
		return { targetInfos };
	}

	private async handleTargetGetTargetInfo(params?: { targetId?: string }) {
		const { targetId } = params ?? {};

		// Resolve targetId: explicit > default session > first available
		const resolvedTargetId = targetId ?? this._defaultSession?.targetId ?? await this.getFirstTargetId();

		if (!resolvedTargetId) {
			// No page targets available - return browser target info
			return {
				targetInfo: {
					targetId: 'browser',
					type: 'browser',
					title: this.productService.nameShort,
					url: '',
					attached: true,
					canAccessOpener: false
				}
			};
		}

		const target = await this.resolveTarget(resolvedTargetId);
		if (!target) {
			throw new Error(`Target ${resolvedTargetId} not found`);
		}

		return { targetInfo: await target.getTargetInfo() };
	}

	private async handleTargetAttachToTarget(params: { targetId: string; flatten?: boolean }) {
		const { targetId, flatten } = params;

		if (!flatten) {
			throw new Error('This implementation only supports attachToTarget with flatten=true');
		}

		const target = this._targets.get(targetId);
		if (!target) {
			throw new Error(`Unknown target: ${targetId}`);
		}

		const sessionId = await this.attachToTarget(target);
		return { sessionId };
	}

	private async handleTargetCreateTarget(params: { url?: string; browserContextId?: string }) {
		const { url, browserContextId } = params;
		const target = await this.targetService.createTarget(url || 'about:blank', browserContextId);
		const targetInfo = await target.getTargetInfo();

		// Cache FIRST so handleTargetCreated listener skips this target
		this.cacheTarget(targetInfo.targetId, target);

		// Playwright expects: targetCreated -> attachedToTarget -> createTarget response
		// We send events explicitly here to guarantee ordering (the listener is async)
		this.sendBrowserEvent('Target.targetCreated', { targetInfo });

		if (this._autoAttach && !this._targetToSession.has(target)) {
			await this.attachToTarget(target);
		}
		return { targetId: targetInfo.targetId };
	}

	private handleTargetCloseTarget(params: { targetId: string }) {
		const { targetId } = params;

		if (!this._targets.has(targetId)) {
			return { success: false };
		}

		// Dispose session FIRST - emits Target.detachedFromTarget
		const target = this._targets.get(targetId);
		const sessionId = target ? this._targetToSession.get(target) : undefined;
		if (sessionId) {
			this.disposeSession(sessionId, targetId);
		}

		// THEN close the target - emits Target.targetDestroyed
		void this.targetService.closeTarget(targetId);

		return { success: true };
	}

	// #endregion

	// #region Internal Helpers

	/** Cache a target by its CDP targetId */
	private cacheTarget(targetId: string, target: ICDPTarget): void {
		this._targets.set(targetId, target);
	}

	/** Resolve a target by ID, searching and caching if not found */
	private async resolveTarget(targetId: string): Promise<ICDPTarget | undefined> {
		let target = this._targets.get(targetId);
		if (target) {
			return target;
		}

		// Cache miss - search through all targets from the service
		for (const serviceTarget of this.targetService.getTargets()) {
			const info = await serviceTarget.getTargetInfo();
			this.cacheTarget(info.targetId, serviceTarget);
			if (info.targetId === targetId) {
				target = serviceTarget;
			}
		}

		return target;
	}

	/** Get the first available target ID, if any */
	private async getFirstTargetId(): Promise<string | undefined> {
		const firstTarget = this.targetService.getTargets().next().value;
		return firstTarget ? (await firstTarget.getTargetInfo()).targetId : undefined;
	}

	/** Send an event to the browser session (if attached) */
	private sendBrowserEvent(method: string, params: unknown): void {
		if (this._browserAttached) {
			this._onEvent.fire({ method, params });
		}
	}

	/** Dispose a session and emit the detached event (idempotent) */
	private disposeSession(sessionId: string, targetId: string): void {
		if (!this._sessions.has(sessionId)) {
			return; // Already disposed
		}
		this.sendBrowserEvent('Target.detachedFromTarget', { sessionId, targetId });
		this._sessions.deleteAndDispose(sessionId);
	}

	/** Initialize a direct page connection by finding the target */
	private async initializePageConnection(targetId: string): Promise<void> {
		const target = await this.resolveTarget(targetId);
		if (target) {
			this._defaultSession = new CDPPageSession('', targetId, target, this);
			await this._defaultSession.attach();
		} else {
			this.logService.warn(`[CDPProxy] Target ${targetId} not found for page connection`);
		}
	}

	/** Attach to a target, creating a named session */
	private async attachToTarget(target: ICDPTarget): Promise<string> {
		if (this._targetToSession.has(target)) {
			return this._targetToSession.get(target)!;
		}
		const sessionId = generateUuid();
		this._targetToSession.set(target, sessionId);

		const targetInfo = await target.getTargetInfo();
		const session = new CDPPageSession(sessionId, targetInfo.targetId, target, this);
		this._sessions.set(sessionId, session);

		await session.attach();

		this.sendBrowserEvent('Target.attachedToTarget', {
			sessionId,
			targetInfo: { ...targetInfo, attached: true },
			waitingForDebugger: false
		});

		return sessionId;
	}

	/** Handle target created event from service */
	private handleTargetCreated(target: ICDPTarget): void {
		if (!this._browserAttached) {
			return;
		}

		void target.getTargetInfo().then(targetInfo => {
			// Skip if already cached (handleTargetCreateTarget already handled this target)
			if (this._targets.has(targetInfo.targetId)) {
				return;
			}

			this.cacheTarget(targetInfo.targetId, target);
			this.sendBrowserEvent('Target.targetCreated', { targetInfo });

			if (this._autoAttach && !this._targetToSession.has(target)) {
				void this.attachToTarget(target);
			}
		});
	}

	/** Handle target destroyed event from service */
	private handleTargetDestroyed(target: ICDPTarget): void {
		void target.getTargetInfo().then(targetInfo => {
			const targetId = targetInfo.targetId;

			// Clean up session FIRST (CDP clients expect detachedFromTarget before targetDestroyed)
			const sessionId = this._targetToSession.get(target);
			if (sessionId) {
				this.disposeSession(sessionId, targetId);
			}

			// Clean up default session if it was for this target
			if (this._defaultSession?.targetId === targetId) {
				this._defaultSession.dispose();
				this._defaultSession = undefined;
			}

			this._targets.delete(targetId);

			if (this._browserAttached) {
				this.sendBrowserEvent('Target.targetDestroyed', { targetId });
			}
		});
	}

	// #endregion
}
