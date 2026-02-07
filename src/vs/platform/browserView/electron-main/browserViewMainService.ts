/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { session } from 'electron';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { IBrowserViewBounds, IBrowserViewKeyDownEvent, IBrowserViewState, IBrowserViewService, BrowserViewStorageScope, IBrowserViewCaptureScreenshotOptions, IBrowserViewFindInPageOptions, IBrowserViewOpenRequest, IBrowserViewDebugInfo } from '../common/browserView.js';
import { ICDPTarget, ICDPTargetService } from '../common/cdp/types.js';
import { BrowserViewCDPProxyServer } from './browserViewCDPProxyServer.js';
import { ILogService } from '../../log/common/log.js';
import { joinPath } from '../../../base/common/resources.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { createDecorator, IInstantiationService } from '../../instantiation/common/instantiation.js';
import { IProductService } from '../../product/common/productService.js';
import { BrowserView } from './browserView.js';
import { generateUuid } from '../../../base/common/uuid.js';

/** Default browser context ID for the shared ephemeral session */
const DEFAULT_BROWSER_CONTEXT_ID = 'default';

export const IBrowserViewMainService = createDecorator<IBrowserViewMainService>('browserViewMainService');

export interface IBrowserViewMainService extends IBrowserViewService, ICDPTargetService {
	tryGetBrowserView(id: string): BrowserView | undefined;
}

// Same as webviews
const allowedPermissions = new Set([
	'pointerLock',
	'notifications',
	'clipboard-read',
	'clipboard-sanitized-write'
]);

export class BrowserViewMainService extends Disposable implements IBrowserViewMainService {
	declare readonly _serviceBrand: undefined;

	/**
	 * Check if a webContents belongs to an integrated browser view
	*/
	private static readonly knownSessions = new WeakSet<Electron.Session>();
	static isBrowserViewWebContents(contents: Electron.WebContents): boolean {
		return BrowserViewMainService.knownSessions.has(contents.session);
	}

	private readonly browserViews = this._register(new DisposableMap<string, BrowserView>());
	private debugProxy: BrowserViewCDPProxyServer | undefined;

	/**
	 * Browser contexts: maps contextId to Electron session partition string.
	 * The 'default' context uses ephemeral sessions per view.
	 * Created contexts use 'vscode-browser-context-{contextId}' partitions.
	 */
	private readonly _browserContexts = new Map<string, string>();

	/**
	 * Maps targetId to its browser context ID
	 */
	private readonly _targetToContext = new Map<string, string>();

	private readonly _onDidRequestOpenBrowser = this._register(new Emitter<IBrowserViewOpenRequest>());
	readonly onDidRequestOpenBrowser: Event<IBrowserViewOpenRequest> = this._onDidRequestOpenBrowser.event;

	// ICDPTargetService events
	private readonly _onTargetCreated = this._register(new Emitter<BrowserView>());
	readonly onTargetCreated: Event<BrowserView> = this._onTargetCreated.event;

	private readonly _onTargetDestroyed = this._register(new Emitter<BrowserView>());
	readonly onTargetDestroyed: Event<BrowserView> = this._onTargetDestroyed.event;

	constructor(
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IProductService private readonly productService: IProductService
	) {
		super();

		this.ensureDebugProxyStarted();
	}

	/**
	 * Get the session for a browser view based on data storage setting and workspace
	 */
	private getSession(requestedScope: BrowserViewStorageScope, viewId?: string, workspaceId?: string): {
		session: Electron.Session;
		resolvedScope: BrowserViewStorageScope;
	} {
		switch (requestedScope) {
			case 'global':
				return { session: session.fromPartition('persist:vscode-browser'), resolvedScope: BrowserViewStorageScope.Global };
			case 'workspace':
				if (workspaceId) {
					const storage = joinPath(this.environmentMainService.workspaceStorageHome, workspaceId, 'browserStorage');
					return { session: session.fromPath(storage.fsPath), resolvedScope: BrowserViewStorageScope.Workspace };
				}
			// fallthrough
			case 'ephemeral':
			default:
				return { session: session.fromPartition(`vscode-browser-${viewId ?? generateUuid()}`), resolvedScope: BrowserViewStorageScope.Ephemeral };
		}
	}

	private configureSession(viewSession: Electron.Session): void {
		viewSession.setPermissionRequestHandler((_webContents, permission, callback) => {
			return callback(allowedPermissions.has(permission));
		});
		viewSession.setPermissionCheckHandler((_webContents, permission, _origin) => {
			return allowedPermissions.has(permission);
		});
	}

