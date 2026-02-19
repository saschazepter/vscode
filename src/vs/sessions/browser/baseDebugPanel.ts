/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Abstract base class for debug panels in the sessions window.
 * Provides shared UI scaffolding (header, status bar, tab bar, log rendering,
 * info tab helpers) used by both the Copilot SDK and Cloud Task debug panels.
 */

import './media/debugPanel.css';
import * as dom from '../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { BaseDebugLog, IBaseDebugLogEntry } from './debugLog.js';

const $ = dom.$;

/**
 * Descriptor for a tab in the debug panel.
 */
export interface IDebugPanelTab {
	readonly id: string;
	readonly label: string;
	/** Whether this tab's container should use info styling (mono, pre-wrap, padding). */
	readonly isInfoStyle?: boolean;
}

/**
 * Abstract base class for debug panels. Provides shared UI scaffolding:
 * header with title/clear/copy, status bar, config row helpers, button loop,
 * tab bar, standard log entry renderer, info tab helpers, input area, and
 * replay-and-subscribe for debug log entries.
 */
export abstract class BaseDebugPanel<TEntry extends IBaseDebugLogEntry, TLog extends BaseDebugLog<TEntry>> extends Disposable {

	readonly element: HTMLElement;

	protected readonly _statusBar: HTMLElement;
	protected readonly _inputArea: HTMLTextAreaElement;
	protected readonly _eventDisposables = this._register(new DisposableStore());
	protected readonly _infoDisposables = this._register(new DisposableStore());

	private readonly _tabContainers = new Map<string, HTMLElement>();
	private readonly _tabButtons = new Map<string, HTMLButtonElement>();
	private _activeTabId: string;

	constructor(
		container: HTMLElement,
		protected readonly _debugLog: TLog,
		protected readonly _clipboardService: IClipboardService,
	) {
		super();

		this.element = dom.append(container, $('.debug-panel'));

		// Header
		const header = dom.append(this.element, $('.debug-panel-header'));
		dom.append(header, $('span')).textContent = this._getTitle();

		const clearBtn = dom.append(header, $('button')) as HTMLButtonElement;
		clearBtn.textContent = 'Clear';
		clearBtn.style.cssText = 'margin-left:auto;font-size:11px;padding:2px 8px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:3px;cursor:pointer;';
		this._register(dom.addDisposableListener(clearBtn, 'click', () => this._onClear()));

		const copyBtn = dom.append(header, $('button')) as HTMLButtonElement;
		copyBtn.textContent = 'Copy All';
		copyBtn.style.cssText = 'margin-left:4px;font-size:11px;padding:2px 8px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:3px;cursor:pointer;';
		this._register(dom.addDisposableListener(copyBtn, 'click', () => {
			this._clipboardService.writeText(this._getClipboardContent());
			copyBtn.textContent = 'Copied!';
			setTimeout(() => { copyBtn.textContent = 'Copy All'; }, 1500);
		}));

		// Status bar (initially empty - subclass calls _setStatus() after super())
		this._statusBar = dom.append(this.element, $('.debug-panel-status'));

		// Config rows (subclass-defined)
		this._buildConfigRows(this.element);

		// Helper buttons
		const helpers = dom.append(this.element, $('.debug-panel-helpers'));
		for (const { label, fn } of this._getHelperButtons()) {
			const btn = dom.append(helpers, $('button.debug-helper-btn')) as HTMLButtonElement;
			btn.textContent = label;
			this._register(dom.addDisposableListener(btn, 'click', fn));
		}

		// Tab bar
		const tabs = this._getTabs();
		this._activeTabId = tabs[0].id;
		const tabBar = dom.append(this.element, $('.debug-panel-tabs'));

		for (let i = 0; i < tabs.length; i++) {
			const tab = tabs[i];
			const tabBtn = dom.append(tabBar, $(`button.debug-tab${i === 0 ? '.debug-tab-active' : ''}`)) as HTMLButtonElement;
			tabBtn.textContent = tab.label;
			this._tabButtons.set(tab.id, tabBtn);
			this._register(dom.addDisposableListener(tabBtn, 'click', () => this._switchTab(tab.id)));

			// Create container for this tab
			const tabContainer = dom.append(this.element, $('.debug-panel-messages'));
			if (i !== 0) {
				tabContainer.style.display = 'none';
			}
			if (tab.isInfoStyle) {
				tabContainer.style.whiteSpace = 'pre-wrap';
				tabContainer.style.fontFamily = 'var(--monaco-monospace-font)';
				tabContainer.style.fontSize = '11px';
				tabContainer.style.padding = '8px';
			}
			this._tabContainers.set(tab.id, tabContainer);
		}

		// Input area
		const inputRow = dom.append(this.element, $('.debug-panel-input-row'));
		this._inputArea = dom.append(inputRow, $('textarea.debug-panel-input')) as HTMLTextAreaElement;
		this._inputArea.placeholder = this._getInputPlaceholder();
		this._inputArea.rows = 2;

		// Replay buffered entries then subscribe for new ones
		this._replayAndSubscribe();
	}

