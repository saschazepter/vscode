/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Temporary RPC debug UI for the Copilot SDK integration.
 * Shows the raw event stream and provides helper buttons for common RPC calls.
 * Delete this entire file to remove the debug panel.
 */

import * as dom from '../../base/browser/dom.js';
import { ICopilotSdkService } from '../../platform/copilotSdk/common/copilotSdkService.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { CopilotSdkDebugLog, IDebugLogEntry } from './copilotSdkDebugLog.js';
import { IDialogService } from '../../platform/dialogs/common/dialogs.js';
import { localize } from '../../nls.js';
import { BaseDebugPanel, IDebugPanelTab } from './baseDebugPanel.js';

const $ = dom.$;

export class CopilotSdkDebugPanel extends BaseDebugPanel<IDebugLogEntry, CopilotSdkDebugLog> {

	private _sessionId: string | undefined;
	private _modelSelect!: HTMLSelectElement;
	private _cwdInput!: HTMLInputElement;

	constructor(
		container: HTMLElement,
		debugLog: CopilotSdkDebugLog,
		@ICopilotSdkService private readonly _sdk: ICopilotSdkService,
		@IClipboardService clipboardService: IClipboardService,
		@IDialogService private readonly _dialogService: IDialogService,
	) {
		super(container, debugLog, clipboardService);
		this._setStatus('Not connected');
		this._initializeModels();
	}

	protected override _getTitle(): string { return 'Copilot SDK RPC Debug'; }
	protected override _getInputPlaceholder(): string { return 'Message prompt (used by Send Message)...'; }

	protected override _getTabs(): IDebugPanelTab[] {
		return [
			{ id: 'rpc', label: 'RPC Log' },
			{ id: 'process', label: 'Process Output' },
			{ id: 'info', label: 'Session Info', isInfoStyle: true },
		];
	}

	protected override _buildConfigRows(parent: HTMLElement): void {
		this._modelSelect = this._addConfigSelect(parent, 'Model:');

		this._cwdInput = this._addConfigInput(parent, 'CWD:', '/path/to/project');
		this._cwdInput.value = '/tmp';
	}

	protected override _getHelperButtons(): Array<{ label: string; fn: () => void }> {
		return [
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
			// Status/Health
			{ label: 'Ping', fn: () => this._rpc('ping') },
			{ label: 'CLI Status', fn: () => this._rpc('getStatus') },
			{ label: 'Auth Status', fn: () => this._rpc('getAuthStatus') },
			// Debug
			{ label: 'Dump Sessions (JSON)', fn: () => this._dumpSessionsJson() },
			{ label: 'DELETE ALL SESSIONS', fn: () => this._deleteAllSessions() },
		];
	}

	protected override _onClear(): void {
		if (this._activeTab === 'rpc') {
			dom.clearNode(this._getTabContainer('rpc'));
			this._debugLog.clear('rpc');
		} else {
			dom.clearNode(this._getTabContainer('process'));
			this._debugLog.clear('process');
		}
	}

	protected override _getClipboardContent(): string {
		const stream = this._activeTab === 'rpc' ? 'rpc' : 'process';
		return this._formatEntries(this._debugLog.entries.filter(e => e.stream === stream));
	}

	protected override _renderEntry(entry: IDebugLogEntry): void {
		if (entry.stream === 'process') {
			this._renderProcessEntry(entry);
		} else {
			this._renderStandardLogEntry(this._getTabContainer('rpc'), entry);
		}
	}

