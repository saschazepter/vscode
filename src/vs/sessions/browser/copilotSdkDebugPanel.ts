/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Temporary RPC debug UI for the Copilot SDK integration.
 * Shows the raw event stream and provides helper buttons for common RPC calls.
 * Delete this entire file to remove the debug panel.
 */

import './media/copilotSdkDebugPanel.css';
import * as dom from '../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import { ICopilotSdkService } from '../../platform/copilotSdk/common/copilotSdkService.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { CopilotSdkDebugLog, IDebugLogEntry } from './copilotSdkDebugLog.js';

const $ = dom.$;

export class CopilotSdkDebugPanel extends Disposable {

	readonly element: HTMLElement;

	private readonly _rpcLogContainer: HTMLElement;
	private readonly _processLogContainer: HTMLElement;
	private readonly _inputArea: HTMLTextAreaElement;
	private readonly _statusBar: HTMLElement;
	private readonly _cwdInput: HTMLInputElement;
	private readonly _modelSelect: HTMLSelectElement;
	private _sessionId: string | undefined;
	private _activeTab: 'rpc' | 'process' = 'rpc';

	private readonly _eventDisposables = this._register(new DisposableStore());

	constructor(
		container: HTMLElement,
		private readonly _debugLog: CopilotSdkDebugLog,
		@ICopilotSdkService private readonly _sdk: ICopilotSdkService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
	) {
		super();

		this.element = dom.append(container, $('.copilot-sdk-debug-panel'));

		// Header
		const header = dom.append(this.element, $('.debug-panel-header'));
		dom.append(header, $('span')).textContent = 'Copilot SDK RPC Debug';
		const clearBtn = dom.append(header, $('button')) as HTMLButtonElement;
		clearBtn.textContent = 'Clear';
		clearBtn.style.cssText = 'margin-left:auto;font-size:11px;padding:2px 8px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:3px;cursor:pointer;';
		this._register(dom.addDisposableListener(clearBtn, 'click', () => {
			if (this._activeTab === 'rpc') {
				dom.clearNode(this._rpcLogContainer);
				this._debugLog.clear('rpc');
			} else {
				dom.clearNode(this._processLogContainer);
				this._debugLog.clear('process');
			}
		}));

		const copyBtn = dom.append(header, $('button')) as HTMLButtonElement;
		copyBtn.textContent = 'Copy All';
		copyBtn.style.cssText = 'margin-left:4px;font-size:11px;padding:2px 8px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:3px;cursor:pointer;';
		this._register(dom.addDisposableListener(copyBtn, 'click', () => {
			const stream = this._activeTab === 'rpc' ? 'rpc' : 'process';
			const lines = this._debugLog.entries
				.filter(e => e.stream === stream)
				.map(e => `${String(e.id).padStart(3, '0')} ${e.direction} ${e.tag ? `[${e.tag}] ` : ''}${e.method} ${e.detail} ${e.timestamp}`);
			this._clipboardService.writeText(lines.join('\n'));
			copyBtn.textContent = 'Copied!';
			setTimeout(() => { copyBtn.textContent = 'Copy All'; }, 1500);
		}));

		// Status
		this._statusBar = dom.append(this.element, $('.debug-panel-status'));
		this._statusBar.textContent = 'Not connected';

		// Config row: model + cwd
		const configRow = dom.append(this.element, $('.debug-panel-model-row'));
		dom.append(configRow, $('label')).textContent = 'Model:';
		this._modelSelect = dom.append(configRow, $('select.debug-panel-model-select')) as HTMLSelectElement;

		const cwdRow = dom.append(this.element, $('.debug-panel-model-row'));
		dom.append(cwdRow, $('label')).textContent = 'CWD:';
		this._cwdInput = dom.append(cwdRow, $('input.debug-panel-model-select')) as HTMLInputElement;
		this._cwdInput.type = 'text';
		this._cwdInput.placeholder = '/path/to/project';
		this._cwdInput.value = '/tmp';

		// Helper buttons - organized in rows
		const helpers = dom.append(this.element, $('.debug-panel-helpers'));
		// allow-any-unicode-next-line
		const btns: Array<{ label: string; fn: () => void }> = [
			// Lifecycle
			{ label: '> Start', fn: () => this._rpc('start') },
			{ label: 'Stop', fn: () => this._rpc('stop') },
			// Discovery
			{ label: 'List Models', fn: () => this._rpc('listModels') },
			{ label: 'List Sessions', fn: () => this._rpc('listSessions') },
			// Session management
			{ label: '+ Create Session', fn: () => this._rpc('createSession') },
			{ label: 'Resume Session', fn: () => this._rpc('resumeSession') },
			{ label: 'Get Messages', fn: () => this._rpc('getMessages') },
			{ label: 'Destroy Session', fn: () => this._rpc('destroySession') },
			{ label: 'Delete Session', fn: () => this._rpc('deleteSession') },
			// Messaging
			{ label: 'Send', fn: () => this._rpc('send') },
			{ label: 'Send + Wait', fn: () => this._rpc('sendAndWait') },
			{ label: 'Abort', fn: () => this._rpc('abort') },
			// Auth
			{ label: 'Set Token', fn: () => this._rpc('setGitHubToken') },
		];
		for (const { label, fn } of btns) {
			const btn = dom.append(helpers, $('button.debug-helper-btn')) as HTMLButtonElement;
			btn.textContent = label;
			this._register(dom.addDisposableListener(btn, 'click', fn));
		}

		// Tab bar
		const tabBar = dom.append(this.element, $('.debug-panel-tabs'));
		const rpcTab = dom.append(tabBar, $('button.debug-tab.debug-tab-active')) as HTMLButtonElement;
		rpcTab.textContent = 'RPC Log';
		const processTab = dom.append(tabBar, $('button.debug-tab')) as HTMLButtonElement;
		processTab.textContent = 'Process Output';
		const switchTab = (tab: 'rpc' | 'process') => {
			this._activeTab = tab;
			rpcTab.classList.toggle('debug-tab-active', tab === 'rpc');
			processTab.classList.toggle('debug-tab-active', tab === 'process');
			this._rpcLogContainer.style.display = tab === 'rpc' ? '' : 'none';
			this._processLogContainer.style.display = tab === 'process' ? '' : 'none';
		};
		this._register(dom.addDisposableListener(rpcTab, 'click', () => switchTab('rpc')));
		this._register(dom.addDisposableListener(processTab, 'click', () => switchTab('process')));

		// RPC log stream
		this._rpcLogContainer = dom.append(this.element, $('.debug-panel-messages'));

		// Process output log
		this._processLogContainer = dom.append(this.element, $('.debug-panel-messages'));
		this._processLogContainer.style.display = 'none';

		// Free-form input for sending prompts
		const inputRow = dom.append(this.element, $('.debug-panel-input-row'));
		this._inputArea = dom.append(inputRow, $('textarea.debug-panel-input')) as HTMLTextAreaElement;
		this._inputArea.placeholder = 'Message prompt (used by Send Message)...';
		this._inputArea.rows = 2;

		// Replay buffered log entries, then subscribe for new ones
		this._replayAndSubscribe();
		this._initializeModels();
	}

