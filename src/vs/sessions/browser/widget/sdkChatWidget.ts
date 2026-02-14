/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sdkChatWidget.css';
import * as dom from '../../../base/browser/dom.js';
import { Codicon } from '../../../base/common/codicons.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { renderMarkdown } from '../../../base/browser/markdownRenderer.js';
import { localize } from '../../../nls.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { type ICopilotModelInfo, ICopilotSdkService } from '../../../platform/copilotSdk/common/copilotSdkService.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { SdkChatModel, type ISdkMarkdownPart, type ISdkThinkingPart, type ISdkToolCallPart, type ISdkChatModelChange, type SdkChatPart } from './sdkChatModel.js';
import { CopilotSdkDebugLog } from '../copilotSdkDebugLog.js';

const $ = dom.$;

interface IRenderedTurn {
	readonly turnId: string;
	readonly element: HTMLElement;
	readonly partElements: Map<number, HTMLElement>;
}

/**
 * Chat widget powered by the Copilot SDK. Uses `SdkChatModel` for data and
 * renders using VS Code's `renderMarkdown` for rich content. No dependency
 * on `ChatWidget`, `ChatInputPart`, `ChatService`, or the copilot-chat extension.
 */
export class SdkChatWidget extends Disposable {

	readonly element: HTMLElement;

	private readonly _messagesContainer: HTMLElement;
	private readonly _welcomeContainer: HTMLElement;
	private readonly _inputArea: HTMLElement;
	private readonly _textarea: HTMLTextAreaElement;
	private readonly _sendBtn: HTMLButtonElement;
	private readonly _abortBtn: HTMLButtonElement;
	private readonly _modelSelect: HTMLSelectElement;
	private readonly _statusBar: HTMLElement;

	private readonly _model: SdkChatModel;
	private readonly _renderedTurns = new Map<string, IRenderedTurn>();

	private _sessionId: string | undefined;
	private _isStreaming = false;
	private _autoScroll = true;

	private readonly _eventDisposables = this._register(new DisposableStore());

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event;

	private readonly _onDidChangeSessionId = this._register(new Emitter<string | undefined>());
	readonly onDidChangeSessionId: Event<string | undefined> = this._onDidChangeSessionId.event;

