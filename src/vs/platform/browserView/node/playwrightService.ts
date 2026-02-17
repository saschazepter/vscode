/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { ILogService } from '../../log/common/log.js';
import { IPlaywrightService } from '../common/playwrightService.js';
import { IBrowserViewGroupRemoteService } from '../common/browserViewGroupRemoteService.js';
import { IBrowserViewGroup } from '../common/browserViewGroup.js';

// eslint-disable-next-line local/code-import-patterns
import type { Browser, BrowserContext, Page } from 'playwright-core';

/**
 * Shared-process implementation of {@link IPlaywrightService}.
 */
export class PlaywrightService extends Disposable implements IPlaywrightService {
	declare readonly _serviceBrand: undefined;

	private _browser: Browser | undefined;
	private _pages: PlaywrightPageMap | undefined;
	private _initPromise: Promise<void> | undefined;

	constructor(
		@IBrowserViewGroupRemoteService private readonly groupRemoteService: IBrowserViewGroupRemoteService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	/**
	 * Ensure the Playwright browser connection and page map are initialized.
	 */
	async initialize(): Promise<void> {
		if (this._pages) {
			return;
		}

		if (this._initPromise) {
			return this._initPromise;
		}

		this._initPromise = (async () => {
			try {
				this.logService.debug('[PlaywrightService] Creating browser view group');
				const group = this._register(await this.groupRemoteService.createGroup());

				this.logService.debug('[PlaywrightService] Connecting to browser via CDP');
				const playwright = await import('playwright-core');
				const endpoint = await group.getDebugWebSocketEndpoint();
				const browser = await playwright.chromium.connectOverCDP(endpoint);

				this.logService.debug('[PlaywrightService] Connected to browser');

				browser.on('disconnected', () => {
					this.logService.debug('[PlaywrightService] Browser disconnected');
					this._browser = undefined;
					this._pages = undefined;
					this._initPromise = undefined;
				});

				// This can happen if the service was disposed while we were waiting for the connection. In that case, clean up immediately.
				if (this._initPromise === undefined) {
					browser.close().catch(() => { /* ignore */ });
					throw new Error('PlaywrightService was disposed during initialization');
				}

				this._browser = browser;
				const pageMap = this._register(new PlaywrightPageMap(group, browser, this.logService));
				this._pages = pageMap;
			} catch (e) {
				this._initPromise = undefined;
				throw e;
			}
		})();

		return this._initPromise;
	}

	override dispose(): void {
		if (this._browser) {
			this._browser.close().catch(() => { /* ignore */ });
			this._browser = undefined;
		}
		this._initPromise = undefined;
		super.dispose();
	}
}

/**
 * Correlates browser view IDs with Playwright {@link Page} instances.
 *
 * When a browser view is added to a group, two asynchronous events follow
 * through independent channels:
 *
 * 1. The group fires {@link IBrowserViewGroup.onDidAddView} (via IPC).
 * 2. Playwright receives a CDP `Target.targetCreated` event (via WebSocket)
 *    and fires a `page` event on the matching {@link BrowserContext}.
 *
 * This class pairs the two event streams by FIFO ordering: the first view-ID
 * received is matched with the first page event received.
 *
 * A periodic scan handles the case where Playwright creates a new
 * {@link BrowserContext} for a target whose session was previously unknown.
 */
class PlaywrightPageMap extends Disposable {

	private readonly _viewIdToPage = new Map<string, Page>();

	/** View IDs received from the group but not yet matched with a page. */
	private readonly _viewIdQueue: string[] = [];

	/** Pages received from Playwright but not yet matched with a view ID. */
	private readonly _pageQueue: Page[] = [];

	/** Callers waiting for a specific view ID to be resolved to a page. */
	private readonly _waiters = new Map<string, DeferredPromise<Page>>();