	/**
	 * Render all buffered log entries then subscribe for new ones.
	 */
	private _replayAndSubscribe(): void {
		for (const entry of this._debugLog.entries) {
			this._renderEntry(entry);
		}

		this._eventDisposables.clear();
		this._eventDisposables.add(this._debugLog.onDidAddEntry(entry => {
			this._renderEntry(entry);
		}));
	}

	private _renderEntry(entry: IDebugLogEntry): void {
		if (entry.stream === 'process') {
			this._renderProcessEntry(entry);
		} else {
			this._renderRpcEntry(entry);
		}
	}

	private _renderRpcEntry(entry: IDebugLogEntry): void {
		const el = dom.append(this._rpcLogContainer, $('.debug-rpc-entry'));

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

		this._rpcLogContainer.scrollTop = this._rpcLogContainer.scrollHeight;
	}

	private _renderProcessEntry(entry: IDebugLogEntry): void {
		const el = dom.append(this._processLogContainer, $('.debug-rpc-entry'));
		const time = dom.append(el, $('span.debug-rpc-time'));
		time.textContent = entry.timestamp;
		const streamTag = dom.append(el, $('span.debug-rpc-tag'));
		streamTag.textContent = entry.method; // method holds the stream name for process entries
		const content = dom.append(el, $('span.debug-rpc-detail'));
		content.textContent = entry.detail;
		content.style.whiteSpace = 'pre-wrap';
		content.style.flex = '1';

		this._processLogContainer.scrollTop = this._processLogContainer.scrollHeight;
	}

	private async _initializeModels(): Promise<void> {
		try {
			this._setStatus('Loading models...');
			const models = await this._sdk.listModels();

			dom.clearNode(this._modelSelect);
			for (const m of models) {
				const opt = document.createElement('option');
				opt.value = m.id;
				opt.textContent = m.name ?? m.id;
				this._modelSelect.appendChild(opt);
			}
			const def = models.find(m => m.id === 'gpt-4.1') ?? models[0];
			if (def) { this._modelSelect.value = def.id; }

			this._setStatus('Ready');
		} catch (err) {
			this._debugLog.addEntry('X', 'init', String(err));
			this._setStatus('Error');
		}
	}

