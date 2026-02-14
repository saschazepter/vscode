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
	private _logCount = 0;
	private readonly _logLines: string[] = [];
	private readonly _processLines: string[] = [];
	private _activeTab: 'rpc' | 'process' = 'rpc';

	private readonly _eventDisposables = this._register(new DisposableStore());

	constructor(
		container: HTMLElement,
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
				dom.clearNode(this._rpcLogContainer); this._logCount = 0; this._logLines.length = 0;
			} else {
				dom.clearNode(this._processLogContainer); this._processLines.length = 0;
			}
		}));

		const copyBtn = dom.append(header, $('button')) as HTMLButtonElement;
		copyBtn.textContent = 'Copy All';
		copyBtn.style.cssText = 'margin-left:4px;font-size:11px;padding:2px 8px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:3px;cursor:pointer;';
		this._register(dom.addDisposableListener(copyBtn, 'click', () => {
			const lines = this._activeTab === 'rpc' ? this._logLines : this._processLines;
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

		// Helper buttons
		const helpers = dom.append(this.element, $('.debug-panel-helpers'));
		// allow-any-unicode-next-line
		const btns: Array<{ label: string; fn: () => void }> = [
			{ label: '> Start', fn: () => this._rpc('start') },
			{ label: 'List Models', fn: () => this._rpc('listModels') },
			{ label: 'List Sessions', fn: () => this._rpc('listSessions') },
			{ label: '+ Create Session', fn: () => this._rpc('createSession') },
			{ label: 'Send Message', fn: () => this._rpc('send') },
			{ label: 'Abort', fn: () => this._rpc('abort') },
			{ label: 'Destroy Session', fn: () => this._rpc('destroySession') },
			{ label: 'Stop', fn: () => this._rpc('stop') },
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

		// Initialize: subscribe to events immediately
		this._subscribeToEvents();
		this._initialize();
	}

	private async _initialize(): Promise<void> {
		try {
			this._setStatus('Starting...');
			this._logRpc('→', 'start', '');
			await this._sdk.start();
			this._logRpc('←', 'start', 'OK');

			this._logRpc('→', 'listModels', '');
			const models = await this._sdk.listModels();
			this._logRpc('←', 'listModels', `${models.length} models`);

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
			this._logRpc('X', 'init', String(err));
			this._setStatus('Error');
		}
	}

	private _subscribeToEvents(): void {
		this._eventDisposables.clear();
		this._eventDisposables.add(this._sdk.onSessionEvent(event => {
			const data = JSON.stringify(event.data ?? {});
			const truncated = data.length > 300 ? data.substring(0, 300) + '…' : data;
			this._logRpc('!', `event:${event.type}`, truncated, event.sessionId.substring(0, 8));
		}));
		this._eventDisposables.add(this._sdk.onSessionLifecycle(event => {
			this._logRpc('!', `lifecycle:${event.type}`, '', event.sessionId.substring(0, 8));
		}));
		this._eventDisposables.add(this._sdk.onProcessOutput(output => {
			this._logProcess(output.stream, output.data);
		}));
	}

	private async _rpc(method: string): Promise<void> {
		try {
			switch (method) {
				case 'start': {
					this._logRpc('→', 'start', '');
					await this._sdk.start();
					this._logRpc('←', 'start', 'OK');
					break;
				}
				case 'stop': {
					this._logRpc('→', 'stop', '');
					await this._sdk.stop();
					this._sessionId = undefined;
					this._logRpc('←', 'stop', 'OK');
					break;
				}
				case 'listModels': {
					this._logRpc('→', 'listModels', '');
					const models = await this._sdk.listModels();
					this._logRpc('←', 'listModels', JSON.stringify(models.map(m => m.id)));
					break;
				}
				case 'listSessions': {
					this._logRpc('→', 'listSessions', '');
					const sessions = await this._sdk.listSessions();
					this._logRpc('←', 'listSessions', JSON.stringify(sessions));
					break;
				}
				case 'createSession': {
					const model = this._modelSelect.value;
					const cwd = this._cwdInput.value.trim() || undefined;
					this._logRpc('→', 'createSession', JSON.stringify({ model, streaming: true, workingDirectory: cwd }));
					this._sessionId = await this._sdk.createSession({ model, streaming: true, workingDirectory: cwd });
					this._logRpc('←', 'createSession', this._sessionId);
					this._setStatus(`Session: ${this._sessionId.substring(0, 8)}...`);
					break;
				}
				case 'send': {
					if (!this._sessionId) {
						this._logRpc('X', 'send', 'No session -- create one first');
						return;
					}
					const prompt = this._inputArea.value.trim() || 'What is 2+2? Answer in one word.';
					this._logRpc('→', 'send', JSON.stringify({ sessionId: this._sessionId.substring(0, 8), prompt: prompt.substring(0, 100) }));
					this._setStatus('Sending...');
					await this._sdk.send(this._sessionId, prompt);
					this._logRpc('←', 'send', 'queued');
					break;
				}
				case 'abort': {
					if (!this._sessionId) { this._logRpc('X', 'abort', 'No session'); return; }
					this._logRpc('→', 'abort', this._sessionId.substring(0, 8));
					await this._sdk.abort(this._sessionId);
					this._logRpc('←', 'abort', 'OK');
					break;
				}
				case 'destroySession': {
					if (!this._sessionId) { this._logRpc('X', 'destroySession', 'No session'); return; }
					this._logRpc('→', 'destroySession', this._sessionId.substring(0, 8));
					await this._sdk.destroySession(this._sessionId);
					this._logRpc('←', 'destroySession', 'OK');
					this._sessionId = undefined;
					this._setStatus('Ready');
					break;
				}
			}
		} catch (err) {
			this._logRpc('X', method, String(err instanceof Error ? err.message : err));
		}
	}

	private _logRpc(direction: string, method: string, detail: string, tag?: string): void {
		this._logCount++;
		const timestamp = new Date().toLocaleTimeString();
		const line = `${String(this._logCount).padStart(3, '0')} ${direction} ${tag ? `[${tag}] ` : ''}${method} ${detail} ${timestamp}`;
		this._logLines.push(line);

		const el = dom.append(this._rpcLogContainer, $('.debug-rpc-entry'));

		const num = dom.append(el, $('span.debug-rpc-num'));
		num.textContent = String(this._logCount).padStart(3, '0');

		const dir = dom.append(el, $('span.debug-rpc-dir'));
		dir.textContent = direction;

		if (tag) {
			const tagEl = dom.append(el, $('span.debug-rpc-tag'));
			tagEl.textContent = tag;
		}

		const meth = dom.append(el, $('span.debug-rpc-method'));
		meth.textContent = method;

		if (detail) {
			const det = dom.append(el, $('span.debug-rpc-detail'));
			det.textContent = detail;
		}

		const time = dom.append(el, $('span.debug-rpc-time'));
		time.textContent = new Date().toLocaleTimeString();

		this._rpcLogContainer.scrollTop = this._rpcLogContainer.scrollHeight;
	}

	private _logProcess(stream: string, data: string): void {
		const timestamp = new Date().toLocaleTimeString();
		this._processLines.push(`[${timestamp}] [${stream}] ${data}`);

		const el = dom.append(this._processLogContainer, $('.debug-rpc-entry'));
		const time = dom.append(el, $('span.debug-rpc-time'));
		time.textContent = timestamp;
		const streamTag = dom.append(el, $('span.debug-rpc-tag'));
		streamTag.textContent = stream;
		const content = dom.append(el, $('span.debug-rpc-detail'));
		content.textContent = data;
		content.style.whiteSpace = 'pre-wrap';
		content.style.flex = '1';

		this._processLogContainer.scrollTop = this._processLogContainer.scrollHeight;
	}

	private _setStatus(text: string): void {
		this._statusBar.textContent = text;
	}
}
