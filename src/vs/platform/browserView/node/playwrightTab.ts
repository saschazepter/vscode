/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line local/code-import-patterns
import type * as playwright from '@vscode/playwright-core';
import { Emitter, Event } from '../../../base/common/event.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { createCancelablePromise, raceCancellablePromises } from '../../../base/common/async.js';

declare module '@vscode/playwright-core' {
	interface Page {
		// A hidden Playwright method that returns an AI-friendly snapshot of the page.
		_snapshotForAI(options?: { track?: string }): Promise<{ full: string; incremental?: string }>;
	}
}

/**
 * Wrapper around a Playwright page that tracks additional state like active dialogs and recent console messages,
 * and can produce a summary of the page's current state for use in tools.
 *
 * Loosely based on https://github.com/microsoft/playwright/blob/main/packages/playwright/src/mcp/browser/tab.ts.
 */
export class PlaywrightTab {
	private _onDialogStateChanged = new Emitter<void>();

	private _dialog: playwright.Dialog | undefined;
	private _fileChooser: playwright.FileChooser | undefined;
	private _logs: { type: string; time: number; description: string }[] = [];

	private _initialized: Promise<void>;

	constructor(readonly page: playwright.Page) {
		page.on('console', event => this._handleConsoleMessage(event))
			.on('pageerror', error => this._handlePageError(error))
			.on('requestfailed', request => this._handleRequestFailed(request))
			.on('filechooser', chooser => this._handleFileChooser(chooser))
			.on('dialog', dialog => this._handleDialog(dialog))
			.on('download', download => this._handleDownload(download));

		this._initialized = this._initialize();
	}

	private async _initialize() {
		const messages = await this.page.consoleMessages().catch(() => []);
		for (const message of messages) { this._handleConsoleMessage(message); }
		const errors = await this.page.pageErrors().catch(() => []);
		for (const error of errors) { this._handlePageError(error); }
	}

	private _handleDialog(dialog: playwright.Dialog) {
		this._dialog = dialog;
		// Playwright doesn't give us an event for when a dialog is closed, so we run a no-op script to know when it closes.
		this.page.waitForFunction(() => true, undefined, { timeout: 0 }).then(() => {
			if (this._dialog === dialog) {
				this._dialog = undefined;
				this._onDialogStateChanged.fire();
			}
		});
		this._onDialogStateChanged.fire();
	}

	async replyToDialog(accept?: boolean, promptText?: string) {
		if (!this._dialog) {
			throw new Error('No active dialog to respond to');
		}
		const dialog = this._dialog;
		this._dialog = undefined;
		this._onDialogStateChanged.fire();
		await this.runAndWaitForCompletion(async () => {
			if (accept) {
				await dialog.accept(promptText);
			} else {
				await dialog.dismiss();
			}
		});
	}

	private _handleFileChooser(chooser: playwright.FileChooser) {
		this._fileChooser = chooser;
	}

	async replyToFileChooser(files: string[]) {
		if (!this._fileChooser) {
			throw new Error('No active file chooser to respond to');
		}
		const chooser = this._fileChooser;
		this._fileChooser = undefined;
		await this.runAndWaitForCompletion(() => chooser.setFiles(files));
	}

	private async _handleDownload(download: playwright.Download) {
		this._logs.push({ type: 'download', time: Date.now(), description: `${download.suggestedFilename()}` });
	}

	private _handleRequestFailed(request: playwright.Request) {
		const timing = request.timing();
		this._logs.push({ type: 'requestFailed', time: timing.responseEnd + timing.startTime, description: `${request.method()} request to ${request.url()} failed: "${request.failure()?.errorText}"` });
	}

	private _handleConsoleMessage(message: playwright.ConsoleMessage) {
		if (message.type() === 'error' || message.type() === 'warning') {
			this._logs.push({ type: 'console', time: message.timestamp(), description: `[${message.type()}] ${message.text()}` });
		}
	}

	private _handlePageError(error: Error) {
		this._logs.push({ type: 'pageError', time: Date.now(), description: error.stack ?? error.message });
	}

	async runAndWaitForCompletion<T>(callback: (token: CancellationToken) => Promise<T>): Promise<T> {
		// Dialogs pause the page. So we run the callback and wait for either its completion or a dialog to open
		if (this._dialog) {
			throw new Error(`Cannot perform action while a dialog is open`);
		}

		let completed = false;
		let result: T | void;
		const dialog = Event.toPromise(this._onDialogStateChanged.event);
		const action = createCancelablePromise(async (token) => {
			result = await runAndWaitForCompletion(this, callback, token);
			completed = true;
		});

		return raceCancellablePromises([dialog, action]).then(() => {
			if (!completed) {
				// A dialog was opened before the action completed. Note we don't cancel the action, just ignore its result.
				throw new Error('Action was interrupted by a dialog');
			}
			return result!;
		});
	}

	async getSummary(full = false): Promise<string> {
		await this._initialized;

		// Important: anything run against the page must be wrapped with runAndWaitForCompletion in case dialogs are opened.
		const snapshotFromPage = await this.runAndWaitForCompletion(() => this.page._snapshotForAI({ track: 'response' })).catch(() => undefined);
		const title = await this.runAndWaitForCompletion(() => this.page.title()).catch(() => '');

		const logs = this._logs;
		this._logs = [];

		const snapshot = (full ? snapshotFromPage?.full : snapshotFromPage?.incremental ?? snapshotFromPage?.full)?.trim() ?? '';

		return [
			...(title ? [`Page Title: ${title}`] : []),
			`URL: ${this.page.url()}`,
			...(this._dialog ? [`Active ${this._dialog.type()} dialog: "${this._dialog.message()}"`] : []),
			...(this._fileChooser ? [`Active file chooser dialog`] : []),
			...(logs.length > 0 ? [
				`Recent events:`,
				...logs.map(log => `- [${new Date(log.time).toISOString()}] (${log.type}) ${log.description}`)
			] : []),
			...(snapshot ? ['Snapshot:', snapshot] : [])
		].join('\n');
	}
}

async function runAndWaitForCompletion<T>(tab: PlaywrightTab, callback: (token: CancellationToken) => Promise<T>, token = CancellationToken.None): Promise<T> {
	const requests: playwright.Request[] = [];

	const requestListener = (request: playwright.Request) => requests.push(request);
	const disposeListeners = () => {
		tab.page.off('request', requestListener);
	};
	tab.page.on('request', requestListener);

	let result: T;
	try {
		result = await callback(token);
	} finally {
		disposeListeners();
	}

	const requestedNavigation = requests.some(request => request.isNavigationRequest());
	if (requestedNavigation) {
		await tab.page.mainFrame().waitForLoadState('load', { timeout: 10000 }).catch(() => { });
		return result;
	}

	const promises: Promise<unknown>[] = [];
	for (const request of requests) {
		if (['document', 'stylesheet', 'script', 'xhr', 'fetch'].includes(request.resourceType())) { promises.push(request.response().then(r => r?.finished()).catch(() => { })); }
		else { promises.push(request.response().catch(() => { })); }
	}
	const timeout = new Promise<void>(resolve => setTimeout(resolve, 5000));
	await Promise.race([Promise.all(promises), timeout]);

	return result;
}