	// --- Abstract properties / methods ---

	/** Panel title shown in the header. */
	protected abstract _getTitle(): string;

	/** Input area placeholder text. */
	protected abstract _getInputPlaceholder(): string;

	/** Tab descriptors. The first tab is shown by default. */
	protected abstract _getTabs(): IDebugPanelTab[];

	/** Helper button definitions. */
	protected abstract _getHelperButtons(): Array<{ label: string; fn: () => void }>;

	/** Build provider-specific config rows. */
	protected abstract _buildConfigRows(parent: HTMLElement): void;

	/** Handle the Clear button click. */
	protected abstract _onClear(): void;

	/** Get text content for the Copy All button. */
	protected abstract _getClipboardContent(): string;

	/** Render a single log entry to the appropriate tab container. */
	protected abstract _renderEntry(entry: TEntry): void;

	/** Refresh the info tab content. */
	protected abstract _refreshInfo(): Promise<void>;

	// --- Shared helpers ---

	/** Update status bar text. */
	protected _setStatus(text: string): void {
		this._statusBar.textContent = text;
	}

	/** Get the currently active tab ID. */
	protected get _activeTab(): string {
		return this._activeTabId;
	}

	/** Get the DOM container for a tab by ID. */
	protected _getTabContainer(tabId: string): HTMLElement {
		const container = this._tabContainers.get(tabId);
		if (!container) {
			throw new Error(`Tab container not found: ${tabId}`);
		}
		return container;
	}

	/**
	 * Render a standard log entry row: [num] [dir] [tag?] [method] [detail?] [time].
	 * Auto-scrolls the container to the bottom.
	 */
	protected _renderStandardLogEntry(container: HTMLElement, entry: TEntry): void {
		const el = dom.append(container, $('.debug-rpc-entry'));

		const num = dom.append(el, $('span.debug-rpc-num'));
		num.textContent = String(entry.id).padStart(3, '0');

		const dir = dom.append(el, $('span.debug-rpc-dir'));
		dir.textContent = entry.direction;

		if (entry.tag) {
			const tagEl = dom.append(el, $('span.debug-rpc-tag'));
			tagEl.textContent = entry.tag;
		}

		const meth = dom.append(el, $('span.debug-rpc-method'));
		meth.textContent = entry.method;

		if (entry.detail) {
			const det = dom.append(el, $('span.debug-rpc-detail'));
			det.textContent = entry.detail;
		}

		const time = dom.append(el, $('span.debug-rpc-time'));
		time.textContent = entry.timestamp;

		container.scrollTop = container.scrollHeight;
	}

