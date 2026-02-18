/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, Dimension, EventType } from '../../../../base/browser/dom.js';
import { createStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ChatDebugLogLevel, IChatDebugLogEvent, IChatDebugService } from '../common/chatDebugService.js';
import { IChatService } from '../common/chatService/chatService.js';
import { chatSessionResourceToId, LocalChatSessionUri } from '../common/model/chatUri.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { safeIntl } from '../../../../base/common/date.js';
import { IChatWidgetService } from './chat.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IUntitledTextResourceEditorInput } from '../../../common/editor.js';

interface IChatDebugLogEventTemplate {
	readonly container: HTMLElement;
	readonly created: HTMLElement;
	readonly category: HTMLElement;
	readonly name: HTMLElement;
	readonly details: HTMLElement;
}

class ChatDebugLogEventRenderer implements IListRenderer<IChatDebugLogEvent, IChatDebugLogEventTemplate> {
	static readonly TEMPLATE_ID = 'chatDebugLogEvent';

	get templateId(): string {
		return ChatDebugLogEventRenderer.TEMPLATE_ID;
	}

	renderTemplate(container: HTMLElement): IChatDebugLogEventTemplate {
		container.classList.add('chat-debug-log-row');

		const created = document.createElement('span');
		created.className = 'chat-debug-log-created';
		const category = document.createElement('span');
		category.className = 'chat-debug-log-category';
		const name = document.createElement('span');
		name.className = 'chat-debug-log-name';
		const details = document.createElement('span');
		details.className = 'chat-debug-log-details';

		container.appendChild(created);
		container.appendChild(category);
		container.appendChild(name);
		container.appendChild(details);

		return { container, created, category, name, details };
	}

	renderElement(element: IChatDebugLogEvent, index: number, templateData: IChatDebugLogEventTemplate): void {
		const dateFormatter = safeIntl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			second: '2-digit',
		});

		templateData.created.textContent = dateFormatter.value.format(element.created);
		templateData.category.textContent = element.category ?? '';
		templateData.name.textContent = element.name;
		templateData.details.textContent = element.details ?? '';

		// Tree indentation for child events
		if (element.parentEventId) {
			templateData.container.classList.add('chat-debug-log-child');
		} else {
			templateData.container.classList.remove('chat-debug-log-child');
		}

		templateData.container.classList.toggle('chat-debug-log-error', element.level === ChatDebugLogLevel.Error);
		templateData.container.classList.toggle('chat-debug-log-warning', element.level === ChatDebugLogLevel.Warning);
		templateData.container.classList.toggle('chat-debug-log-trace', element.level === ChatDebugLogLevel.Trace);
	}

	disposeTemplate(_templateData: IChatDebugLogEventTemplate): void {
		// noop
	}
}

class ChatDebugLogEventDelegate implements IListVirtualDelegate<IChatDebugLogEvent> {
	getHeight(_element: IChatDebugLogEvent): number {
		return 28;
	}

	getTemplateId(_element: IChatDebugLogEvent): string {
		return ChatDebugLogEventRenderer.TEMPLATE_ID;
	}
}

export class ChatDebugEditor extends EditorPane {

	static readonly ID: string = 'workbench.editor.chatDebug';

	private static readonly ACTIVE_WINDOW_VALUE = '__active_window__';