	/**
	 * Create a child browser view (used by window.open handler)
	 * @param skipTargetCreatedEvent - If true, skip firing the onTargetCreated event (for CDP-created targets)
	 */
	private createBrowserView(id: string, session: Electron.Session, scope: BrowserViewStorageScope, browserContextId: string, options?: Electron.WebContentsViewConstructorOptions): BrowserView {
		if (this.browserViews.has(id)) {
			throw new Error(`Browser view with id ${id} already exists`);
		}

		const view = this.instantiationService.createInstance(
			BrowserView,
			id,
			session,
			scope,
			browserContextId,
			// Recursive factory for nested windows
			(options) => this.createBrowserView(generateUuid(), session, scope, browserContextId, options),
			options
		);
		this.browserViews.set(id, view);
		this._targetToContext.set(id, browserContextId);

		this._onTargetCreated.fire(view);

		return view;
	}

	async getOrCreateBrowserView(id: string, scope: BrowserViewStorageScope, workspaceId?: string): Promise<IBrowserViewState> {
		if (this.browserViews.has(id)) {
			// Note: scope will be ignored if the view already exists.
			// Browser views cannot be moved between sessions after creation.
			const view = this.browserViews.get(id)!;
			return view.getState();
		}

		const { session, resolvedScope } = this.getSession(scope, id, workspaceId);
		this.configureSession(session);
		BrowserViewMainService.knownSessions.add(session);

		const view = this.createBrowserView(id, session, resolvedScope, DEFAULT_BROWSER_CONTEXT_ID);

		return view.getState();
	}

	tryGetBrowserView(id: string): BrowserView | undefined {
		return this.browserViews.get(id);
	}

	// ICDPTargetService implementation

	getTargets(): IterableIterator<BrowserView> {
		return this.browserViews.values();
	}

	async createTarget(url: string, browserContextId?: string): Promise<ICDPTarget> {
		const targetId = generateUuid();
		const contextId = browserContextId ?? DEFAULT_BROWSER_CONTEXT_ID;

		// Get session for the browser context
		let viewSession: Electron.Session;
		let resolvedScope: BrowserViewStorageScope;

		if (contextId === DEFAULT_BROWSER_CONTEXT_ID) {
			// Default context: ephemeral session per target
			const result = this.getSession(BrowserViewStorageScope.Ephemeral, targetId);
			viewSession = result.session;
			resolvedScope = result.resolvedScope;
		} else {
			// Created context: use the context's shared partition
			const partition = this._browserContexts.get(contextId);
			if (!partition) {
				throw new Error(`Browser context ${contextId} not found`);
			}
			viewSession = session.fromPartition(partition);
			resolvedScope = BrowserViewStorageScope.Ephemeral;
		}

		this.configureSession(viewSession);
		BrowserViewMainService.knownSessions.add(viewSession);

		// Create the browser view (fires onTargetCreated)
		const view = this.createBrowserView(targetId, viewSession, resolvedScope, contextId, undefined);

		// Notify workbench to open an editor for this new browser view
		this._onDidRequestOpenBrowser.fire({ targetId, url });

		return view;
	}

	async closeTarget(targetId: string): Promise<boolean> {
		// The targetId here is the CDP targetId. We need to find the view by iterating.
		// This is called by the proxy after it has already validated the target exists in its cache.
		for (const view of this.browserViews.values()) {
			try {
				const targetInfo = await view.getTargetInfo();
				if (targetInfo.targetId === targetId) {
					await this.destroyBrowserView(view.id);
					return true;
				}
			} catch {
				// View may be in invalid state, continue searching
			}
		}
		return false;
	}

	// Browser context management

	getBrowserContexts(): string[] {
		// Always include default context, plus any created contexts
		return [DEFAULT_BROWSER_CONTEXT_ID, ...this._browserContexts.keys()];
	}

	async createBrowserContext(): Promise<string> {
		const contextId = generateUuid();
		const partition = `vscode-browser-context-${contextId}`;
		this._browserContexts.set(contextId, partition);

		// Pre-configure the session
		const viewSession = session.fromPartition(partition);
		this.configureSession(viewSession);
		BrowserViewMainService.knownSessions.add(viewSession);

		return contextId;
	}

	async disposeBrowserContext(browserContextId: string): Promise<void> {
		if (browserContextId === DEFAULT_BROWSER_CONTEXT_ID) {
			throw new Error('Cannot dispose the default browser context');
		}

		if (!this._browserContexts.has(browserContextId)) {
			throw new Error(`Browser context ${browserContextId} not found`);
		}

		// Close all targets in this context
		const targetsToClose: string[] = [];
		for (const [targetId, contextId] of this._targetToContext) {
			if (contextId === browserContextId) {
				targetsToClose.push(targetId);
			}
		}

		for (const targetId of targetsToClose) {
			await this.destroyBrowserView(targetId);
		}

		this._browserContexts.delete(browserContextId);
	}

	async ensureDebugProxyStarted(): Promise<IBrowserViewDebugInfo> {
		if (!this.debugProxy) {
			this.debugProxy = this._register(new BrowserViewCDPProxyServer(this, this.productService, this.logService));
		}
		return this.debugProxy.ensureStarted();
	}