	private _renderProcessEntry(entry: IDebugLogEntry): void {
		const container = this._getTabContainer('process');
		const el = dom.append(container, $('.debug-rpc-entry'));
		const time = dom.append(el, $('span.debug-rpc-time'));
		time.textContent = entry.timestamp;
		const streamTag = dom.append(el, $('span.debug-rpc-tag'));
		streamTag.textContent = entry.method; // method holds the stream name for process entries
		const content = dom.append(el, $('span.debug-rpc-detail'));
		content.textContent = entry.detail;
		content.style.whiteSpace = 'pre-wrap';
		content.style.flex = '1';

		container.scrollTop = container.scrollHeight;
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
					const summary = messages.map(m => m.type).join(', ');
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
				case 'ping': {
					this._debugLog.addEntry('\u2192', 'ping', 'ping');
					const pong = await this._sdk.ping('ping');
					this._debugLog.addEntry('\u2190', 'ping', String(pong));
					break;
				}
				case 'getStatus': {
					this._debugLog.addEntry('\u2192', 'getStatus', '');
					const status = await this._sdk.getStatus();
					this._debugLog.addEntry('\u2190', 'getStatus', JSON.stringify(status));
					this._setStatus(`CLI v${status.version} (protocol ${status.protocolVersion})`);
					break;
				}
				case 'getAuthStatus': {
					this._debugLog.addEntry('\u2192', 'getAuthStatus', '');
					const auth = await this._sdk.getAuthStatus();
					this._debugLog.addEntry('\u2190', 'getAuthStatus', JSON.stringify(auth));
					this._setStatus(auth.isAuthenticated ? `Authenticated as ${auth.login} (${auth.authType})` : 'Not authenticated');
					break;
				}
			}
		} catch (err) {
			this._debugLog.addEntry('X', method, String(err instanceof Error ? err.message : err));
		}
	}

	private async _deleteAllSessions(): Promise<void> {
		const confirmation = await this._dialogService.confirm({
			message: localize('sdkDebug.deleteAll', "Delete all sessions?"),
			detail: localize('sdkDebug.deleteAll.detail', "This cannot be undone."),
			primaryButton: localize('delete', "Delete"),
			cancelButton: localize('cancel', "Cancel"),
		});
		if (!confirmation.confirmed) {
			this._debugLog.addEntry('!', 'deleteAll', 'Cancelled by user');
			return;
		}
		try {
			const sessions = await this._sdk.listSessions();
			this._debugLog.addEntry('\u2192', 'deleteAll', `Deleting ${sessions.length} sessions...`);
			let deleted = 0;
			let failed = 0;
			for (const s of sessions) {
				try {
					await this._sdk.deleteSession(s.sessionId);
					deleted++;
				} catch {
					failed++;
				}
			}
			this._sessionId = undefined;
			this._debugLog.addEntry('\u2190', 'deleteAll', `Done: ${deleted} deleted, ${failed} failed`);
			this._setStatus(`Deleted ${deleted} sessions`);
		} catch (err) {
			this._debugLog.addEntry('X', 'deleteAll', String(err));
		}
	}

	private async _dumpSessionsJson(): Promise<void> {
		try {
			this._debugLog.addEntry('\u2192', 'dumpSessions', 'Fetching all sessions + messages...');
			const sessions = await this._sdk.listSessions();
			const dump: Array<{ meta: typeof sessions[0]; eventCount: number; eventTypes: Record<string, number> }> = [];
			for (const s of sessions) {
				try {
					const events = await this._sdk.getMessages(s.sessionId);
					const types: Record<string, number> = {};
					for (const ev of events) { types[ev.type] = (types[ev.type] ?? 0) + 1; }
					dump.push({ meta: s, eventCount: events.length, eventTypes: types });
				} catch {
					dump.push({ meta: s, eventCount: -1, eventTypes: {} });
				}
			}
			const json = JSON.stringify(dump, null, 2);
			this._debugLog.addEntry('\u2190', 'dumpSessions', `${sessions.length} sessions dumped (${json.length} bytes)`);
			await this._clipboardService.writeText(json);
			this._setStatus('Session dump copied to clipboard');
		} catch (err) {
			this._debugLog.addEntry('X', 'dumpSessions', String(err));
		}
	}

	protected override async _refreshInfo(): Promise<void> {
		this._infoDisposables.clear();
		const container = this._getTabContainer('info');
		dom.clearNode(container);

		// SDK State
		this._addInfoSection(container, 'SDK STATE');
		this._addInfoLine(container, 'Debug panel session ID', this._sessionId ?? '(none)');
		this._addInfoLine(container, 'Log entries (RPC)', String(this._debugLog.entries.filter(e => e.stream === 'rpc').length));
		this._addInfoLine(container, 'Log entries (process)', String(this._debugLog.entries.filter(e => e.stream === 'process').length));

		// CLI Status
		this._addInfoSection(container, 'CLI STATUS');
		try {
			const status = await this._sdk.getStatus();
			this._addInfoLine(container, 'CLI version', status.version);
			this._addInfoLine(container, 'Protocol version', String(status.protocolVersion));
		} catch (err) {
			this._addInfoLine(container, 'Error', String(err));
		}

		// Auth Status
		this._addInfoSection(container, 'AUTHENTICATION');
		try {
			const auth = await this._sdk.getAuthStatus();
			this._addInfoLine(container, 'Authenticated', auth.isAuthenticated ? 'Yes' : 'No', auth.isAuthenticated ? 'var(--vscode-terminal-ansiGreen)' : 'var(--vscode-errorForeground)');
			if (auth.login) { this._addInfoLine(container, 'Login', auth.login); }
			if (auth.authType) { this._addInfoLine(container, 'Auth type', auth.authType); }
			if (auth.host) { this._addInfoLine(container, 'Host', auth.host); }
			if (auth.statusMessage) { this._addInfoLine(container, 'Status', auth.statusMessage); }
		} catch (err) {
			this._addInfoLine(container, 'Error', String(err));
		}

		// All sessions
		this._addInfoSection(container, 'ALL SESSIONS');
		try {
			const sessions = await this._sdk.listSessions();
			this._addInfoLine(container, 'Total sessions', String(sessions.length));
			for (const s of sessions) {
				const line = dom.append(container, $('div'));
				line.style.cssText = 'margin:4px 0;padding:4px 6px;border-radius:3px;background:var(--vscode-editor-inactiveSelectionBackground);';
				const idEl = dom.append(line, $('div'));
				idEl.style.cssText = 'font-weight:bold;color:var(--vscode-textLink-foreground);';
				idEl.textContent = `Session ${s.sessionId.substring(0, 12)}`;
				if (s.summary) { this._addInfoLine(container, '  Summary', s.summary); }
				if (s.workspacePath) { this._addInfoLine(container, '  Workspace path', s.workspacePath, 'var(--vscode-terminal-ansiGreen)'); }
				if (s.repository) { this._addInfoLine(container, '  Repository', s.repository); }
				if (s.branch) { this._addInfoLine(container, '  Branch', s.branch); }
				if (s.startTime) { this._addInfoLine(container, '  Started', new Date(s.startTime).toLocaleString()); }
				if (s.modifiedTime) { this._addInfoLine(container, '  Modified', new Date(s.modifiedTime).toLocaleString()); }
				this._addInfoLine(container, '  Remote', s.isRemote ? 'Yes' : 'No');

				// Get messages for this session to show event breakdown
				try {
					const events = await this._sdk.getMessages(s.sessionId);
					const typeCounts: Record<string, number> = {};
					for (const ev of events) {
						typeCounts[ev.type] = (typeCounts[ev.type] ?? 0) + 1;
					}
					this._addInfoLine(container, '  Events', `${events.length} total`);
					for (const [type, count] of Object.entries(typeCounts)) {
						this._addInfoLine(container, `    ${type}`, String(count));
					}
				} catch {
					this._addInfoLine(container, '  Events', '(failed to load)');
				}
			}
		} catch (err) {
			this._addInfoLine(container, 'Error loading sessions', String(err));
		}

		// Models
		this._addInfoSection(container, 'AVAILABLE MODELS');
		try {
			const models = await this._sdk.listModels();
			this._addInfoLine(container, 'Total models', String(models.length));
			for (const m of models) {
				const caps = m.capabilities?.supports;
				const flags: string[] = [];
				if (caps?.vision) { flags.push('vision'); }
				if (caps?.reasoningEffort) { flags.push('reasoning'); }
				if (m.billing?.multiplier && m.billing.multiplier > 1) { flags.push(`${m.billing.multiplier}x cost`); }
				const ctx = m.capabilities?.limits?.max_context_window_tokens;
				if (ctx) { flags.push(`${Math.round(ctx / 1000)}k ctx`); }
				const policy = m.policy?.state;
				if (policy && policy !== 'enabled') { flags.push(policy); }
				const label = flags.length > 0 ? `${m.name ?? m.id} [${flags.join(', ')}]` : (m.name ?? m.id);
				this._addInfoLine(container, `  ${m.id}`, label);
			}
		} catch (err) {
			this._addInfoLine(container, 'Error loading models', String(err));
		}

		// Event stats from debug log
		this._addInfoSection(container, 'EVENT STATISTICS (from debug log)');
		const eventTypeCounts: Record<string, number> = {};
		const sessionEventCounts: Record<string, number> = {};
		for (const entry of this._debugLog.entries) {
			if (entry.stream === 'rpc' && entry.method.startsWith('event:')) {
				const eventType = entry.method.replace('event:', '');
				eventTypeCounts[eventType] = (eventTypeCounts[eventType] ?? 0) + 1;
			}
			if (entry.tag) {
				sessionEventCounts[entry.tag] = (sessionEventCounts[entry.tag] ?? 0) + 1;
			}
		}
		if (Object.keys(eventTypeCounts).length > 0) {
			for (const [type, count] of Object.entries(eventTypeCounts).sort((a, b) => b[1] - a[1])) {
				this._addInfoLine(container, `  ${type}`, String(count));
			}
		} else {
			this._addInfoLine(container, '  (no events yet)', '');
		}

		this._addInfoSection(container, 'EVENTS PER SESSION (from debug log)');
		if (Object.keys(sessionEventCounts).length > 0) {
			for (const [sid, count] of Object.entries(sessionEventCounts).sort((a, b) => b[1] - a[1])) {
				this._addInfoLine(container, `  Session ${sid}`, `${count} events`);
			}
		} else {
			this._addInfoLine(container, '  (no events yet)', '');
		}

		// Footer buttons
		this._addInfoFooterButtons(container, this._infoDisposables, () => this._refreshInfo());
	}
}