	private container: HTMLElement | undefined;
	private list: WorkbenchList<IChatDebugLogEvent> | undefined;
	private headerContainer: HTMLElement | undefined;
	private detailContainer: HTMLElement | undefined;
	private searchInput: HTMLInputElement | undefined;
	private sessionSelect: HTMLSelectElement | undefined;
	private emptyStateContainer: HTMLElement | undefined;
	private tableHeader: HTMLElement | undefined;
	private listContainer: HTMLElement | undefined;
	private events: IChatDebugLogEvent[] = [];
	private filterText: string = '';
	private currentSessionId: string = '';
	private followActiveWindow: boolean = true;
	private eventListener: IDisposable | undefined;
	private currentDetailText: string = '';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatDebugService private readonly chatDebugService: IChatDebugService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IChatService private readonly chatService: IChatService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(ChatDebugEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		const styleDisposables = new DisposableStore();
		this._register(styleDisposables);
		createStyleSheet(undefined, s => { s.textContent = chatDebugStyles; }, styleDisposables);

		this.container = document.createElement('div');
		this.container.className = 'chat-debug-editor';
		parent.appendChild(this.container);

		// Header
		this.headerContainer = document.createElement('div');
		this.headerContainer.className = 'chat-debug-editor-header';
		this.container.appendChild(this.headerContainer);

		const titleLabel = document.createElement('span');
		titleLabel.className = 'chat-debug-editor-title';
		titleLabel.textContent = localize('chatDebug.title', "Debug View");
		this.headerContainer.appendChild(titleLabel);

		// Session selector
		this.sessionSelect = document.createElement('select');
		this.sessionSelect.className = 'chat-debug-session-select';
		this.populateSessionSelect();
		this._register(addDisposableListener(this.sessionSelect, EventType.CHANGE, () => {
			this.switchSession(this.sessionSelect!.value);
		}));
		this.headerContainer.appendChild(this.sessionSelect);

		// Search
		this.searchInput = document.createElement('input');
		this.searchInput.className = 'chat-debug-search';
		this.searchInput.type = 'text';
		this.searchInput.placeholder = localize('chatDebug.search', "Search...");
		this._register(addDisposableListener(this.searchInput, EventType.INPUT, () => {
			this.filterText = this.searchInput!.value.toLowerCase();
			this.refreshList();
		}));
		this.headerContainer.appendChild(this.searchInput);

		// Table header
		this.tableHeader = document.createElement('div');
		this.tableHeader.className = 'chat-debug-table-header';
		const thCreated = document.createElement('span');
		thCreated.className = 'chat-debug-col-created';
		thCreated.textContent = localize('chatDebug.col.created', "Created");
		const thCategory = document.createElement('span');
		thCategory.className = 'chat-debug-col-category';
		thCategory.textContent = localize('chatDebug.col.category', "Category");
		const thName = document.createElement('span');
		thName.className = 'chat-debug-col-name';
		thName.textContent = localize('chatDebug.col.name', "Name");
		const thDetails = document.createElement('span');
		thDetails.className = 'chat-debug-col-details';
		thDetails.textContent = localize('chatDebug.col.details', "Details");
		this.tableHeader.appendChild(thCreated);
		this.tableHeader.appendChild(thCategory);
		this.tableHeader.appendChild(thName);
		this.tableHeader.appendChild(thDetails);
		this.container.appendChild(this.tableHeader);

		// List container
		this.listContainer = document.createElement('div');
		this.listContainer.className = 'chat-debug-list-container';
		this.container.appendChild(this.listContainer);

		this.list = this._register(this.instantiationService.createInstance(
			WorkbenchList<IChatDebugLogEvent>,
			'ChatDebugLogEvents',
			this.listContainer,
			new ChatDebugLogEventDelegate(),
			[new ChatDebugLogEventRenderer()],
			{
				identityProvider: { getId: (e: IChatDebugLogEvent) => e.id ?? `${e.created.getTime()}-${e.name}` },
				accessibilityProvider: {
					getAriaLabel: (e: IChatDebugLogEvent) => `${e.category ? e.category + ': ' : ''}${e.name}: ${e.details ?? ''}`,
					getWidgetAriaLabel: () => localize('chatDebug.ariaLabel', "Chat Debug Log Events"),
				},
			}
		));

		// Subscribe to events for the active session
		this.resolveInitialSession();

		// When the focused chat widget changes, update if following active window
		this._register(this.chatWidgetService.onDidChangeFocusedSession(() => {
			if (this.followActiveWindow) {
				this.syncToActiveWindow();
			}
		}));

		// When a new chat session is created and we have no session, auto-set to it
		this._register(this.chatService.onDidCreateModel(() => {
			if (!this.currentSessionId) {
				this.syncToActiveWindow();
			}
			// Always refresh the dropdown to include the new session
			this.populateSessionSelect();
		}));

		// When new debug events arrive, refresh the dropdown (new sessions may appear)
		this._register(this.chatDebugService.onDidAddEvent(() => {
			this.populateSessionSelect();
			this.updateEmptyState();
		}));

		// When sessions are disposed, refresh the dropdown
		this._register(this.chatService.onDidDisposeSession(() => {
			this.populateSessionSelect();
		}));

		// Detail panel (shown below list when an event is selected)
		this.detailContainer = document.createElement('div');
		this.detailContainer.className = 'chat-debug-detail-panel';
		this.detailContainer.style.display = 'none';
		this.container.appendChild(this.detailContainer);

		// Empty state message
		this.emptyStateContainer = document.createElement('div');
		this.emptyStateContainer.className = 'chat-debug-empty-state';
		this.emptyStateContainer.textContent = localize('chatDebug.noSession', "No active chat session. Open a chat window to start debugging.");
		this.container.appendChild(this.emptyStateContainer);

		// Resolve event details on selection
		this._register(this.list.onDidChangeSelection(e => {
			const selected = e.elements[0];
			if (selected) {
				this.resolveAndShowDetail(selected);
			} else {
				this.hideDetail();
			}
		}));

		this.refreshList();
	}