	private readonly _watchedContexts = new WeakSet<BrowserContext>();
	private _scanTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly _group: IBrowserViewGroup,
		private readonly _browser: Browser,
		private readonly logService: ILogService,
	) {
		super();

		this._register(_group.onDidAddView(e => this.onViewAdded(e.viewId)));
		this._register(_group.onDidRemoveView(e => this.onViewRemoved(e.viewId)));
		this.scanForNewContexts();
	}

	/**
	 * Get the Playwright {@link Page} for a browser view.
	 * If the view is not yet in the group, it is added automatically.
	 */
	async getPage(viewId: string, timeoutMs = 10000): Promise<Page> {
		const existing = this._viewIdToPage.get(viewId);
		if (existing) {
			return existing;
		}

		const existingWaiter = this._waiters.get(viewId);
		if (existingWaiter) {
			return existingWaiter.p;
		}

		const deferred = new DeferredPromise<Page>();
		const timeout = setTimeout(() => deferred.error(new Error(`Timed out after waiting for page`)), timeoutMs);

		deferred.p.finally(() => {
			clearTimeout(timeout);
			this._waiters.delete(viewId);
			if (this._waiters.size === 0) {
				this.stopScanning();
			}
		});

		this._waiters.set(viewId, deferred);
		this.ensureScanning();

		// Adding the view fires onDidAddView (pushes to viewIdQueue) and
		// eventually a Playwright page event (pushes to pageQueue).
		await this._group.addView(viewId);

		return deferred.p;
	}

	// --- Event handlers ---

	private onViewAdded(viewId: string): void {
		this._viewIdQueue.push(viewId);
		this.tryMatch();
	}

	private onViewRemoved(viewId: string): void {
		this._viewIdToPage.delete(viewId);
	}

	private onPage(page: Page): void {
		if (this.isKnownPage(page)) {
			return;
		}
		this._pageQueue.push(page);
		this.tryMatch();
	}

	// --- Matching ---

	/**
	 * Pair up queued view IDs with queued pages in FIFO order and resolve
	 * any callers waiting for the matched view IDs.
	 */
	private tryMatch(): void {
		while (this._viewIdQueue.length > 0 && this._pageQueue.length > 0) {
			const viewId = this._viewIdQueue.shift()!;
			const page = this._pageQueue.shift()!;

			this._viewIdToPage.set(viewId, page);
			page.once('close', () => this._viewIdToPage.delete(viewId));

			this.logService.debug(`[PlaywrightPageMap] Matched view ${viewId} → page`);

			const waiter = this._waiters.get(viewId);
			if (waiter) {
				waiter.complete(page);
				this._waiters.delete(viewId);
			}
		}
	}

	// --- Context scanning ---

	/**
	 * Watch all current {@link BrowserContext BrowserContexts} for new pages.
	 * Also processes any existing pages in newly discovered contexts.
	 */
	private scanForNewContexts(): void {
		for (const context of this._browser.contexts()) {
			if (this._watchedContexts.has(context)) {
				continue;
			}
			this._watchedContexts.add(context);

			context.on('page', (page: Page) => this.onPage(page));
			context.on('close', () => this._watchedContexts.delete(context));

			for (const page of context.pages()) {
				this.onPage(page);
			}
		}
	}

	private ensureScanning(): void {
		if (this._scanTimer === undefined) {
			this._scanTimer = setInterval(() => this.scanForNewContexts(), 100);
		}
	}

	private stopScanning(): void {
		if (this._scanTimer !== undefined) {
			clearInterval(this._scanTimer);
			this._scanTimer = undefined;
		}
	}

	private isKnownPage(page: Page): boolean {
		if (this._pageQueue.includes(page)) {
			return true;
		}
		for (const p of this._viewIdToPage.values()) {
			if (p === page) {
				return true;
			}
		}
		return false;
	}

	override dispose(): void {
		this.stopScanning();
		for (const waiter of this._waiters.values()) {
			waiter.error(new Error('PlaywrightPageMap disposed'));
		}
		this._waiters.clear();
		super.dispose();
	}
}
