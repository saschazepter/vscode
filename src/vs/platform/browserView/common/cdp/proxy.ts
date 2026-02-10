/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICDPTarget, CDPEvent, CDPError, CDPServerError, CDPMethodNotFoundError, CDPInvalidParamsError, ICDPConnection, CDPTargetInfo, ICDPBrowserTarget } from './types.js';

/**
 * CDP protocol handler for browser-level connections.
 * Manages Browser.* and Target.* domains, routes page-level commands
 * to the appropriate attached session by sessionId.
 */
export class CDPBrowserProxy extends Disposable implements ICDPConnection {

	// Browser session state
	readonly sessionId = `browser-session-${generateUuid()}`;
	private _autoAttach = false;

	// sessionId -> ICDPConnection (keyed by real session ID from target)
	private readonly _sessions = this._register(new DisposableMap<string, ICDPConnection>());
	// targetId -> ICDPTarget
	private readonly _targets = new Map<string, ICDPTarget>();
	// targetId -> sessionId (tracks which targets are attached)
	private readonly _targetSessions = new Map<string, string>();

	// Events to external client (ICDPConnection)
	private readonly _onEvent = this._register(new Emitter<CDPEvent>());
	readonly onEvent: Event<CDPEvent> = this._onEvent.event;
	private readonly _onClose = this._register(new Emitter<void>());
	readonly onClose: Event<void> = this._onClose.event;

	// CDP method handlers map
	private readonly _handlers = new Map<string, (params: unknown, sessionId?: string) => Promise<object> | object>([
		// Browser.* methods
		['Browser.getVersion', () => this.browserTarget.getVersion()],
		['Browser.close', () => ({})],
		['Browser.setDownloadBehavior', () => ({})],
		['Browser.getWindowForTarget', (p, s) => this.handleBrowserGetWindowForTarget(p as { targetId?: string; sessionId?: string }, s)],
		['Browser.setWindowBounds', () => ({})],
		// Target.* methods
		['Target.getBrowserContexts', () => this.handleTargetGetBrowserContexts()],
		['Target.createBrowserContext', () => this.handleTargetCreateBrowserContext()],
		['Target.disposeBrowserContext', (p) => this.handleTargetDisposeBrowserContext(p as { browserContextId: string })],
		['Target.attachToBrowserTarget', () => this.handleTargetAttachToBrowserTarget()],
		['Target.setAutoAttach', (p) => this.handleTargetSetAutoAttach(p as { autoAttach?: boolean; flatten?: boolean })],
		['Target.setDiscoverTargets', (p) => this.handleTargetSetDiscoverTargets(p as { discover?: boolean })],
		['Target.getTargets', () => this.handleTargetGetTargets()],
		['Target.getTargetInfo', (p) => this.handleTargetGetTargetInfo(p as { targetId?: string } | undefined)],
		['Target.attachToTarget', (p) => this.handleTargetAttachToTarget(p as { targetId: string; flatten?: boolean })],
		['Target.createTarget', (p) => this.handleTargetCreateTarget(p as { url?: string; browserContextId?: string })],
		['Target.closeTarget', (p) => this.handleTargetCloseTarget(p as { targetId: string })],
	]);

	constructor(
		private readonly browserTarget: ICDPBrowserTarget,
	) {
		super();

		// Subscribe to service target events
		this._register(this.browserTarget.onTargetCreated(target => this.handleTargetCreated(target)));
		this._register(this.browserTarget.onTargetDestroyed(target => this.handleTargetDestroyed(target)));
	}

	// #region Public API

	/**
	 * Send a CDP message and await the result.
	 * Browser-level handlers (Browser.*, Target.*) are checked first.
	 * Other commands are routed to the page session identified by sessionId.
	 */
	async sendMessage(method: string, params: unknown = {}, sessionId?: string): Promise<unknown> {
		try {
			// Browser-level command handling
			if (
				!sessionId ||
				sessionId === this.sessionId ||
				method.startsWith('Browser.') ||
				method.startsWith('Target.')
			) {
				const handler = this._handlers.get(method);
				if (!handler) {
					throw new CDPMethodNotFoundError(method);
				}
				return await handler(params, sessionId);
			}

			const connection = this._sessions.get(sessionId);
			if (!connection) {
				throw new CDPServerError(`Session not found: ${sessionId}`);
			}

			const result = await connection.sendMessage(method, params);
			return result ?? {};
		} catch (error) {
			if (error instanceof CDPError) {
				throw error;
			}
			throw new CDPServerError(error instanceof Error ? error.message : 'Unknown error');
		}
	}