	constructor(
		container: HTMLElement,
		@ICopilotSdkService private readonly _sdk: ICopilotSdkService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._model = this._register(new SdkChatModel());

		this.element = dom.append(container, $('.sdk-chat-widget'));

		// Welcome
		this._welcomeContainer = dom.append(this.element, $('.sdk-chat-welcome'));
		dom.append(this._welcomeContainer, $('.sdk-chat-welcome-title')).textContent = localize('sdkChat.welcome.title', "Copilot Agent");
		dom.append(this._welcomeContainer, $('.sdk-chat-welcome-subtitle')).textContent = localize('sdkChat.welcome.subtitle', "Ask me anything. Powered by the Copilot SDK.");

		// Messages
		this._messagesContainer = dom.append(this.element, $('.sdk-chat-messages'));
		this._messagesContainer.style.display = 'none';
		this._register(dom.addDisposableListener(this._messagesContainer, 'scroll', () => {
			const { scrollTop, scrollHeight, clientHeight } = this._messagesContainer;
			this._autoScroll = scrollHeight - scrollTop - clientHeight < 50;
		}));

		// Status
		this._statusBar = dom.append(this.element, $('.sdk-chat-status'));
		this._setStatus(localize('sdkChat.status.initializing', "Initializing..."));

		// Input area
		this._inputArea = dom.append(this.element, $('.sdk-chat-input-area'));

		const modelRow = dom.append(this._inputArea, $('.sdk-chat-model-row'));
		dom.append(modelRow, $('.sdk-chat-model-label')).textContent = localize('sdkChat.model', "Model:");
		this._modelSelect = dom.append(modelRow, $('select.sdk-chat-model-select')) as HTMLSelectElement;

		const inputRow = dom.append(this._inputArea, $('.sdk-chat-input-row'));
		const inputWrapper = dom.append(inputRow, $('.sdk-chat-input-wrapper'));
		this._textarea = dom.append(inputWrapper, $('textarea.sdk-chat-textarea')) as HTMLTextAreaElement;
		this._textarea.placeholder = localize('sdkChat.placeholder', "Ask Copilot...");
		this._textarea.rows = 1;

		this._sendBtn = dom.append(inputRow, $('button.sdk-chat-send-btn')) as HTMLButtonElement;
		dom.append(this._sendBtn, $(`span${ThemeIcon.asCSSSelector(Codicon.send)}`)).classList.add('codicon');

		this._abortBtn = dom.append(inputRow, $('button.sdk-chat-abort-btn')) as HTMLButtonElement;
		dom.append(this._abortBtn, $(`span${ThemeIcon.asCSSSelector(Codicon.debugStop)}`)).classList.add('codicon');
		this._abortBtn.style.display = 'none';

		// Wire events
		this._register(dom.addDisposableListener(this._textarea, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._handleSend(); }
		}));
		this._register(dom.addDisposableListener(this._textarea, 'input', () => this._autoResizeTextarea()));
		this._register(dom.addDisposableListener(this._sendBtn, 'click', () => this._handleSend()));
		this._register(dom.addDisposableListener(this._abortBtn, 'click', () => this._handleAbort()));

		// Model changes -> rendering
		this._register(this._model.onDidChange(change => this._onModelChange(change)));

		// SDK events -> model
		this._subscribeToSdkEvents();

		// Init
		this._initialize();
	}

	focus(): void { this._textarea.focus(); }
	get sessionId(): string | undefined { return this._sessionId; }
	get isStreaming(): boolean { return this._isStreaming; }
	get model(): SdkChatModel { return this._model; }

	// --- Init ---

	private async _initialize(): Promise<void> {
		try {
			CopilotSdkDebugLog.instance?.addEntry('\u2192', 'widget.start', '');
			await this._sdk.start();
			CopilotSdkDebugLog.instance?.addEntry('\u2190', 'widget.start', 'OK');
			CopilotSdkDebugLog.instance?.addEntry('\u2192', 'widget.listModels', '');
			const models = await this._sdk.listModels();
			CopilotSdkDebugLog.instance?.addEntry('\u2190', 'widget.listModels', `${models.length} models`);
			this._populateModelSelect(models);
			this._setStatus(localize('sdkChat.status.ready', "Ready"));
			this._textarea.disabled = false;
			this._sendBtn.disabled = false;
		} catch (err) {
			this._logService.error('[SdkChatWidget] Init failed:', err);
			this._setStatus(localize('sdkChat.status.error', "Failed to connect to Copilot SDK"));
		}
	}

	private _populateModelSelect(models: ICopilotModelInfo[]): void {
		dom.clearNode(this._modelSelect);
		for (const m of models) {
			const opt = document.createElement('option');
			opt.value = m.id;
			opt.textContent = m.name ?? m.id;
			this._modelSelect.appendChild(opt);
		}
		const preferred = models.find(m => m.id === 'claude-sonnet-4') ?? models.find(m => m.id === 'gpt-4.1') ?? models[0];
		if (preferred) { this._modelSelect.value = preferred.id; }
	}

	// --- SDK events -> model ---

	private _subscribeToSdkEvents(): void {
		this._eventDisposables.clear();
		this._eventDisposables.add(this._sdk.onSessionEvent(event => {
			if (this._sessionId && event.sessionId !== this._sessionId) { return; }
			this._model.handleEvent(event);
		}));
	}

	// --- Model -> DOM ---

	private _onModelChange(change: ISdkChatModelChange): void {
		// Ensure messages visible
		if (this._model.turns.length > 0) {
			this._welcomeContainer.style.display = 'none';
			this._messagesContainer.style.display = '';
		}

		switch (change.type) {
			case 'turnAdded': this._renderTurn(change.turnId); break;
			case 'partAdded': this._renderPart(change.turnId, change.partIndex!); break;
			case 'partUpdated': this._updatePart(change.turnId, change.partIndex!); break;
			case 'turnCompleted': this._finalizeTurn(change.turnId); break;
		}
		this._scrollToBottom();
	}

	private _renderTurn(turnId: string): void {
		const turn = this._model.turns.find(t => t.id === turnId);
		if (!turn) { return; }

		const turnEl = dom.append(this._messagesContainer, $(`.sdk-chat-message.${turn.role}`));

		const header = dom.append(turnEl, $('.sdk-chat-message-header'));
		const headerIcon = turn.role === 'user' ? Codicon.account : Codicon.sparkle;
		dom.append(header, $(`span${ThemeIcon.asCSSSelector(headerIcon)}`)).classList.add('codicon');
		dom.append(header, $('span')).textContent = turn.role === 'user'
			? localize('sdkChat.you', "You")
			: localize('sdkChat.copilot', "Copilot");

		const rendered: IRenderedTurn = { turnId, element: turnEl, partElements: new Map() };
		this._renderedTurns.set(turnId, rendered);

		for (let i = 0; i < turn.parts.length; i++) {
			this._appendPart(turn.parts[i], turnEl, rendered, i);
		}
	}

	private _renderPart(turnId: string, partIndex: number): void {
		const rendered = this._renderedTurns.get(turnId);
		const turn = this._model.turns.find(t => t.id === turnId);
		if (!rendered || !turn) { return; }
		this._appendPart(turn.parts[partIndex], rendered.element, rendered, partIndex);
	}

	private _appendPart(part: SdkChatPart, container: HTMLElement, rendered: IRenderedTurn, index: number): void {
		if (!part) { return; }
		const el = this._createPartElement(part);
		container.appendChild(el);
		rendered.partElements.set(index, el);
	}

	private _createPartElement(part: SdkChatPart): HTMLElement {
		switch (part.kind) {
			case 'markdownContent': return this._createMarkdownEl(part);
			case 'thinking': return this._createThinkingEl(part);
			case 'toolInvocation': return this._createToolCallEl(part);
			case 'progress': return this._createProgressEl(part.message);
		}
	}

	private _createMarkdownEl(part: ISdkMarkdownPart): HTMLElement {
		const el = $('.sdk-chat-message-body');
		if (part.isStreaming) { el.classList.add('sdk-chat-streaming-cursor'); }
		el.appendChild(renderMarkdown(part.content).element);
		return el;
	}

	private _createThinkingEl(part: ISdkThinkingPart): HTMLElement {
		const el = $('.sdk-chat-reasoning');
		el.textContent = part.content;
		return el;
	}

	private _createToolCallEl(part: ISdkToolCallPart): HTMLElement {
		const el = $(`.sdk-chat-tool-call.${part.state === 'running' ? 'running' : 'complete'}`);
		const iconCodicon = part.state === 'running' ? Codicon.loading : Codicon.check;
		const iconEl = dom.append(el, $(`span${ThemeIcon.asCSSSelector(iconCodicon)}`));
		iconEl.classList.add('codicon');
		if (part.state === 'running') { iconEl.classList.add('codicon-loading'); }
		dom.append(el, $('span.sdk-chat-tool-name')).textContent = part.toolName;
		dom.append(el, $('span.sdk-chat-tool-status')).textContent = part.state === 'running'
			? localize('sdkChat.tool.running', "Running...")
			: localize('sdkChat.tool.done', "Done");
		return el;
	}

	private _createProgressEl(message: string): HTMLElement {
		const el = $('.sdk-chat-progress');
		el.textContent = message;
		return el;
	}

	private _updatePart(turnId: string, partIndex: number): void {
		const rendered = this._renderedTurns.get(turnId);
		const turn = this._model.turns.find(t => t.id === turnId);
		if (!rendered || !turn) { return; }
		const part = turn.parts[partIndex];
		const existingEl = rendered.partElements.get(partIndex);
		if (!part || !existingEl) { return; }

		switch (part.kind) {
			case 'markdownContent': {
				dom.clearNode(existingEl);
				existingEl.appendChild(renderMarkdown(part.content).element);
				existingEl.classList.toggle('sdk-chat-streaming-cursor', part.isStreaming);
				break;
			}
			case 'thinking': {
				existingEl.textContent = part.content;
				break;
			}
			case 'toolInvocation': {
				const newEl = this._createToolCallEl(part);
				existingEl.replaceWith(newEl);
				rendered.partElements.set(partIndex, newEl);
				break;
			}
		}
	}

	private _finalizeTurn(turnId: string): void {
		const rendered = this._renderedTurns.get(turnId);
		if (rendered) {
			for (const el of rendered.partElements.values()) {
				el.classList.remove('sdk-chat-streaming-cursor');
			}
		}
		this._setStreaming(false);
		this._setStatus(localize('sdkChat.status.ready', "Ready"));
	}

	// --- Send / Abort ---

	private async _handleSend(): Promise<void> {
		const prompt = this._textarea.value.trim();
		if (!prompt || this._isStreaming) { return; }

		this._textarea.value = '';
		this._autoResizeTextarea();
		this._model.addUserMessage(prompt);
		this._setStreaming(true);

		try {
			if (!this._sessionId) {
				const model = this._modelSelect.value;
				this._setStatus(localize('sdkChat.status.creating', "Creating session..."));
				CopilotSdkDebugLog.instance?.addEntry('\u2192', 'widget.createSession', JSON.stringify({ model }));
				this._sessionId = await this._sdk.createSession({ model, streaming: true });
				CopilotSdkDebugLog.instance?.addEntry('\u2190', 'widget.createSession', this._sessionId.substring(0, 8));
				this._onDidChangeSessionId.fire(this._sessionId);
			}

			this._setStatus(localize('sdkChat.status.thinking', "Thinking..."));
			CopilotSdkDebugLog.instance?.addEntry('\u2192', 'widget.send', prompt.substring(0, 80));
			await this._sdk.send(this._sessionId, prompt);
			CopilotSdkDebugLog.instance?.addEntry('\u2190', 'widget.send', 'queued');
		} catch (err) {
			this._logService.error('[SdkChatWidget] Send failed:', err);
			this._setStreaming(false);
			this._setStatus(localize('sdkChat.status.sendFailed', "Send failed"));
		}
	}

	private async _handleAbort(): Promise<void> {
		if (!this._sessionId) { return; }
		try {
			CopilotSdkDebugLog.instance?.addEntry('\u2192', 'widget.abort', this._sessionId.substring(0, 8));
			await this._sdk.abort(this._sessionId);
			CopilotSdkDebugLog.instance?.addEntry('\u2190', 'widget.abort', 'OK');
		} catch (err) {
			this._logService.error('[SdkChatWidget] Abort failed:', err);
		}
	}

	// --- UI helpers ---

	private _setStreaming(streaming: boolean): void {
		this._isStreaming = streaming;
		this._sendBtn.style.display = streaming ? 'none' : '';
		this._abortBtn.style.display = streaming ? '' : 'none';
		this._textarea.disabled = streaming;
		this._onDidChangeState.fire();
	}

	private _setStatus(text: string): void { this._statusBar.textContent = text; }

	private _scrollToBottom(): void {
		if (this._autoScroll) { this._messagesContainer.scrollTop = this._messagesContainer.scrollHeight; }
	}

	private _autoResizeTextarea(): void {
		this._textarea.style.height = 'auto';
		this._textarea.style.height = `${Math.min(this._textarea.scrollHeight, 200)}px`;
	}

	// --- Public API ---

	async newSession(): Promise<void> {
		if (this._sessionId) {
			try { await this._sdk.destroySession(this._sessionId); } catch { /* best-effort */ }
		}
		this._sessionId = undefined;
		this._model.clear();
		this._renderedTurns.clear();
		dom.clearNode(this._messagesContainer);
		this._messagesContainer.style.display = 'none';
		this._welcomeContainer.style.display = '';
		this._setStreaming(false);
		this._setStatus(localize('sdkChat.status.ready', "Ready"));
		this._onDidChangeSessionId.fire(undefined);
		this._textarea.focus();
	}

	async loadSession(sessionId: string): Promise<void> {
		if (this._sessionId === sessionId) { return; }

		this._model.clear();
		this._renderedTurns.clear();
		dom.clearNode(this._messagesContainer);

		this._sessionId = sessionId;
		this._onDidChangeSessionId.fire(sessionId);

		try {
			CopilotSdkDebugLog.instance?.addEntry('\u2192', 'widget.loadSession', sessionId.substring(0, 8));
			await this._sdk.resumeSession(sessionId, { streaming: true });
			const events = await this._sdk.getMessages(sessionId);
			CopilotSdkDebugLog.instance?.addEntry('\u2190', 'widget.loadSession', `${events.length} events`);

			this._welcomeContainer.style.display = 'none';
			this._messagesContainer.style.display = '';

			for (const event of events) { this._model.handleEvent(event); }
			this._setStatus(localize('sdkChat.status.ready', "Ready"));
		} catch (err) {
			this._logService.error(`[SdkChatWidget] Load session failed:`, err);
			this._setStatus(localize('sdkChat.status.loadFailed', "Failed to load session"));
		}
		this._scrollToBottom();
	}

	layout(_width: number, _height: number): void {
		// CSS flexbox handles layout
	}
}
