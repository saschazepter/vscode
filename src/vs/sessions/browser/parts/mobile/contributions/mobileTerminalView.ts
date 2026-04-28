/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/mobileOverlayViews.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Gesture, EventType as TouchEventType } from '../../../../../base/browser/touch.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';

const $ = DOM.$;

/**
 * Minimal subset of terminal invocation fields consumed by the mobile terminal view.
 * Defined locally to avoid importing from vs/workbench/contrib in vs/sessions/browser.
 */
export interface ITerminalViewData {
	readonly commandLine: {
		readonly original: string;
		readonly userEdited?: string;
		readonly forDisplay?: string;
	};
	readonly terminalCommandOutput?: {
		readonly text: string;
		readonly truncated?: boolean;
	};
	readonly terminalCommandState?: {
		readonly exitCode?: number;
		readonly duration?: number;
	};
}

/**
 * Data passed to {@link MobileTerminalView} when opening a terminal view.
 */
export interface IMobileTerminalViewData {
	/** The terminal tool invocation data containing command line and output. */
	readonly terminalData: ITerminalViewData;
}

/**
 * Full-screen overlay for viewing terminal command output on phone viewports.
 *
 * This component follows the account-sheet overlay pattern from
 * {@link MobileTitlebarPart}: it appends a `position:fixed; inset:0` element
 * to the workbench container, wires a close/back button, and removes itself
 * on dispose.
 *
 * Features:
 * - Displays the command line in the header with an exit code badge.
 * - Monospace, horizontally scrollable output body (no wrapping — preserves
 *   terminal column alignment).
 * - "Jump to bottom" floating button that appears when the user scrolls up
 *   during a live-tailing session.
 * - Copy output footer button.
 * - Back button removes the view and disposes resources.
 *
 * The caller is responsible for disposing the returned {@link MobileTerminalView}
 * to close and clean up the view.
 */
export class MobileTerminalView extends Disposable {

	private readonly viewStore = this._register(new DisposableStore());

	constructor(
		workbenchContainer: HTMLElement,
		data: IMobileTerminalViewData,
	) {
		super();
		this.render(workbenchContainer, data);
	}

	private render(workbenchContainer: HTMLElement, data: IMobileTerminalViewData): void {
		const { terminalData } = data;
		const output = terminalData.terminalCommandOutput;
		const state = terminalData.terminalCommandState;
		const commandLine = terminalData.commandLine.forDisplay
			?? terminalData.commandLine.userEdited
			?? terminalData.commandLine.original;

		// -- Root overlay -----------------------------------------
		const overlay = DOM.append(workbenchContainer, $('div.mobile-overlay-view'));
		this.viewStore.add(DOM.addDisposableListener(overlay, DOM.EventType.CONTEXT_MENU, e => e.preventDefault()));
		this.viewStore.add(toDisposable(() => overlay.remove()));

		// -- Header -----------------------------------------------
		const header = DOM.append(overlay, $('div.mobile-overlay-header'));

		// Back button
		const backBtn = DOM.append(header, $('button.mobile-overlay-back-btn', { type: 'button' })) as HTMLButtonElement;
		backBtn.setAttribute('aria-label', localize('terminalView.back', "Back"));
		DOM.append(backBtn, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronLeft));
		DOM.append(backBtn, $('span.back-btn-label')).textContent = localize('terminalView.backLabel', "Back");
		this.viewStore.add(Gesture.addTarget(backBtn));
		this.viewStore.add(DOM.addDisposableListener(backBtn, DOM.EventType.CLICK, () => this.dispose()));
		this.viewStore.add(DOM.addDisposableListener(backBtn, TouchEventType.Tap, () => this.dispose()));

		// Title info
		const info = DOM.append(header, $('div.mobile-overlay-header-info'));
		const title = DOM.append(info, $('div.mobile-overlay-header-title'));
		title.textContent = commandLine.length > 80 ? commandLine.substring(0, 80) + '…' : commandLine;
		title.title = commandLine;