	private async _rpc(method: string): Promise<void> {
		try {
			switch (method) {
				case 'start': {
					this._debugLog.addEntry('\u2192', 'start', '');
					await this._sdk.start();
					this._debugLog.addEntry('\u2190', 'start', 'OK');
					break;
				}
				case 'stop': {
					this._debugLog.addEntry('\u2192', 'stop', '');
					await this._sdk.stop();
					this._sessionId = undefined;
					this._debugLog.addEntry('\u2190', 'stop', 'OK');
					break;
				}
				case 'listModels': {
					this._debugLog.addEntry('\u2192', 'listModels', '');
					const models = await this._sdk.listModels();
					this._debugLog.addEntry('\u2190', 'listModels', JSON.stringify(models.map(m => m.id)));
					break;
				}
				case 'listSessions': {
					this._debugLog.addEntry('\u2192', 'listSessions', '');
					const sessions = await this._sdk.listSessions();
					this._debugLog.addEntry('\u2190', 'listSessions', JSON.stringify(sessions));
					break;
				}
				case 'createSession': {
					const model = this._modelSelect.value;
					const cwd = this._cwdInput.value.trim() || undefined;
					this._debugLog.addEntry('\u2192', 'createSession', JSON.stringify({ model, streaming: true, workingDirectory: cwd }));
					this._sessionId = await this._sdk.createSession({ model, streaming: true, workingDirectory: cwd });
					this._debugLog.addEntry('\u2190', 'createSession', this._sessionId);
					this._setStatus(`Session: ${this._sessionId.substring(0, 8)}...`);
					break;
				}
				case 'send': {
					if (!this._sessionId) {
						this._debugLog.addEntry('X', 'send', 'No session -- create one first');
						return;
					}
					const prompt = this._inputArea.value.trim() || 'What is 2+2? Answer in one word.';
					this._debugLog.addEntry('\u2192', 'send', JSON.stringify({ sessionId: this._sessionId.substring(0, 8), prompt: prompt.substring(0, 100) }));
					this._setStatus('Sending...');
					await this._sdk.send(this._sessionId, prompt);
					this._debugLog.addEntry('\u2190', 'send', 'queued');
					break;
				}
				case 'abort': {
					if (!this._sessionId) { this._debugLog.addEntry('X', 'abort', 'No session'); return; }
					this._debugLog.addEntry('\u2192', 'abort', this._sessionId.substring(0, 8));
					await this._sdk.abort(this._sessionId);
					this._debugLog.addEntry('\u2190', 'abort', 'OK');
					break;
				}
				case 'destroySession': {
					if (!this._sessionId) { this._debugLog.addEntry('X', 'destroySession', 'No session'); return; }
					this._debugLog.addEntry('\u2192', 'destroySession', this._sessionId.substring(0, 8));
					await this._sdk.destroySession(this._sessionId);
					this._debugLog.addEntry('\u2190', 'destroySession', 'OK');
					this._sessionId = undefined;
					this._setStatus('Ready');
					break;
				}
				case 'deleteSession': {
					if (!this._sessionId) { this._debugLog.addEntry('X', 'deleteSession', 'No session'); return; }
					this._debugLog.addEntry('\u2192', 'deleteSession', this._sessionId.substring(0, 8));
					await this._sdk.deleteSession(this._sessionId);
					this._debugLog.addEntry('\u2190', 'deleteSession', 'OK');
					this._sessionId = undefined;
					this._setStatus('Ready');
					break;
				}
				case 'resumeSession': {
					if (!this._sessionId) { this._debugLog.addEntry('X', 'resumeSession', 'No session'); return; }
					this._debugLog.addEntry('\u2192', 'resumeSession', this._sessionId.substring(0, 8));
					await this._sdk.resumeSession(this._sessionId, { streaming: true });
					this._debugLog.addEntry('\u2190', 'resumeSession', 'OK');
					break;
				}
				case 'getMessages': {
					if (!this._sessionId) { this._debugLog.addEntry('X', 'getMessages', 'No session'); return; }
					this._debugLog.addEntry('\u2192', 'getMessages', this._sessionId.substring(0, 8));
					const messages = await this._sdk.getMessages(this._sessionId);
					const summary = messages.map(m => `${m.type}${m.data.deltaContent ? ':' + (m.data.deltaContent as string).substring(0, 30) : ''}`).join(', ');
					this._debugLog.addEntry('\u2190', 'getMessages', `${messages.length} events: ${summary.substring(0, 200)}`);
					break;
				}
				case 'sendAndWait': {
					if (!this._sessionId) { this._debugLog.addEntry('X', 'sendAndWait', 'No session'); return; }
					const swPrompt = this._inputArea.value.trim() || 'What is 2+2? Answer in one word.';
					this._debugLog.addEntry('\u2192', 'sendAndWait', JSON.stringify({ sessionId: this._sessionId.substring(0, 8), prompt: swPrompt.substring(0, 100) }));
					this._setStatus('Sending (wait)...');
					const result = await this._sdk.sendAndWait(this._sessionId, swPrompt);
					this._debugLog.addEntry('\u2190', 'sendAndWait', result ? result.content.substring(0, 200) : 'undefined');
					this._setStatus(`Session: ${this._sessionId.substring(0, 8)}...`);
					break;
				}
				case 'setGitHubToken': {
					const token = this._inputArea.value.trim();
					if (!token) { this._debugLog.addEntry('X', 'setGitHubToken', 'Enter token in the text area'); return; }
					this._debugLog.addEntry('\u2192', 'setGitHubToken', `${token.substring(0, 4)}...`);
					await this._sdk.setGitHubToken(token);
					this._debugLog.addEntry('\u2190', 'setGitHubToken', 'OK');
					break;
				}
			}
		} catch (err) {
			this._debugLog.addEntry('X', method, String(err instanceof Error ? err.message : err));
		}
	}

	private _setStatus(text: string): void {
		this._statusBar.textContent = text;
	}
}