	/**
	 * Resolve the initial session: default to the active chat window's session.
	 * If no chat window is active, leave empty (don't log anything).
	 */
	private resolveInitialSession(): void {
		this.followActiveWindow = true;
		this.syncToActiveWindow();
	}

	/**
	 * Sync the debug editor to the currently active chat window's session.
	 */
	private syncToActiveWindow(): void {
		const activeSessionId = this.getActiveWindowSessionId();
		if (activeSessionId) {
			const changed = this.currentSessionId !== activeSessionId;
			this.currentSessionId = activeSessionId;
			this.chatDebugService.activeSessionId = activeSessionId;
			this.loadEventsForSession(activeSessionId);
			if (changed) {
				this.chatDebugService.invokeProviders(activeSessionId);
			}
		} else {
			// No active chat window - clear the view
			this.currentSessionId = '';
			this.chatDebugService.activeSessionId = undefined;
			this.events = [];
			this.eventListener?.dispose();
		}
		this.populateSessionSelect();
		this.updateEmptyState();
		this.refreshList();
	}

	/**
	 * Get the session ID of the currently active (last focused) chat window.
	 */
	private getActiveWindowSessionId(): string | undefined {
		const widget = this.chatWidgetService.lastFocusedWidget;
		if (widget?.viewModel?.sessionResource) {
			return chatSessionResourceToId(widget.viewModel.sessionResource);
		}
		return undefined;
	}

	/**
	 * Show/hide the empty state and content based on whether we have a valid session.
	 */
	private updateEmptyState(): void {
		const hasSession = !!this.currentSessionId;
		if (this.emptyStateContainer) {
			this.emptyStateContainer.style.display = hasSession ? 'none' : '';
		}
		if (this.tableHeader) {
			this.tableHeader.style.display = hasSession ? '' : 'none';
		}
		if (this.listContainer) {
			this.listContainer.style.display = hasSession ? '' : 'none';
		}
	}

	private populateSessionSelect(): void {
		if (!this.sessionSelect) {
			return;
		}
		while (this.sessionSelect.firstChild) {
			this.sessionSelect.removeChild(this.sessionSelect.firstChild);
		}

		// "Active Window" option - follows the focused chat widget
		const activeOption = document.createElement('option');
		activeOption.value = ChatDebugEditor.ACTIVE_WINDOW_VALUE;
		activeOption.textContent = localize('chatDebug.activeWindow', "Active Window");
		if (this.followActiveWindow) {
			activeOption.selected = true;
		}
		this.sessionSelect.appendChild(activeOption);

		// Only show sessions that have debug log events in memory
		const sessionIds = this.chatDebugService.getSessionIds();
		if (sessionIds.length > 0) {
			const separator = document.createElement('option');
			separator.disabled = true;
			separator.textContent = '-----------';
			this.sessionSelect.appendChild(separator);

			for (const sessionId of sessionIds) {
				const option = document.createElement('option');
				option.value = sessionId;
				const sessionUri = LocalChatSessionUri.forSession(sessionId);
				const title = this.chatService.getSessionTitle(sessionUri) || sessionId;
				option.textContent = title;
				if (!this.followActiveWindow && sessionId === this.currentSessionId) {
					option.selected = true;
				}
				this.sessionSelect.appendChild(option);
			}
		}
	}

