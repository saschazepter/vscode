/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { addDisposableListener, Dimension, EventType } from '../../../../../base/browser/dom.js';
import { BreadcrumbsWidget } from '../../../../../base/browser/ui/breadcrumbs/breadcrumbsWidget.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IObjectTreeElement } from '../../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { WorkbenchList, WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { defaultBreadcrumbsWidgetStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IUntitledTextResourceEditorInput } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { FilterWidget, viewFilterSubmenu } from '../../../../browser/parts/views/viewFilter.js';
import { MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ChatDebugLogLevel, IChatDebugEvent, IChatDebugService } from '../../common/chatDebugService.js';
import { IChatService } from '../../common/chatService/chatService.js';
import { LocalChatSessionUri } from '../../common/model/chatUri.js';
import { ChatDebugEventRenderer, ChatDebugEventDelegate, ChatDebugEventTreeRenderer } from './chatDebugEventList.js';
import {
	TextBreadcrumbItem, LogsViewMode,
	CHAT_DEBUG_FILTER_ACTIVE,
	CHAT_DEBUG_KIND_TOOL_CALL, CHAT_DEBUG_KIND_MODEL_TURN, CHAT_DEBUG_KIND_GENERIC, CHAT_DEBUG_KIND_SUBAGENT,
	CHAT_DEBUG_KIND_USER_MESSAGE, CHAT_DEBUG_KIND_AGENT_RESPONSE,
	CHAT_DEBUG_LEVEL_TRACE, CHAT_DEBUG_LEVEL_INFO, CHAT_DEBUG_LEVEL_WARNING, CHAT_DEBUG_LEVEL_ERROR,
	CHAT_DEBUG_CMD_TOGGLE_TOOL_CALL, CHAT_DEBUG_CMD_TOGGLE_MODEL_TURN, CHAT_DEBUG_CMD_TOGGLE_GENERIC,
	CHAT_DEBUG_CMD_TOGGLE_SUBAGENT, CHAT_DEBUG_CMD_TOGGLE_USER_MESSAGE, CHAT_DEBUG_CMD_TOGGLE_AGENT_RESPONSE,
	CHAT_DEBUG_CMD_TOGGLE_TRACE, CHAT_DEBUG_CMD_TOGGLE_INFO, CHAT_DEBUG_CMD_TOGGLE_WARNING, CHAT_DEBUG_CMD_TOGGLE_ERROR,
} from './chatDebugTypes.js';
import { formatEventDetail } from './chatDebugEventDetailRenderer.js';
import { renderFileListContent, fileListToPlainText } from './chatDebugFileListRenderer.js';
import { renderUserMessageContent, renderAgentResponseContent, messageEventToPlainText, renderResolvedMessageContent, resolvedMessageToPlainText } from './chatDebugMessageContentRenderer.js';

const $ = DOM.$;

export const enum LogsNavigation {
	Home = 'home',
	Overview = 'overview',
}

export class ChatDebugLogsView extends Disposable {

	private readonly _onNavigate = this._register(new Emitter<LogsNavigation>());
	readonly onNavigate = this._onNavigate.event;

	readonly container: HTMLElement;
	private readonly breadcrumbWidget: BreadcrumbsWidget;
	private readonly headerContainer: HTMLElement;
	private readonly tableHeader: HTMLElement;
	private readonly bodyContainer: HTMLElement;
	private readonly listContainer: HTMLElement;
	private readonly treeContainer: HTMLElement;
	private readonly detailContainer: HTMLElement;
	private readonly filterWidget: FilterWidget;
	private readonly viewModeToggle: HTMLButtonElement;

	private list: WorkbenchList<IChatDebugEvent>;
	private tree: WorkbenchObjectTree<IChatDebugEvent, void>;

	private currentSessionId: string = '';
	private logsViewMode: LogsViewMode = LogsViewMode.List;
	private events: IChatDebugEvent[] = [];
	private filterText: string = '';
	private filterKindToolCall: boolean = true;
	private filterKindModelTurn: boolean = true;
	private filterKindGeneric: boolean = true;
	private filterKindSubagent: boolean = true;
	private filterKindUserMessage: boolean = true;
	private filterKindAgentResponse: boolean = true;
	private filterLevelTrace: boolean = true;
	private filterLevelInfo: boolean = true;
	private filterLevelWarning: boolean = true;
	private filterLevelError: boolean = true;
	private kindToolCallKey: IContextKey<boolean>;
	private kindModelTurnKey: IContextKey<boolean>;
	private kindGenericKey: IContextKey<boolean>;
	private kindSubagentKey: IContextKey<boolean>;
	private kindUserMessageKey: IContextKey<boolean>;
	private kindAgentResponseKey: IContextKey<boolean>;
	private levelTraceKey: IContextKey<boolean>;
	private levelInfoKey: IContextKey<boolean>;
	private levelWarningKey: IContextKey<boolean>;
	private levelErrorKey: IContextKey<boolean>;
	private currentDimension: Dimension | undefined;
	private readonly eventListener = this._register(new MutableDisposable());
	private readonly detailDisposables = this._register(new DisposableStore());
	private currentDetailText: string = '';
	private currentDetailEventId: string | undefined;

	constructor(
		parent: HTMLElement,
		@IChatService private readonly chatService: IChatService,
		@IChatDebugService private readonly chatDebugService: IChatDebugService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IHoverService private readonly hoverService: IHoverService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this.container = DOM.append(parent, $('.chat-debug-logs'));
		DOM.hide(this.container);

		// Breadcrumb
		const breadcrumbContainer = DOM.append(this.container, $('.chat-debug-breadcrumb'));
		this.breadcrumbWidget = this._register(new BreadcrumbsWidget(breadcrumbContainer, 3, undefined, Codicon.chevronRight, defaultBreadcrumbsWidgetStyles));
		this._register(this.breadcrumbWidget.onDidSelectItem(e => {
			if (e.type === 'select' && e.item instanceof TextBreadcrumbItem) {
				this.breadcrumbWidget.setSelection(undefined);
				const items = this.breadcrumbWidget.getItems();
				const idx = items.indexOf(e.item);
				if (idx === 0) {
					this._onNavigate.fire(LogsNavigation.Home);
				} else if (idx === 1) {
					this._onNavigate.fire(LogsNavigation.Overview);
				}
			}
		}));

		// Header (filter)
		this.headerContainer = DOM.append(this.container, $('.chat-debug-editor-header'));

		// Scoped context key service for filter menu items
		const scopedContextKeyService = this._register(this.contextKeyService.createScoped(this.headerContainer));
		CHAT_DEBUG_FILTER_ACTIVE.bindTo(scopedContextKeyService).set(true);
		this.kindToolCallKey = CHAT_DEBUG_KIND_TOOL_CALL.bindTo(scopedContextKeyService);
		this.kindToolCallKey.set(true);
		this.kindModelTurnKey = CHAT_DEBUG_KIND_MODEL_TURN.bindTo(scopedContextKeyService);
		this.kindModelTurnKey.set(true);
		this.kindGenericKey = CHAT_DEBUG_KIND_GENERIC.bindTo(scopedContextKeyService);
		this.kindGenericKey.set(true);
		this.kindSubagentKey = CHAT_DEBUG_KIND_SUBAGENT.bindTo(scopedContextKeyService);
		this.kindSubagentKey.set(true);
		this.kindUserMessageKey = CHAT_DEBUG_KIND_USER_MESSAGE.bindTo(scopedContextKeyService);
		this.kindUserMessageKey.set(true);
		this.kindAgentResponseKey = CHAT_DEBUG_KIND_AGENT_RESPONSE.bindTo(scopedContextKeyService);
		this.kindAgentResponseKey.set(true);
		this.levelTraceKey = CHAT_DEBUG_LEVEL_TRACE.bindTo(scopedContextKeyService);
		this.levelTraceKey.set(true);
		this.levelInfoKey = CHAT_DEBUG_LEVEL_INFO.bindTo(scopedContextKeyService);
		this.levelInfoKey.set(true);
		this.levelWarningKey = CHAT_DEBUG_LEVEL_WARNING.bindTo(scopedContextKeyService);
		this.levelWarningKey.set(true);
		this.levelErrorKey = CHAT_DEBUG_LEVEL_ERROR.bindTo(scopedContextKeyService);
		this.levelErrorKey.set(true);

		const childInstantiationService = this._register(this.instantiationService.createChild(
			new ServiceCollection([IContextKeyService, scopedContextKeyService])
		));
		this.filterWidget = this._register(childInstantiationService.createInstance(FilterWidget, {
			placeholder: localize('chatDebug.search', "Filter (e.g. text, !exclude)"),
			ariaLabel: localize('chatDebug.filterAriaLabel', "Filter debug events"),
		}));

		// View mode toggle
		this.viewModeToggle = DOM.append(this.headerContainer, $('button.chat-debug-view-mode-toggle')) as HTMLButtonElement;
		this.updateViewModeToggle();
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.viewModeToggle, localize('chatDebug.toggleViewMode', "Toggle between list and tree view")));
		this._register(addDisposableListener(this.viewModeToggle, EventType.CLICK, () => {
			this.toggleViewMode();
		}));

		const filterContainer = DOM.append(this.headerContainer, $('.viewpane-filter-container'));
		filterContainer.appendChild(this.filterWidget.element);

		this._register(this.filterWidget.onDidChangeFilterText(text => {
			this.filterText = text.toLowerCase();
			this.refreshList();
		}));

		this.registerFilterMenuItems();

		// Content wrapper (flex row: main column + detail panel)
		const contentContainer = DOM.append(this.container, $('.chat-debug-logs-content'));

		// Main column (table header + list/tree body)
		const mainColumn = DOM.append(contentContainer, $('.chat-debug-logs-main'));

		// Table header
		this.tableHeader = DOM.append(mainColumn, $('.chat-debug-table-header'));
		DOM.append(this.tableHeader, $('span.chat-debug-col-created', undefined, localize('chatDebug.col.created', "Created")));
		DOM.append(this.tableHeader, $('span.chat-debug-col-name', undefined, localize('chatDebug.col.name', "Name")));
		DOM.append(this.tableHeader, $('span.chat-debug-col-details', undefined, localize('chatDebug.col.details', "Details")));

		// Body container
		this.bodyContainer = DOM.append(mainColumn, $('.chat-debug-logs-body'));

		// List container
		this.listContainer = DOM.append(this.bodyContainer, $('.chat-debug-list-container'));

		const accessibilityProvider = {
			getAriaLabel: (e: IChatDebugEvent) => {
				switch (e.kind) {
					case 'toolCall': return localize('chatDebug.aria.toolCall', "Tool call: {0}{1}", e.toolName, e.result ? ` (${e.result})` : '');
					case 'modelTurn': return localize('chatDebug.aria.modelTurn', "Model turn: {0}{1}", e.model ?? localize('chatDebug.aria.model', "model"), e.totalTokens ? localize('chatDebug.aria.tokenCount', " {0} tokens", e.totalTokens) : '');
					case 'generic': return `${e.category ? e.category + ': ' : ''}${e.name}: ${e.details ?? ''}`;
					case 'subagentInvocation': return localize('chatDebug.aria.subagent', "Subagent: {0}{1}", e.agentName, e.description ? ` - ${e.description}` : '');
					case 'userMessage': return localize('chatDebug.aria.userMessage', "User message: {0}", e.message);
					case 'agentResponse': return localize('chatDebug.aria.agentResponse', "Agent response: {0}", e.message);
				}
			},
			getWidgetAriaLabel: () => localize('chatDebug.ariaLabel', "Chat Debug Events"),
		};
		let nextFallbackId = 0;
		const fallbackIds = new WeakMap<IChatDebugEvent, string>();
		const identityProvider = {
			getId: (e: IChatDebugEvent) => {
				if (e.id) {
					return e.id;
				}
				let fallback = fallbackIds.get(e);
				if (!fallback) {
					fallback = `_fallback_${nextFallbackId++}`;
					fallbackIds.set(e, fallback);
				}
				return fallback;
			}
		};

		this.list = this._register(this.instantiationService.createInstance(
			WorkbenchList<IChatDebugEvent>,
			'ChatDebugEvents',
			this.listContainer,
			new ChatDebugEventDelegate(),
			[new ChatDebugEventRenderer()],
			{ identityProvider, accessibilityProvider }
		));

		// Tree container (initially hidden)
		this.treeContainer = DOM.append(this.bodyContainer, $('.chat-debug-list-container'));
		DOM.hide(this.treeContainer);

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<IChatDebugEvent, void>,
			'ChatDebugEventsTree',
			this.treeContainer,
			new ChatDebugEventDelegate(),
			[new ChatDebugEventTreeRenderer()],
			{ identityProvider, accessibilityProvider }
		));

		// Detail panel (sibling of main column so it aligns with table header)
		this.detailContainer = DOM.append(contentContainer, $('.chat-debug-detail-panel'));
		DOM.hide(this.detailContainer);

		// Handle Ctrl+A / Cmd+A to select all within the focused content element
		this._register(addDisposableListener(this.detailContainer, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
				const target = e.target as HTMLElement;
				if (target && this.detailContainer.contains(target)) {
					e.preventDefault();
					const targetWindow = DOM.getWindow(target);
					const selection = targetWindow.getSelection();
					if (selection) {
						const range = targetWindow.document.createRange();
						range.selectNodeContents(target);
						selection.removeAllRanges();
						selection.addRange(range);
					}
				}
			}
		}));

		// Resolve event details on selection
		this._register(this.list.onDidChangeSelection(e => {
			const selected = e.elements[0];
			if (selected) {
				this.resolveAndShowDetail(selected);
			} else {
				this.hideDetail();
			}
		}));

		this._register(this.tree.onDidChangeSelection(e => {
			const selected = e.elements[0];
			if (selected) {
				this.resolveAndShowDetail(selected);
			} else {
				this.hideDetail();
			}
		}));
	}

	setSession(sessionId: string): void {
		this.currentSessionId = sessionId;
	}

	show(): void {
		DOM.show(this.container);
		this.loadEvents();
		this.refreshList();
	}

	hide(): void {
		DOM.hide(this.container);
	}

	focus(): void {
		if (this.logsViewMode === LogsViewMode.Tree) {
			this.tree.domFocus();
		} else {
			this.list.domFocus();
		}
	}

	updateBreadcrumb(): void {
		const sessionUri = LocalChatSessionUri.forSession(this.currentSessionId);
		const sessionTitle = this.chatService.getSessionTitle(sessionUri) || this.currentSessionId;
		this.breadcrumbWidget.setItems([
			new TextBreadcrumbItem(localize('chatDebug.title', "Chat Debug Panel"), true),
			new TextBreadcrumbItem(sessionTitle, true),
			new TextBreadcrumbItem(localize('chatDebug.logs', "Logs")),
		]);
	}

	layout(dimension: Dimension): void {
		this.currentDimension = dimension;
		const breadcrumbHeight = 22;
		const headerHeight = this.headerContainer.offsetHeight;
		const tableHeaderHeight = this.tableHeader.offsetHeight;
		const detailVisible = this.detailContainer.style.display !== 'none';
		const detailWidth = detailVisible ? this.detailContainer.offsetWidth : 0;
		const listHeight = dimension.height - breadcrumbHeight - headerHeight - tableHeaderHeight;
		const listWidth = dimension.width - detailWidth;
		if (this.logsViewMode === LogsViewMode.Tree) {
			this.tree.layout(listHeight, listWidth);
		} else {
			this.list.layout(listHeight, listWidth);
		}
	}

	refreshList(): void {
		let filtered = this.events;

		// Filter by kind toggles
		filtered = filtered.filter(e => {
			switch (e.kind) {
				case 'toolCall': return this.filterKindToolCall;
				case 'modelTurn': return this.filterKindModelTurn;
				case 'generic': return this.filterKindGeneric;
				case 'subagentInvocation': return this.filterKindSubagent;
				case 'userMessage': return this.filterKindUserMessage;
				case 'agentResponse': return this.filterKindAgentResponse;
			}
		});

		// Filter by level toggles
		filtered = filtered.filter(e => {
			if (e.kind === 'generic') {
				switch (e.level) {
					case ChatDebugLogLevel.Trace: return this.filterLevelTrace;
					case ChatDebugLogLevel.Info: return this.filterLevelInfo;
					case ChatDebugLogLevel.Warning: return this.filterLevelWarning;
					case ChatDebugLogLevel.Error: return this.filterLevelError;
				}
			}
			if (e.kind === 'toolCall' && e.result === 'error') {
				return this.filterLevelError;
			}
			return true;
		});

		// Filter by text search
		if (this.filterText) {
			const terms = this.filterText.split(/\s*,\s*/).filter(t => t.length > 0);
			const includeTerms = terms.filter(t => !t.startsWith('!')).map(t => t.trim());
			const excludeTerms = terms.filter(t => t.startsWith('!')).map(t => t.slice(1).trim()).filter(t => t.length > 0);

			filtered = filtered.filter(e => {
				const matchesText = (term: string): boolean => {
					if (e.kind.toLowerCase().includes(term)) {
						return true;
					}
					switch (e.kind) {
						case 'toolCall':
							return e.toolName.toLowerCase().includes(term) ||
								(e.input?.toLowerCase().includes(term) ?? false) ||
								(e.output?.toLowerCase().includes(term) ?? false);
						case 'modelTurn':
							return (e.model?.toLowerCase().includes(term) ?? false);
						case 'generic':
							return e.name.toLowerCase().includes(term) ||
								(e.details?.toLowerCase().includes(term) ?? false) ||
								(e.category?.toLowerCase().includes(term) ?? false);
						case 'subagentInvocation':
							return e.agentName.toLowerCase().includes(term) ||
								(e.description?.toLowerCase().includes(term) ?? false);
						case 'userMessage':
							return e.message.toLowerCase().includes(term) ||
								e.sections.some(s => s.name.toLowerCase().includes(term) || s.content.toLowerCase().includes(term));
						case 'agentResponse':
							return e.message.toLowerCase().includes(term) ||
								e.sections.some(s => s.name.toLowerCase().includes(term) || s.content.toLowerCase().includes(term));
					}
				};

				// Exclude terms: if any exclude term matches, filter out the event
				if (excludeTerms.some(term => matchesText(term))) {
					return false;
				}
				// Include terms: if present, at least one must match
				if (includeTerms.length > 0) {
					return includeTerms.some(term => matchesText(term));
				}
				return true;
			});
		}

		if (this.logsViewMode === LogsViewMode.List) {
			this.list.splice(0, this.list.length, filtered);
		} else {
			this.refreshTree(filtered);
		}
	}

	addEvent(event: IChatDebugEvent): void {
		this.events.push(event);
		this.refreshList();
	}

	private loadEvents(): void {
		this.events = [...this.chatDebugService.getEvents(this.currentSessionId || undefined)];
		this.eventListener.value = this.chatDebugService.onDidAddEvent(e => {
			if (!this.currentSessionId || e.sessionId === this.currentSessionId) {
				this.events.push(e);
				this.refreshList();
			}
		});
		this.updateBreadcrumb();
	}

	private refreshTree(filtered: IChatDebugEvent[]): void {
		const treeElements = this.buildTreeHierarchy(filtered);
		this.tree.setChildren(null, treeElements);
	}

	private buildTreeHierarchy(events: IChatDebugEvent[]): IObjectTreeElement<IChatDebugEvent>[] {
		const idToEvent = new Map<string, IChatDebugEvent>();
		const idToChildren = new Map<string, IChatDebugEvent[]>();
		const roots: IChatDebugEvent[] = [];

		for (const event of events) {
			if (event.id) {
				idToEvent.set(event.id, event);
			}
		}

		for (const event of events) {
			if (event.parentEventId && idToEvent.has(event.parentEventId)) {
				let children = idToChildren.get(event.parentEventId);
				if (!children) {
					children = [];
					idToChildren.set(event.parentEventId, children);
				}
				children.push(event);
			} else {
				roots.push(event);
			}
		}

		const toTreeElement = (event: IChatDebugEvent): IObjectTreeElement<IChatDebugEvent> => {
			const children = event.id ? idToChildren.get(event.id) : undefined;
			return {
				element: event,
				children: children?.map(toTreeElement),
				collapsible: (children?.length ?? 0) > 0,
				collapsed: false,
			};
		};

		return roots.map(toTreeElement);
	}

	private toggleViewMode(): void {
		if (this.logsViewMode === LogsViewMode.List) {
			this.logsViewMode = LogsViewMode.Tree;
			DOM.hide(this.listContainer);
			DOM.show(this.treeContainer);
		} else {
			this.logsViewMode = LogsViewMode.List;
			DOM.show(this.listContainer);
			DOM.hide(this.treeContainer);
		}
		this.updateViewModeToggle();
		this.refreshList();
		if (this.currentDimension) {
			this.layout(this.currentDimension);
		}
	}

	private updateViewModeToggle(): void {
		DOM.clearNode(this.viewModeToggle);
		const isTree = this.logsViewMode === LogsViewMode.Tree;
		DOM.append(this.viewModeToggle, $(`span${ThemeIcon.asCSSSelector(isTree ? Codicon.listTree : Codicon.listFlat)}`));

		const labelContainer = DOM.append(this.viewModeToggle, $('span.chat-debug-view-mode-labels'));
		const treeLabel = DOM.append(labelContainer, $('span.chat-debug-view-mode-label'));
		treeLabel.textContent = localize('chatDebug.treeView', "Tree View");
		const listLabel = DOM.append(labelContainer, $('span.chat-debug-view-mode-label'));
		listLabel.textContent = localize('chatDebug.listView', "List View");

		if (isTree) {
			listLabel.classList.add('hidden');
		} else {
			treeLabel.classList.add('hidden');
		}
	}

	private registerFilterMenuItems(): void {
		const registerKindToggle = (id: string, title: string, key: RawContextKey<boolean>, flagGetter: () => boolean, flagSetter: (v: boolean) => void, ctxKey: IContextKey<boolean>) => {
			this._register(CommandsRegistry.registerCommand(id, () => {
				const newVal = !flagGetter();
				flagSetter(newVal);
				ctxKey.set(newVal);
				this.refreshList();
				this.updateMoreFiltersChecked();
			}));
			this._register(MenuRegistry.appendMenuItem(viewFilterSubmenu, {
				command: { id, title, toggled: key },
				group: '1_kind',
				when: CHAT_DEBUG_FILTER_ACTIVE,
			}));
		};

		registerKindToggle(CHAT_DEBUG_CMD_TOGGLE_TOOL_CALL, localize('chatDebug.filter.toolCall', "Tool Calls"), CHAT_DEBUG_KIND_TOOL_CALL, () => this.filterKindToolCall, v => { this.filterKindToolCall = v; }, this.kindToolCallKey);
		registerKindToggle(CHAT_DEBUG_CMD_TOGGLE_MODEL_TURN, localize('chatDebug.filter.modelTurn', "Model Turns"), CHAT_DEBUG_KIND_MODEL_TURN, () => this.filterKindModelTurn, v => { this.filterKindModelTurn = v; }, this.kindModelTurnKey);
		registerKindToggle(CHAT_DEBUG_CMD_TOGGLE_GENERIC, localize('chatDebug.filter.generic', "Generic"), CHAT_DEBUG_KIND_GENERIC, () => this.filterKindGeneric, v => { this.filterKindGeneric = v; }, this.kindGenericKey);
		registerKindToggle(CHAT_DEBUG_CMD_TOGGLE_SUBAGENT, localize('chatDebug.filter.subagent', "Subagent Invocations"), CHAT_DEBUG_KIND_SUBAGENT, () => this.filterKindSubagent, v => { this.filterKindSubagent = v; }, this.kindSubagentKey);
		registerKindToggle(CHAT_DEBUG_CMD_TOGGLE_USER_MESSAGE, localize('chatDebug.filter.userMessage', "User Messages"), CHAT_DEBUG_KIND_USER_MESSAGE, () => this.filterKindUserMessage, v => { this.filterKindUserMessage = v; }, this.kindUserMessageKey);
		registerKindToggle(CHAT_DEBUG_CMD_TOGGLE_AGENT_RESPONSE, localize('chatDebug.filter.agentResponse', "Agent Responses"), CHAT_DEBUG_KIND_AGENT_RESPONSE, () => this.filterKindAgentResponse, v => { this.filterKindAgentResponse = v; }, this.kindAgentResponseKey);

		const registerLevelToggle = (id: string, title: string, key: RawContextKey<boolean>, flagGetter: () => boolean, flagSetter: (v: boolean) => void, ctxKey: IContextKey<boolean>) => {
			this._register(CommandsRegistry.registerCommand(id, () => {
				const newVal = !flagGetter();
				flagSetter(newVal);
				ctxKey.set(newVal);
				this.refreshList();
				this.updateMoreFiltersChecked();
			}));
			this._register(MenuRegistry.appendMenuItem(viewFilterSubmenu, {
				command: { id, title, toggled: key },
				group: '2_level',
				when: CHAT_DEBUG_FILTER_ACTIVE,
			}));
		};

		registerLevelToggle(CHAT_DEBUG_CMD_TOGGLE_TRACE, localize('chatDebug.filter.trace', "Trace"), CHAT_DEBUG_LEVEL_TRACE, () => this.filterLevelTrace, v => { this.filterLevelTrace = v; }, this.levelTraceKey);
		registerLevelToggle(CHAT_DEBUG_CMD_TOGGLE_INFO, localize('chatDebug.filter.info', "Info"), CHAT_DEBUG_LEVEL_INFO, () => this.filterLevelInfo, v => { this.filterLevelInfo = v; }, this.levelInfoKey);
		registerLevelToggle(CHAT_DEBUG_CMD_TOGGLE_WARNING, localize('chatDebug.filter.warning', "Warning"), CHAT_DEBUG_LEVEL_WARNING, () => this.filterLevelWarning, v => { this.filterLevelWarning = v; }, this.levelWarningKey);
		registerLevelToggle(CHAT_DEBUG_CMD_TOGGLE_ERROR, localize('chatDebug.filter.error', "Error"), CHAT_DEBUG_LEVEL_ERROR, () => this.filterLevelError, v => { this.filterLevelError = v; }, this.levelErrorKey);
	}

	private updateMoreFiltersChecked(): void {
		const allOn = this.filterKindToolCall && this.filterKindModelTurn &&
			this.filterKindGeneric && this.filterKindSubagent &&
			this.filterKindUserMessage && this.filterKindAgentResponse &&
			this.filterLevelTrace && this.filterLevelInfo &&
			this.filterLevelWarning && this.filterLevelError;
		this.filterWidget.checkMoreFilters(!allOn);
	}

	private async resolveAndShowDetail(event: IChatDebugEvent): Promise<void> {
		// Skip re-rendering if we're already showing this event's detail
		if (event.id && event.id === this.currentDetailEventId) {
			return;
		}
		this.currentDetailEventId = event.id;

		const resolved = event.id ? await this.chatDebugService.resolveEvent(event.id) : undefined;

		DOM.show(this.detailContainer);
		DOM.clearNode(this.detailContainer);
		this.detailDisposables.clear();

		// Header with action buttons
		const header = DOM.append(this.detailContainer, $('.chat-debug-detail-header'));

		const fullScreenButton = DOM.append(header, $('button.chat-debug-detail-button'));
		fullScreenButton.setAttribute('aria-label', localize('chatDebug.openInEditor', "Open in Editor"));
		this.detailDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), fullScreenButton, localize('chatDebug.openInEditor', "Open in Editor")));
		DOM.append(fullScreenButton, $(`span${ThemeIcon.asCSSSelector(Codicon.goToFile)}`));
		this.detailDisposables.add(addDisposableListener(fullScreenButton, EventType.CLICK, () => {
			this.editorService.openEditor({ contents: this.currentDetailText, resource: undefined } satisfies IUntitledTextResourceEditorInput);
		}));

		const copyButton = DOM.append(header, $('button.chat-debug-detail-button'));
		copyButton.setAttribute('aria-label', localize('chatDebug.copyToClipboard', "Copy"));
		this.detailDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), copyButton, localize('chatDebug.copyToClipboard', "Copy")));
		DOM.append(copyButton, $(`span${ThemeIcon.asCSSSelector(Codicon.copy)}`));
		this.detailDisposables.add(addDisposableListener(copyButton, EventType.CLICK, () => {
			this.clipboardService.writeText(this.currentDetailText);
		}));

		const closeButton = DOM.append(header, $('button.chat-debug-detail-button'));
		closeButton.setAttribute('aria-label', localize('chatDebug.closeDetail', "Close"));
		this.detailDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), closeButton, localize('chatDebug.closeDetail', "Close")));
		DOM.append(closeButton, $(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		this.detailDisposables.add(addDisposableListener(closeButton, EventType.CLICK, () => {
			this.list.setSelection([]);
			this.hideDetail();
		}));

		if (resolved && resolved.kind === 'fileList') {
			this.currentDetailText = fileListToPlainText(resolved);
			const { element: contentEl, disposables: contentDisposables } = this.instantiationService.invokeFunction(accessor =>
				renderFileListContent(resolved, this.openerService, accessor.get(IModelService), accessor.get(ILanguageService), this.hoverService, accessor.get(ILabelService))
			);
			this.detailDisposables.add(contentDisposables);
			this.detailContainer.appendChild(contentEl);
		} else if (resolved && resolved.kind === 'message') {
			this.currentDetailText = resolvedMessageToPlainText(resolved);
			const { element: contentEl, disposables: contentDisposables } = renderResolvedMessageContent(resolved);
			this.detailDisposables.add(contentDisposables);
			this.detailContainer.appendChild(contentEl);
		} else if (event.kind === 'userMessage') {
			this.currentDetailText = messageEventToPlainText(event);
			const { element: contentEl, disposables: contentDisposables } = renderUserMessageContent(event);
			this.detailDisposables.add(contentDisposables);
			this.detailContainer.appendChild(contentEl);
		} else if (event.kind === 'agentResponse') {
			this.currentDetailText = messageEventToPlainText(event);
			const { element: contentEl, disposables: contentDisposables } = renderAgentResponseContent(event);
			this.detailDisposables.add(contentDisposables);
			this.detailContainer.appendChild(contentEl);
		} else {
			const pre = DOM.append(this.detailContainer, $('pre'));
			pre.tabIndex = 0;
			if (resolved) {
				this.currentDetailText = resolved.value;
			} else {
				this.currentDetailText = formatEventDetail(event);
			}
			pre.textContent = this.currentDetailText;
		}
	}

	private hideDetail(): void {
		this.currentDetailEventId = undefined;
		DOM.hide(this.detailContainer);
		DOM.clearNode(this.detailContainer);
		this.detailDisposables.clear();
	}
}
