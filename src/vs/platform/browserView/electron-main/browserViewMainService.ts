/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { session } from 'electron';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { IBrowserViewBounds, IBrowserViewKeyDownEvent, IBrowserViewState, IBrowserViewService, BrowserViewStorageScope, IBrowserViewCaptureScreenshotOptions, IBrowserViewFindInPageOptions, IBrowserViewOpenRequest, IBrowserViewDebugInfo } from '../common/browserView.js';
import { ICDPService } from '../common/cdp/types.js';
import { BrowserViewCDPProxyServer } from './browserViewCDPProxyServer.js';
import { ILogService } from '../../log/common/log.js';
import { joinPath } from '../../../base/common/resources.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { createDecorator, IInstantiationService } from '../../instantiation/common/instantiation.js';
import { IProductService } from '../../product/common/productService.js';
import { BrowserView } from './browserView.js';
import { generateUuid } from '../../../base/common/uuid.js';

export const IBrowserViewMainService = createDecorator<IBrowserViewMainService>('browserViewMainService');

export interface IBrowserViewMainService extends IBrowserViewService, ICDPService {
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

	private readonly _onDidRequestOpenBrowser = this._register(new Emitter<IBrowserViewOpenRequest>());
	readonly onDidRequestOpenBrowser: Event<IBrowserViewOpenRequest> = this._onDidRequestOpenBrowser.event;

	// ICDPService events
	private readonly _onTargetCreated = this._register(new Emitter<BrowserView>());
	readonly onTargetCreated: Event<BrowserView> = this._onTargetCreated.event;

	private readonly _onTargetDestroyed = this._register(new Emitter<string>());
	readonly onTargetDestroyed: Event<string> = this._onTargetDestroyed.event;

	constructor(
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IProductService private readonly productService: IProductService
	) {
		super();
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
	 */
	private createBrowserView(id: string, session: Electron.Session, scope: BrowserViewStorageScope, options?: Electron.WebContentsViewConstructorOptions): BrowserView {
		if (this.browserViews.has(id)) {
			throw new Error(`Browser view with id ${id} already exists`);
		}

		const view = this.instantiationService.createInstance(
			BrowserView,
			id,
			session,
			scope,
			// Recursive factory for nested windows
			(options) => this.createBrowserView(generateUuid(), session, scope, options),
			options
		);
		this.browserViews.set(id, view);

		// Fire target created event for CDP
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

		const view = this.createBrowserView(id, session, resolvedScope);

		return view.getState();
	}

	tryGetBrowserView(id: string): BrowserView | undefined {
		return this.browserViews.get(id);
	}

	// ICDPService implementation

	getTarget(targetId: string): BrowserView | undefined {
		return this.browserViews.get(targetId);
	}

	getTargets(): IterableIterator<BrowserView> {
		return this.browserViews.values();
	}

	async createTarget(url: string): Promise<{ targetId: string }> {
		const targetId = generateUuid();
		const { session, resolvedScope } = this.getSession(BrowserViewStorageScope.Ephemeral, targetId);
		this.configureSession(session);
		BrowserViewMainService.knownSessions.add(session);

		const view = this.createBrowserView(targetId, session, resolvedScope);
		await view.loadURL(url);

		return { targetId };
	}

	async closeTarget(targetId: string): Promise<boolean> {
		if (!this.browserViews.has(targetId)) {
			return false;
		}
		await this.destroyBrowserView(targetId);
		return true;
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
		if (this.browserViews.has(id)) {
			this._onTargetDestroyed.fire(id);
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
