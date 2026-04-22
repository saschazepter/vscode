/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Helpers used inside scenario.mts files. Wraps the most common Playwright
 * patterns for VS Code into one-liners and gives every scenario a consistent
 * `summary.json` output contract.
 *
 * Construct one per launched session:
 *
 *   const helpers = createHelpers(session, { scenario: 'my-feature' });
 *   await helpers.step('open chat', async () => {
 *     await helpers.runCommand('workbench.panel.chat.view.copilot.focus');
 *     await helpers.waitForElement('[id="workbench.panel.chat"]');
 *   });
 *   await helpers.finish();
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright-core';
import type { LaunchedSession } from './launchCode.mts';

export interface ScenarioOptions {
	scenario: string;
}

export interface StepResult {
	name: string;
	ok: boolean;
	durationMs: number;
	screenshot?: string;
	error?: string;
}

export interface ScenarioSummary {
	scenario: string;
	startedAt: string;
	endedAt?: string;
	ok: boolean;
	steps: StepResult[];
	error: string | null;
}

export interface WaitForOptions {
	timeoutMs?: number;
}

export interface Helpers {
	page: Page;
	outputDir: string;
	summary: ScenarioSummary;

	/** Run a labeled step. Failures attach a screenshot and re-throw. */
	step<T>(name: string, fn: () => Promise<T>): Promise<T>;

	/** Open the command palette and run a command by id (e.g. 'workbench.action.toggleSidebar'). */
	runCommand(commandId: string): Promise<void>;

	/** Open a workspace file via the Files quick pick. `relPath` is shown in the picker. */
	openFile(relPath: string): Promise<void>;

	/** Wait for an element matching `selector` to be visible. */
	waitForElement(selector: string, opts?: WaitForOptions): Promise<void>;

	/** Wait for an element matching `selector` to detach or hide. */
	waitForElementGone(selector: string, opts?: WaitForOptions): Promise<void>;

	/** Read text content of the first element matching `selector`. */
	getText(selector: string): Promise<string>;

	/** Save a screenshot to the output dir. Returns the file name relative to the dir. */
	screenshot(label: string): Promise<string>;

	/** Press a key chord (e.g. 'Escape', 'Control+Shift+P'). */
	press(key: string): Promise<void>;

	/** Type into the currently focused element. */
	type(text: string): Promise<void>;

	/** Write summary.json. Called automatically by `finish` and on step failure; safe to call mid-run. */
	writeSummary(): Promise<void>;

	/** Mark the run complete, write final summary.json. */
	finish(): Promise<ScenarioSummary>;
}

export function createHelpers(session: LaunchedSession, opts: ScenarioOptions): Helpers {
	const summary: ScenarioSummary = {
		scenario: opts.scenario,
		startedAt: new Date().toISOString(),
		ok: true,
		steps: [],
		error: null,
	};

	const { page, outputDir } = session;
	let stepIndex = 0;

	const writeSummary = async () => {
		await writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));
	};

	const screenshot = async (label: string): Promise<string> => {
		const safe = label.replace(/[^\w.-]+/g, '-');
		const idx = String(stepIndex).padStart(2, '0');
		const file = `${idx}-${safe}.png`;
		await page.screenshot({ path: path.join(outputDir, file) });
		return file;
	};

	const helpers: Helpers = {
		page,
		outputDir,
		summary,

		async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
			stepIndex++;
			const start = Date.now();
			const result: StepResult = { name, ok: false, durationMs: 0 };
			summary.steps.push(result);
			try {
				const value = await fn();
				result.ok = true;
				result.durationMs = Date.now() - start;
				try { result.screenshot = await screenshot(name); } catch { /* ignore */ }
				await writeSummary();
				return value;
			} catch (err) {
				result.ok = false;
				result.durationMs = Date.now() - start;
				result.error = err instanceof Error ? err.stack ?? err.message : String(err);
				try { result.screenshot = await screenshot(`${name}-FAIL`); } catch { /* ignore */ }
				summary.ok = false;
				summary.error = result.error;
				await writeSummary();
				throw err;
			}
		},

		async runCommand(commandId) {
			// Open command palette via its command, then type ">commandId"
			// Using the keybinding is also fine but varies by platform.
			await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
			await helpers.waitForElement('.quick-input-widget:not(.hidden) .quick-input-filter input');
			await page.keyboard.insertText(`>${commandId}`);
			// Wait for the picker to filter
			await page.waitForTimeout(50);
			await page.keyboard.press('Enter');
			await helpers.waitForElementGone('.quick-input-widget:not(.hidden)').catch(() => undefined);
		},

		async openFile(relPath) {
			await page.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P');
			await helpers.waitForElement('.quick-input-widget:not(.hidden) .quick-input-filter input');
			await page.keyboard.insertText(relPath);
			await page.waitForTimeout(150);
			await page.keyboard.press('Enter');
			await helpers.waitForElementGone('.quick-input-widget:not(.hidden)').catch(() => undefined);
		},

		async waitForElement(selector, { timeoutMs = 15000 } = {}) {
			await page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });
		},

		async waitForElementGone(selector, { timeoutMs = 15000 } = {}) {
			await page.waitForSelector(selector, { state: 'hidden', timeout: timeoutMs });
		},

		async getText(selector) {
			const el = await page.waitForSelector(selector, { state: 'attached', timeout: 5000 });
			return (await el.textContent()) ?? '';
		},

		screenshot,

		async press(key) {
			await page.keyboard.press(key);
		},

		async type(text) {
			await page.keyboard.insertText(text);
		},

		writeSummary,

		async finish() {
			summary.endedAt = new Date().toISOString();
			await writeSummary();
			return summary;
		},
	};

	return helpers;
}