	override dispose(): void {
		for (const [targetId, sessionId] of this._targetSessions) {
			this.sendBrowserEvent('Target.detachedFromTarget', { sessionId, targetId });
		}
		this._targetSessions.clear();
		this._targets.clear();
		super.dispose();
	}

	// #endregion

	// #region CDP Commands

	private async handleBrowserGetWindowForTarget({ targetId }: { targetId?: string }, sessionId?: string) {
		const resolvedTargetId = (sessionId && this.findTargetIdForSession(sessionId)) ?? targetId;
		if (!resolvedTargetId) {
			throw new CDPServerError('Unable to resolve target');
		}

		const target = await this.resolveTarget(resolvedTargetId);
		return this.browserTarget.getWindowForTarget(target);
	}

	private handleTargetGetBrowserContexts() {
		return { browserContextIds: this.browserTarget.getBrowserContexts() };
	}

	private async handleTargetCreateBrowserContext() {
		const browserContextId = await this.browserTarget.createBrowserContext();
		return { browserContextId };
	}

	private async handleTargetDisposeBrowserContext({ browserContextId }: { browserContextId: string }) {
		await this.browserTarget.disposeBrowserContext(browserContextId);
		return {};
	}

	private handleTargetAttachToBrowserTarget() {
		return { sessionId: this.sessionId };
	}

	private async handleTargetSetAutoAttach({ autoAttach, flatten }: { autoAttach?: boolean; flatten?: boolean }) {
		if (!flatten) {
			throw new CDPInvalidParamsError('This implementation only supports auto-attach with flatten=true');
		}

		this._autoAttach = autoAttach ?? false;

		// Auto-attach to existing targets when called from browser session (not from a page session)
		if (this._autoAttach) {
			for await (const targetInfo of this.getTargetInfos()) {
				this.sendBrowserEvent('Target.targetCreated', { targetInfo });

				if (!this._targetSessions.has(targetInfo.targetId)) {
					void this.attachToTarget(targetInfo.targetId);
				}
			}
		}

		return {};
	}

	private async handleTargetSetDiscoverTargets({ discover }: { discover?: boolean }) {
		if (discover) {
			for await (const targetInfo of this.getTargetInfos()) {
				this.sendBrowserEvent('Target.targetCreated', { targetInfo });
			}
		}
		return {};
	}

	private async handleTargetGetTargets() {
		const targetInfos: CDPTargetInfo[] = [];
		for await (const info of this.getTargetInfos()) {
			targetInfos.push(info);
		}
		return { targetInfos };
	}

	private async handleTargetGetTargetInfo({ targetId }: { targetId?: string } = {}) {
		if (!targetId) {
			// No targetId specified -- return info about the browser target itself
			return { targetInfo: await this.browserTarget.getTargetInfo() };
		}

		const target = await this.resolveTarget(targetId);
		return { targetInfo: await target.getTargetInfo() };
	}

	private async handleTargetAttachToTarget({ targetId, flatten }: { targetId: string; flatten?: boolean }) {
		if (!flatten) {
			throw new CDPInvalidParamsError('This implementation only supports attachToTarget with flatten=true');
		}

		const sessionId = await this.attachToTarget(targetId);
		return { sessionId };
	}

	private async handleTargetCreateTarget({ url, browserContextId }: { url?: string; browserContextId?: string }) {
		const target = await this.browserTarget.createTarget(url || 'about:blank', browserContextId);
		const targetInfo = await target.getTargetInfo();

		// Cache FIRST so handleTargetCreated listener skips this target
		this._targets.set(targetInfo.targetId, target);

		// Playwright expects: targetCreated -> attachedToTarget -> createTarget response
		// We send events explicitly here to guarantee ordering (the listener is async)
		this.sendBrowserEvent('Target.targetCreated', { targetInfo });

		if (this._autoAttach && !this._targetSessions.has(targetInfo.targetId)) {
			await this.attachToTarget(targetInfo.targetId);
		}
		return { targetId: targetInfo.targetId };
	}