		// Exit code / status badge
		if (state?.exitCode !== undefined) {
			const badge = DOM.append(header, $('span.mobile-overlay-header-badge'));
			if (state.exitCode === 0) {
				badge.classList.add('success');
				badge.textContent = localize('terminalView.exitSuccess', "Exit 0");
				if (state.duration !== undefined) {
					badge.textContent += ` · ${(state.duration / 1000).toFixed(1)}s`;
				}
			} else {
				badge.classList.add('error');
				badge.textContent = localize('terminalView.exitCode', "Exit {0}", state.exitCode);
			}
		} else {
			const badge = DOM.append(header, $('span.mobile-overlay-header-badge.running'));
			badge.textContent = localize('terminalView.running', "Running…");
		}

		// -- Body -------------------------------------------------
		const body = DOM.append(overlay, $('div.mobile-overlay-body'));

		// Scrollable output container (position:relative for jump btn)
		const scrollWrapper = DOM.append(body, $('div.mobile-overlay-scroll'));
		scrollWrapper.style.position = 'relative';

		const pre = DOM.append(scrollWrapper, $('div.mobile-terminal-output'));
		if (output) {
			pre.textContent = output.text;
			if (output.truncated) {
				pre.classList.add('truncated');
			}
		} else {
			pre.textContent = localize('terminalView.noOutput', "(no output)");
			pre.style.color = 'var(--vscode-descriptionForeground)';
			pre.style.fontStyle = 'italic';
		}

		// Jump-to-bottom button (shown when user scrolls up)
		const jumpBtn = DOM.append(overlay, $('button.mobile-terminal-jump-btn.hidden', { type: 'button' })) as HTMLButtonElement;
		jumpBtn.textContent = localize('terminalView.jumpToBottom', "↓ Jump to bottom");
		this.viewStore.add(Gesture.addTarget(jumpBtn));
		this.viewStore.add(DOM.addDisposableListener(jumpBtn, DOM.EventType.CLICK, () => {
			scrollWrapper.scrollTop = scrollWrapper.scrollHeight;
		}));
		this.viewStore.add(DOM.addDisposableListener(jumpBtn, TouchEventType.Tap, () => {
			scrollWrapper.scrollTop = scrollWrapper.scrollHeight;
		}));
		this.viewStore.add(DOM.addDisposableListener(scrollWrapper, DOM.EventType.SCROLL, () => {
			const isAtBottom = scrollWrapper.scrollTop + scrollWrapper.clientHeight >= scrollWrapper.scrollHeight - 20;
			jumpBtn.classList.toggle('hidden', isAtBottom);
		}));

		// -- Footer -----------------------------------------------
		if (output) {
			const footer = DOM.append(overlay, $('div.mobile-overlay-footer'));
			const copyBtn = DOM.append(footer, $('button.mobile-overlay-footer-btn', { type: 'button' })) as HTMLButtonElement;
			DOM.append(copyBtn, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.copy));
			DOM.append(copyBtn, $('span')).textContent = ` ${localize('terminalView.copy', "Copy output")}`;
			copyBtn.setAttribute('aria-label', localize('terminalView.copyAriaLabel', "Copy terminal output to clipboard"));
			this.viewStore.add(Gesture.addTarget(copyBtn));
			this.viewStore.add(DOM.addDisposableListener(copyBtn, DOM.EventType.CLICK, () => {
				navigator.clipboard?.writeText(output.text);
			}));
			this.viewStore.add(DOM.addDisposableListener(copyBtn, TouchEventType.Tap, () => {
				navigator.clipboard?.writeText(output.text);
			}));
		}
	}

	override dispose(): void {
		this.viewStore.dispose();
		super.dispose();
	}
}

/**
 * Opens a {@link MobileTerminalView} for the given terminal invocation data.
 * Returns the view instance; dispose it to close the view.
 *
 * @param workbenchContainer - The workbench root element (overlay appended here).
 * @param data - Terminal tool invocation data with command line and output.
 */
export function openMobileTerminalView(
	workbenchContainer: HTMLElement,
	data: IMobileTerminalViewData,
): MobileTerminalView {
	return new MobileTerminalView(workbenchContainer, data);
}