	/**
	 * Get a browser view or throw if not found
	 */
	private _getBrowserView(id: string): BrowserView {
		const view = this.browserViews.get(id);
		if (!view) {
			throw new Error(`Browser view ${id} not found`);
		}
		return view;
	}

	onDynamicDidNavigate(id: string) {
		return this._getBrowserView(id).onDidNavigate;
	}

	onDynamicDidChangeLoadingState(id: string) {
		return this._getBrowserView(id).onDidChangeLoadingState;
	}

	onDynamicDidChangeFocus(id: string) {
		return this._getBrowserView(id).onDidChangeFocus;
	}

	onDynamicDidChangeVisibility(id: string) {
		return this._getBrowserView(id).onDidChangeVisibility;
	}

	onDynamicDidChangeDevToolsState(id: string) {
		return this._getBrowserView(id).onDidChangeDevToolsState;
	}

	onDynamicDidKeyCommand(id: string) {
		return this._getBrowserView(id).onDidKeyCommand;
	}

	onDynamicDidChangeTitle(id: string) {
		return this._getBrowserView(id).onDidChangeTitle;
	}

	onDynamicDidChangeFavicon(id: string) {
		return this._getBrowserView(id).onDidChangeFavicon;
	}

	onDynamicDidRequestNewPage(id: string) {
		return this._getBrowserView(id).onDidRequestNewPage;
	}

	onDynamicDidFindInPage(id: string) {
		return this._getBrowserView(id).onDidFindInPage;
	}

	onDynamicDidClose(id: string) {
		return this._getBrowserView(id).onDidClose;
	}

	async destroyBrowserView(id: string): Promise<void> {
		const view = this.browserViews.get(id);
		if (view) {
			// Fire the destroyed event BEFORE disposing so the proxy can get the targetId
			this._onTargetDestroyed.fire(view);
			this._targetToContext.delete(id);
			this.browserViews.deleteAndDispose(id);
		}
	}

	async layout(id: string, bounds: IBrowserViewBounds): Promise<void> {
		return this._getBrowserView(id).layout(bounds);
	}

	async setVisible(id: string, visible: boolean): Promise<void> {
		return this._getBrowserView(id).setVisible(visible);
	}

	async loadURL(id: string, url: string): Promise<void> {
		return this._getBrowserView(id).loadURL(url);
	}

	async getURL(id: string): Promise<string> {
		return this._getBrowserView(id).getURL();
	}

	async goBack(id: string): Promise<void> {
		return this._getBrowserView(id).goBack();
	}

	async goForward(id: string): Promise<void> {
		return this._getBrowserView(id).goForward();
	}

	async reload(id: string): Promise<void> {
		return this._getBrowserView(id).reload();
	}

	async toggleDevTools(id: string): Promise<void> {
		return this._getBrowserView(id).toggleDevTools();
	}

	async canGoBack(id: string): Promise<boolean> {
		return this._getBrowserView(id).canGoBack();
	}

	async canGoForward(id: string): Promise<boolean> {
		return this._getBrowserView(id).canGoForward();
	}

	async captureScreenshot(id: string, options?: IBrowserViewCaptureScreenshotOptions): Promise<VSBuffer> {
		return this._getBrowserView(id).captureScreenshot(options);
	}

	async dispatchKeyEvent(id: string, keyEvent: IBrowserViewKeyDownEvent): Promise<void> {
		return this._getBrowserView(id).dispatchKeyEvent(keyEvent);
	}

	async setZoomFactor(id: string, zoomFactor: number): Promise<void> {
		return this._getBrowserView(id).setZoomFactor(zoomFactor);
	}

	async focus(id: string): Promise<void> {
		return this._getBrowserView(id).focus();
	}

	async findInPage(id: string, text: string, options?: IBrowserViewFindInPageOptions): Promise<void> {
		return this._getBrowserView(id).findInPage(text, options);
	}

	async stopFindInPage(id: string, keepSelection?: boolean): Promise<void> {
		return this._getBrowserView(id).stopFindInPage(keepSelection);
	}

	async clearStorage(id: string): Promise<void> {
		return this._getBrowserView(id).clearStorage();
	}

	async clearGlobalStorage(): Promise<void> {
		const { session, resolvedScope } = this.getSession(BrowserViewStorageScope.Global);
		if (resolvedScope !== BrowserViewStorageScope.Global) {
			throw new Error('Failed to resolve global storage session');
		}
		await session.clearData();
	}

	async clearWorkspaceStorage(workspaceId: string): Promise<void> {
		const { session, resolvedScope } = this.getSession(BrowserViewStorageScope.Workspace, undefined, workspaceId);
		if (resolvedScope !== BrowserViewStorageScope.Workspace) {
			throw new Error('Failed to resolve workspace storage session');
		}
		await session.clearData();
	}
}