	private handleTargetCloseTarget({ targetId }: { targetId: string }) {
		const target = this._targets.get(targetId);
		if (!target) {
			return { success: false };
		}

		// Dispose session FIRST - emits Target.detachedFromTarget
		const sessionId = this._targetSessions.get(targetId);
		if (sessionId) {
			this.disposeSession(sessionId, targetId);
		}

		// THEN close the target - emits Target.targetDestroyed
		void this.browserTarget.closeTarget(target);

		return { success: true };
	}

	// #endregion

	// #region Internal Helpers

	/** Enumerate all targets from the service, caching each one and yielding its info */
	private async *getTargetInfos(): AsyncIterable<CDPTargetInfo> {
		for (const target of this.browserTarget.getTargets()) {
			const info = await target.getTargetInfo();
			this._targets.set(info.targetId, target);
			yield info;
		}
	}

	/** Resolve a target by ID, searching and caching if not found */
	private async resolveTarget(targetId: string): Promise<ICDPTarget> {
		if (this._targets.has(targetId)) {
			return this._targets.get(targetId)!;
		}

		// Cache miss - search through all targets from the service
		for await (const info of this.getTargetInfos()) {
			if (info.targetId === targetId) {
				return this._targets.get(targetId)!;
			}
		}

		throw new CDPServerError(`Target ${targetId} not found`);
	}

	/** Find the targetId for a given sessionId */
	private findTargetIdForSession(sessionId: string): string | undefined {
		for (const [targetId, sid] of this._targetSessions) {
			if (sid === sessionId) {
				return targetId;
			}
		}
		return undefined;
	}

	/** Send a browser-level event to the client */
	private sendBrowserEvent(method: string, params: unknown): void {
		this._onEvent.fire({ method, params });
	}

	/** Dispose a session and emit the detached event (idempotent) */
	private disposeSession(sessionId: string, targetId: string): void {
		if (!this._sessions.has(sessionId)) {
			return; // Already disposed
		}
		this.sendBrowserEvent('Target.detachedFromTarget', { sessionId, targetId });
		this._sessions.deleteAndDispose(sessionId);
		this._targetSessions.delete(targetId);
	}

	/** Attach to a target, creating a named session */
	private async attachToTarget(targetId: string): Promise<string> {
		const existingSessionId = this._targetSessions.get(targetId);
		if (existingSessionId) {
			return existingSessionId;
		}

		const target = await this.resolveTarget(targetId);
		const connection = await target.attach();
		const sessionId = connection.sessionId;

		this._sessions.set(sessionId, connection);
		this._targetSessions.set(targetId, sessionId);

		const targetInfo = await target.getTargetInfo();

		// Forward non-Target.* events to the external client, tagged with the sessionId.
		connection.onEvent(event => {
			if (!event.method.startsWith('Target.')) {
				this._onEvent.fire({
					method: event.method,
					params: event.params,
					sessionId
				});
			}
		});

		this.sendBrowserEvent('Target.attachedToTarget', {
			sessionId,
			targetInfo: { ...targetInfo, attached: true },
			waitingForDebugger: false
		});

		return sessionId;
	}

	/** Handle target created event from service */
	private handleTargetCreated(target: ICDPTarget): void {
		void target.getTargetInfo().then(targetInfo => {
			// Skip if already cached (handleTargetCreateTarget already handled this target)
			if (this._targets.has(targetInfo.targetId)) {
				return;
			}

			this._targets.set(targetInfo.targetId, target);
			this.sendBrowserEvent('Target.targetCreated', { targetInfo });

			if (this._autoAttach && !this._targetSessions.has(targetInfo.targetId)) {
				void this.attachToTarget(targetInfo.targetId);
			}
		});
	}

	/** Handle target destroyed event from service */
	private handleTargetDestroyed(target: ICDPTarget): void {
		void target.getTargetInfo().then(targetInfo => {
			const targetId = targetInfo.targetId;

			// Clean up session FIRST (CDP clients expect detachedFromTarget before targetDestroyed)
			const sessionId = this._targetSessions.get(targetId);
			if (sessionId) {
				this.disposeSession(sessionId, targetId);
			}

			this._targets.delete(targetId);
			this.sendBrowserEvent('Target.targetDestroyed', { targetId });
		});
	}

	// #endregion
}
