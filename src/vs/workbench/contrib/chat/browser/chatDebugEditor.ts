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
import { chatSessionResourceToId } from '../common/model/chatUri.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { safeIntl } from '../../../../base/common/date.js';

interface IChatDebugLogEventTemplate {
	readonly container: HTMLElement;
	readonly created: HTMLElement;
	readonly name: HTMLElement;
	readonly contents: HTMLElement;
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
		const name = document.createElement('span');
		name.className = 'chat-debug-log-name';
		const contents = document.createElement('span');
		contents.className = 'chat-debug-log-contents';

		container.appendChild(created);
		container.appendChild(name);
		container.appendChild(contents);

		return { container, created, name, contents };
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
		templateData.name.textContent = element.name;
		templateData.contents.textContent = element.contents ?? '';

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

	private container: HTMLElement | undefined;
	private list: WorkbenchList<IChatDebugLogEvent> | undefined;
	private headerContainer: HTMLElement | undefined;
	private searchInput: HTMLInputElement | undefined;
	private sessionSelect: HTMLSelectElement | undefined;
	private events: IChatDebugLogEvent[] = [];
	private filterText: string = '';
	private currentSessionId: string = '';
	private eventListener: IDisposable | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatDebugService private readonly chatDebugService: IChatDebugService,
	) {
		super(ChatDebugEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		console.log('[ChatDebugEditor] createEditor called');
		try {
			const styleDisposables = new DisposableStore();
			this._register(styleDisposables);
			createStyleSheet(undefined, s => { s.textContent = chatDebugStyles; }, styleDisposables);
			console.log('[ChatDebugEditor] stylesheet created');

			this.container = document.createElement('div');
			this.container.className = 'chat-debug-editor';
			parent.appendChild(this.container);
			console.log('[ChatDebugEditor] container appended, parent children:', parent.childNodes.length);

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
			const tableHeader = document.createElement('div');
			tableHeader.className = 'chat-debug-table-header';
			const thCreated = document.createElement('span');
			thCreated.className = 'chat-debug-col-created';
			thCreated.textContent = localize('chatDebug.col.created', "Created");
			const thName = document.createElement('span');
			thName.className = 'chat-debug-col-name';
			thName.textContent = localize('chatDebug.col.name', "Name");
			const thContents = document.createElement('span');
			thContents.className = 'chat-debug-col-contents';
			thContents.textContent = localize('chatDebug.col.contents', "Contents");
			tableHeader.appendChild(thCreated);
			tableHeader.appendChild(thName);
			tableHeader.appendChild(thContents);
			this.container.appendChild(tableHeader);

			// List container
			const listContainer = document.createElement('div');
			listContainer.className = 'chat-debug-list-container';
			this.container.appendChild(listContainer);

			this.list = this._register(this.instantiationService.createInstance(
				WorkbenchList<IChatDebugLogEvent>,
				'ChatDebugLogEvents',
				listContainer,
				new ChatDebugLogEventDelegate(),
				[new ChatDebugLogEventRenderer()],
				{
					identityProvider: { getId: (e: IChatDebugLogEvent) => `${e.created.getTime()}-${e.name}` },
					accessibilityProvider: {
						getAriaLabel: (e: IChatDebugLogEvent) => `${e.name}: ${e.contents ?? ''}`,
						getWidgetAriaLabel: () => localize('chatDebug.ariaLabel', "Chat Debug Log Events"),
					},
				}
			));

			// Subscribe to events for the active session
			this.currentSessionId = this.chatDebugService.activeSessionId ?? '';
			console.log('[ChatDebugEditor] activeSessionId:', this.currentSessionId);
			this.loadEventsForSession(this.currentSessionId);

			console.log('[ChatDebugEditor] events loaded:', this.events.length);
			this.refreshList();
			console.log('[ChatDebugEditor] createEditor complete, list length:', this.list?.length);
		} catch (e) {
			console.error('[ChatDebugEditor] createEditor FAILED:', e);
		}
	}

	private populateSessionSelect(): void {
		console.log('[ChatDebugEditor] populateSessionSelect called');
		if (!this.sessionSelect) {
			return;
		}
		while (this.sessionSelect.firstChild) {
			this.sessionSelect.removeChild(this.sessionSelect.firstChild);
		}

		const activeSessionId = this.chatDebugService.activeSessionId ?? '';
		console.log('[ChatDebugEditor] activeSessionId for dropdown:', activeSessionId);

		let models: import('../common/model/chatModel.js').IChatModel[] = [];
		try {
			this.instantiationService.invokeFunction((accessor) => {
				const chatService = accessor.get(IChatService);
				models = [...chatService.chatModels.get()];
			});
			console.log('[ChatDebugEditor] chatModels count:', models.length);
		} catch (e) {
			console.error('[ChatDebugEditor] Error getting chatModels:', e);
		}

		if (models.length === 0) {
			const option = document.createElement('option');
			option.value = activeSessionId;
			option.textContent = activeSessionId || localize('chatDebug.noSessions', "No sessions");
			option.selected = true;
			this.sessionSelect.appendChild(option);
			return;
		}

		for (const model of models) {
			const option = document.createElement('option');
			const sessionId = chatSessionResourceToId(model.sessionResource);
			option.value = sessionId;
			option.textContent = model.title || sessionId;
			if (sessionId === activeSessionId) {
				option.selected = true;
			}
			this.sessionSelect.appendChild(option);
		}
	}

	private switchSession(sessionId: string): void {
		this.currentSessionId = sessionId;
		this.chatDebugService.activeSessionId = sessionId;
		this.loadEventsForSession(sessionId);
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
				(e.contents?.toLowerCase().includes(this.filterText))
			);
		}

		this.list.splice(0, this.list.length, filtered);
	}

	override focus(): void {
		this.list?.domFocus();
	}

	override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible) {
			console.log('[ChatDebugEditor] setEditorVisible(true), refreshing session data');
			// Refresh session and events each time the editor becomes visible
			this.currentSessionId = this.chatDebugService.activeSessionId ?? '';
			this.populateSessionSelect();
			this.loadEventsForSession(this.currentSessionId);
			this.refreshList();
		}
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
		if (this.list) {
			const headerHeight = (this.headerContainer?.offsetHeight ?? 40) + 28; // header + table header
			this.list.layout(dimension.height - headerHeight, dimension.width);
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
.chat-debug-table-header .chat-debug-col-name {
	width: 200px;
	flex-shrink: 0;
}
.chat-debug-table-header .chat-debug-col-contents {
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
.chat-debug-log-row .chat-debug-log-name {
	width: 200px;
	flex-shrink: 0;
	font-weight: 500;
}
.chat-debug-log-row .chat-debug-log-contents {
	flex: 1;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
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
`;