	private switchSession(sessionId: string): void {
		if (sessionId === ChatDebugEditor.ACTIVE_WINDOW_VALUE) {
			// Switch back to following the active window
			this.followActiveWindow = true;
			this.syncToActiveWindow();
			return;
		}

		// User picked a specific session - stop following active window
		this.followActiveWindow = false;
		this.currentSessionId = sessionId;
		this.chatDebugService.activeSessionId = sessionId;
		this.loadEventsForSession(sessionId);
		this.updateEmptyState();
		this.refreshList();

		// Invoke providers for the newly selected session
		this.chatDebugService.invokeProviders(sessionId);
	}

	private loadEventsForSession(sessionId: string): void {
		this.eventListener?.dispose();
		this.events = [...this.chatDebugService.getEvents(sessionId || undefined)];
		this.eventListener = this._register(this.chatDebugService.onDidAddEvent(e => {
			if (!this.currentSessionId || e.sessionId === this.currentSessionId) {
				this.events.push(e);
				this.refreshList();
			}
		}));
	}

	private refreshList(): void {
		if (!this.list) {
			return;
		}

		let filtered = this.events;
		if (this.filterText) {
			filtered = this.events.filter(e =>
				e.name.toLowerCase().includes(this.filterText) ||
				(e.details?.toLowerCase().includes(this.filterText)) ||
				(e.category?.toLowerCase().includes(this.filterText))
			);
		}

		this.list.splice(0, this.list.length, filtered);
	}

	private async resolveAndShowDetail(event: IChatDebugLogEvent): Promise<void> {
		if (!this.detailContainer) {
			return;
		}
		const resolved = event.id ? await this.chatDebugService.resolveEvent(event.id) : undefined;

		if (!resolved && !event.details) {
			this.hideDetail();
			return;
		}

		this.detailContainer.style.display = '';
		this.detailContainer.textContent = '';

		// Header with full-screen and close buttons
		const header = document.createElement('div');
		header.className = 'chat-debug-detail-header';

		const fullScreenButton = document.createElement('button');
		fullScreenButton.className = 'chat-debug-detail-button';
		fullScreenButton.title = localize('chatDebug.openInEditor', "Open in Editor");
		fullScreenButton.setAttribute('aria-label', localize('chatDebug.openInEditor', "Open in Editor"));
		fullScreenButton.textContent = '\u2922'; // full size character
		fullScreenButton.addEventListener('click', () => {
			this.editorService.openEditor({ contents: this.currentDetailText, resource: undefined } satisfies IUntitledTextResourceEditorInput);
		});
		header.appendChild(fullScreenButton);

		const closeButton = document.createElement('button');
		closeButton.className = 'chat-debug-detail-button';
		closeButton.title = localize('chatDebug.closeDetail', "Close");
		closeButton.setAttribute('aria-label', localize('chatDebug.closeDetail', "Close"));
		closeButton.textContent = '\u00D7'; // × character
		closeButton.addEventListener('click', () => {
			this.list?.setSelection([]);
			this.hideDetail();
		});
		header.appendChild(closeButton);
		this.detailContainer.appendChild(header);

		const pre = document.createElement('pre');
		if (resolved) {
			this.currentDetailText = resolved;
		} else {
			this.currentDetailText = `${event.name}\n${event.details ?? ''}`;
		}
		pre.textContent = this.currentDetailText;
		this.detailContainer.appendChild(pre);
	}

	private hideDetail(): void {
		if (this.detailContainer) {
			this.detailContainer.style.display = 'none';
			this.detailContainer.textContent = '';
		}
	}

	override focus(): void {
		this.list?.domFocus();
	}

	override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible) {
			// Refresh session and events each time the editor becomes visible
			if (this.followActiveWindow) {
				this.syncToActiveWindow();
			} else {
				this.populateSessionSelect();
				this.loadEventsForSession(this.currentSessionId);
				this.updateEmptyState();
				this.refreshList();
			}
		}
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
		if (this.list) {
			const headerHeight = (this.headerContainer?.offsetHeight ?? 40) + 28; // header + table header
			const detailHeight = this.detailContainer?.offsetHeight ?? 0;
			this.list.layout(dimension.height - headerHeight - detailHeight, dimension.width);
		}
	}

	override dispose(): void {
		this.eventListener?.dispose();
		super.dispose();
	}
}