	/** Create a config row with a label and an input element. */
	protected _addConfigInput(parent: HTMLElement, label: string, placeholder: string): HTMLInputElement {
		const row = dom.append(parent, $('.debug-panel-model-row'));
		dom.append(row, $('label')).textContent = label;
		const input = dom.append(row, $('input.debug-panel-model-select')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = placeholder;
		return input;
	}

	/** Create a config row with a label and a select element. */
	protected _addConfigSelect(parent: HTMLElement, label: string): HTMLSelectElement {
		const row = dom.append(parent, $('.debug-panel-model-row'));
		dom.append(row, $('label')).textContent = label;
		return dom.append(row, $('select.debug-panel-model-select')) as HTMLSelectElement;
	}

	/** Add a labeled value line to the given container. */
	protected _addInfoLine(container: HTMLElement, label: string, value: string, color?: string): void {
		const line = dom.append(container, $('div'));
		line.style.marginBottom = '2px';
		const labelEl = dom.append(line, $('span'));
		labelEl.textContent = label + ': ';
		labelEl.style.color = 'var(--vscode-descriptionForeground)';
		const valueEl = dom.append(line, $('span'));
		valueEl.textContent = value;
		if (color) { valueEl.style.color = color; }
	}

	/** Add a section header to the given container. */
	protected _addInfoSection(container: HTMLElement, title: string): void {
		const h = dom.append(container, $('div'));
		h.style.cssText = 'margin:8px 0 4px;font-weight:bold;color:var(--vscode-foreground);border-bottom:1px solid var(--vscode-widget-border);padding-bottom:2px;';
		h.textContent = title;
	}

	/** Add Refresh + Copy All Info buttons at the bottom of an info container. */
	protected _addInfoFooterButtons(container: HTMLElement, disposables: DisposableStore, refreshFn: () => Promise<void>): void {
		const refreshBtn = dom.append(container, $('button')) as HTMLButtonElement;
		refreshBtn.textContent = 'Refresh';
		refreshBtn.style.cssText = 'margin-top:12px;font-size:11px;padding:4px 12px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:3px;cursor:pointer;';
		disposables.add(dom.addDisposableListener(refreshBtn, 'click', () => refreshFn()));

		const copyInfoBtn = dom.append(container, $('button')) as HTMLButtonElement;
		copyInfoBtn.textContent = 'Copy All Info';
		copyInfoBtn.style.cssText = 'margin-top:4px;margin-left:4px;font-size:11px;padding:4px 12px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:3px;cursor:pointer;';
		disposables.add(dom.addDisposableListener(copyInfoBtn, 'click', () => {
			this._clipboardService.writeText(container.textContent ?? '');
			copyInfoBtn.textContent = 'Copied!';
			setTimeout(() => { copyInfoBtn.textContent = 'Copy All Info'; }, 1500);
		}));
	}

	/** Format a list of log entries as clipboard text. */
	protected _formatEntries(entries: readonly TEntry[]): string {
		return entries
			.map(e => `${String(e.id).padStart(3, '0')} ${e.direction} ${e.tag ? `[${e.tag}] ` : ''}${e.method} ${e.detail} ${e.timestamp}`)
			.join('\n');
	}

	/** Replay all buffered log entries then subscribe for new ones. */
	protected _replayAndSubscribe(): void {
		for (const entry of this._debugLog.entries) {
			this._renderEntry(entry);
		}

		this._eventDisposables.clear();
		this._eventDisposables.add(this._debugLog.onDidAddEntry(entry => {
			this._renderEntry(entry);
		}));
	}

	private _switchTab(tabId: string): void {
		this._activeTabId = tabId;
		for (const [id, btn] of this._tabButtons) {
			btn.classList.toggle('debug-tab-active', id === tabId);
		}
		for (const [id, container] of this._tabContainers) {
			container.style.display = id === tabId ? '' : 'none';
		}
		// Refresh info tabs when activated
		const tabs = this._getTabs();
		const tab = tabs.find(t => t.id === tabId);
		if (tab?.isInfoStyle) {
			this._refreshInfo();
		}
	}
}