const chatDebugStyles = `
.chat-debug-editor {
	display: flex;
	flex-direction: column;
	overflow: hidden;
}
.chat-debug-editor-header {
	display: flex;
	align-items: center;
	padding: 8px 16px;
	gap: 12px;
	flex-shrink: 0;
}
.chat-debug-editor-title {
	font-weight: bold;
	font-size: 14px;
}
.chat-debug-search {
	flex: 1;
	max-width: 300px;
	padding: 4px 8px;
	border: 1px solid var(--vscode-input-border, transparent);
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border-radius: 2px;
	outline: none;
}
.chat-debug-search:focus {
	border-color: var(--vscode-focusBorder);
}
.chat-debug-session-select {
	padding: 4px 8px;
	border: 1px solid var(--vscode-input-border, transparent);
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border-radius: 2px;
	outline: none;
	max-width: 300px;
}
.chat-debug-session-select:focus {
	border-color: var(--vscode-focusBorder);
}
.chat-debug-table-header {
	display: flex;
	padding: 4px 16px;
	font-weight: 600;
	font-size: 12px;
	border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
	flex-shrink: 0;
	color: var(--vscode-foreground);
	opacity: 0.8;
}
.chat-debug-table-header .chat-debug-col-created {
	width: 160px;
	flex-shrink: 0;
}
.chat-debug-table-header .chat-debug-col-category {
	width: 100px;
	flex-shrink: 0;
}
.chat-debug-table-header .chat-debug-col-name {
	width: 200px;
	flex-shrink: 0;
}
.chat-debug-table-header .chat-debug-col-details {
	flex: 1;
}
.chat-debug-list-container {
	flex: 1;
	overflow: hidden;
}
.chat-debug-log-row {
	display: flex;
	align-items: center;
	padding: 0 16px;
	height: 28px;
	border-bottom: 1px solid var(--vscode-widget-border, transparent);
	font-size: 12px;
}
.chat-debug-log-row .chat-debug-log-created {
	width: 160px;
	flex-shrink: 0;
	color: var(--vscode-descriptionForeground);
}
.chat-debug-log-row .chat-debug-log-category {
	width: 100px;
	flex-shrink: 0;
	opacity: 0.8;
	font-size: 11px;
}
.chat-debug-log-row .chat-debug-log-name {
	width: 200px;
	flex-shrink: 0;
	font-weight: 500;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.chat-debug-log-row .chat-debug-log-details {
	flex: 1;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.chat-debug-log-row.chat-debug-log-child {
	padding-left: 32px;
	opacity: 0.9;
}
.chat-debug-log-row.chat-debug-log-error {
	background-color: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
	color: var(--vscode-errorForeground);
}
.chat-debug-log-row.chat-debug-log-warning {
	background-color: var(--vscode-inputValidation-warningBackground, rgba(255, 204, 0, 0.1));
}
.chat-debug-log-row.chat-debug-log-trace {
	opacity: 0.7;
}
.chat-debug-detail-panel {
	flex-shrink: 0;
	max-height: 200px;
	overflow-y: auto;
	padding: 8px 16px;
	border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
	background: var(--vscode-editorWidget-background);
	font-size: 12px;
	position: relative;
}
.chat-debug-detail-header {
	display: flex;
	justify-content: flex-end;
	position: sticky;
	top: 0;
}
.chat-debug-detail-button {
	border: none;
	background: transparent;
	color: var(--vscode-foreground);
	cursor: pointer;
	font-size: 16px;
	line-height: 1;
	padding: 2px 6px;
	border-radius: 4px;
	opacity: 0.7;
}
.chat-debug-detail-button:hover {
	opacity: 1;
	background: var(--vscode-toolbar-hoverBackground);
}
.chat-debug-detail-panel pre {
	margin: 0;
	white-space: pre-wrap;
	word-break: break-word;
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 12px;
}
.chat-debug-empty-state {
	display: flex;
	align-items: center;
	justify-content: center;
	flex: 1;
	color: var(--vscode-descriptionForeground);
	font-size: 13px;
	padding: 24px;
	text-align: center;
}
`;
