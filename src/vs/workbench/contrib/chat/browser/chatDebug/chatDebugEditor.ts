/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, Dimension, EventType } from '../../../../../base/browser/dom.js';
import { createStyleSheet } from '../../../../../base/browser/domStylesheets.js';
import { WorkbenchList, WorkbenchObjectTree } from '../../../../../platform/list/browser/listService.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { ChatDebugLogLevel, IChatDebugEvent, IChatDebugService } from '../../common/chatDebugService.js';
import { IChatService } from '../../common/chatService/chatService.js';
import { ChatAgentLocation } from '../../common/constants.js';
import { IChatSessionsService } from '../../common/chatSessionsService.js';
import { chatSessionResourceToId, getChatSessionType, LocalChatSessionUri } from '../../common/model/chatUri.js';
import { URI } from '../../../../../base/common/uri.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IChatWidgetService } from '../chat.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IUntitledTextResourceEditorInput } from '../../../../common/editor.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { isUUID } from '../../../../../base/common/uuid.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { ChatDebugEventRenderer, ChatDebugEventDelegate, ChatDebugEventTreeRenderer } from './chatDebugEventList.js';
import { IObjectTreeElement } from '../../../../../base/browser/ui/tree/tree.js';
import { chatDebugStyles } from './chatDebugStyles.js';
import { generateSubagentFlowchart, renderVisualFlow } from './chatDebugSubagentChart.js';
import { FilterWidget, viewFilterSubmenu } from '../../../../browser/parts/views/viewFilter.js';
import { IContextKeyService, IContextKey, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { BreadcrumbsItem, BreadcrumbsWidget } from '../../../../../base/browser/ui/breadcrumbs/breadcrumbsWidget.js';
import { defaultBreadcrumbsWidgetStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';

const enum ViewState {
	Home = 'home',
	Overview = 'overview',
	Logs = 'logs',
	SubagentChart = 'subagentChart',
}

const enum LogsViewMode {
	List = 'list',
	Tree = 'tree',
}

const CHAT_DEBUG_FILTER_ACTIVE = new RawContextKey<boolean>('chatDebugFilterActive', false);
const CHAT_DEBUG_KIND_TOOL_CALL = new RawContextKey<boolean>('chatDebug.kindToolCall', true);
const CHAT_DEBUG_KIND_MODEL_TURN = new RawContextKey<boolean>('chatDebug.kindModelTurn', true);
const CHAT_DEBUG_KIND_GENERIC = new RawContextKey<boolean>('chatDebug.kindGeneric', true);
const CHAT_DEBUG_KIND_SUBAGENT = new RawContextKey<boolean>('chatDebug.kindSubagent', true);
const CHAT_DEBUG_LEVEL_TRACE = new RawContextKey<boolean>('chatDebug.levelTrace', true);
const CHAT_DEBUG_LEVEL_INFO = new RawContextKey<boolean>('chatDebug.levelInfo', true);
const CHAT_DEBUG_LEVEL_WARNING = new RawContextKey<boolean>('chatDebug.levelWarning', true);
const CHAT_DEBUG_LEVEL_ERROR = new RawContextKey<boolean>('chatDebug.levelError', true);

class TextBreadcrumbItem extends BreadcrumbsItem {
	constructor(
		private readonly _text: string,
		private readonly _isLink: boolean = false,
	) {
		super();
	}

	dispose(): void { }

	equals(other: BreadcrumbsItem): boolean {
		return other instanceof TextBreadcrumbItem && other._text === this._text;
	}

	render(container: HTMLElement): void {
		container.classList.add('chat-debug-breadcrumb-item');
		if (this._isLink) {
			container.classList.add('chat-debug-breadcrumb-item-link');
		}
		const label = document.createElement('span');
		label.className = 'chat-debug-breadcrumb-item-label';
		label.textContent = this._text;
		container.appendChild(label);
	}
}

export class ChatDebugEditor extends EditorPane {

	static readonly ID: string = 'workbench.editor.chatDebug';

	private container: HTMLElement | undefined;
	private currentDimension: Dimension | undefined;

	// --- View state ---
	private viewState: ViewState = ViewState.Home;
	private currentSessionId: string = '';

	// --- Home view ---
	private homeContainer: HTMLElement | undefined;

	// --- Overview view ---
	private overviewContainer: HTMLElement | undefined;
	private overviewContent: HTMLElement | undefined;
	private overviewBreadcrumbWidget: BreadcrumbsWidget | undefined;

	// --- Logs view ---
	private logsContainer: HTMLElement | undefined;
	private list: WorkbenchList<IChatDebugEvent> | undefined;
	private tree: WorkbenchObjectTree<IChatDebugEvent, void> | undefined;
	private logsViewMode: LogsViewMode = LogsViewMode.List;
	private viewModeToggle: HTMLButtonElement | undefined;
	private headerContainer: HTMLElement | undefined;
	private detailContainer: HTMLElement | undefined;
	private filterWidget: FilterWidget | undefined;
	private tableHeader: HTMLElement | undefined;
	private bodyContainer: HTMLElement | undefined;
	private listContainer: HTMLElement | undefined;
	private treeContainer: HTMLElement | undefined;
	private logsBreadcrumbWidget: BreadcrumbsWidget | undefined;
	private events: IChatDebugEvent[] = [];
	private filterText: string = '';
	private filterKindToolCall: boolean = true;
	private filterKindModelTurn: boolean = true;
	private filterKindGeneric: boolean = true;
	private filterKindSubagent: boolean = true;
	private filterLevelTrace: boolean = true;
	private filterLevelInfo: boolean = true;
	private filterLevelWarning: boolean = true;
	private filterLevelError: boolean = true;
	private kindToolCallKey: IContextKey<boolean> | undefined;
	private kindModelTurnKey: IContextKey<boolean> | undefined;
	private kindGenericKey: IContextKey<boolean> | undefined;
	private kindSubagentKey: IContextKey<boolean> | undefined;
	private levelTraceKey: IContextKey<boolean> | undefined;
	private levelInfoKey: IContextKey<boolean> | undefined;
	private levelWarningKey: IContextKey<boolean> | undefined;
	private levelErrorKey: IContextKey<boolean> | undefined;
	private readonly eventListener = this._register(new MutableDisposable());
	private readonly sessionModelListener = this._register(new MutableDisposable());
	private currentDetailText: string = '';

	// --- Subagent Chart view ---
	private subagentChartContainer: HTMLElement | undefined;
	private subagentChartContent: HTMLElement | undefined;
	private subagentChartBreadcrumbWidget: BreadcrumbsWidget | undefined;

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
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@IHoverService private readonly hoverService: IHoverService,
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

		this.createHomeView(this.container);
		this.createOverviewView(this.container);
		this.createLogsView(this.container);
		this.createSubagentChartView(this.container);

		// When new debug events arrive, refresh the current view
		this._register(this.chatDebugService.onDidAddEvent(() => {
			if (this.viewState === ViewState.Home) {
				this.renderHomeContent();
			} else if (this.viewState === ViewState.Overview) {
				this.loadOverview();
			} else if (this.viewState === ViewState.Logs) {
				this.refreshList();
			}
		}));

		// When the focused chat widget changes, refresh home view session list
		this._register(this.chatWidgetService.onDidChangeFocusedSession(() => {
			if (this.viewState === ViewState.Home) {
				this.renderHomeContent();
			}
		}));

		this._register(this.chatService.onDidCreateModel(model => {
			// Set up a debug event pipeline for the new session so events
			// are captured regardless of which session the debug view shows.
			const sid = chatSessionResourceToId(model.sessionResource);
			this.chatDebugService.invokeProviders(sid);
			if (this.viewState === ViewState.Home) {
				this.renderHomeContent();
			}
		}));

		this._register(this.chatService.onDidDisposeSession(() => {
			if (this.viewState === ViewState.Home) {
				this.renderHomeContent();
			}
		}));

		// When a model's title changes, refresh the view to show the updated title
		this._register(this.chatService.onDidCreateModel(model => {
			this._register(model.onDidChange(e => {
				if (e.kind === 'setCustomTitle') {
					if (this.viewState === ViewState.Home) {
						this.renderHomeContent();
					} else if (this.viewState === ViewState.Overview || this.viewState === ViewState.Logs || this.viewState === ViewState.SubagentChart) {
						this.updateOverviewBreadcrumb();
						this.updateLogsBreadcrumb();
						this.updateSubagentChartBreadcrumb();
					}
				}
			}));
		}));

		// Invoke providers for all existing chat sessions so their event
		// pipelines are established and events start flowing immediately.
		for (const model of this.chatService.chatModels.get()) {
			const sid = chatSessionResourceToId(model.sessionResource);
			this.chatDebugService.invokeProviders(sid);
		}

		this.showView(ViewState.Home);
	}

	// =====================================================================
	// View switching
	// =====================================================================

	private showView(state: ViewState): void {
		this.viewState = state;
		if (this.homeContainer) {
			this.homeContainer.style.display = state === ViewState.Home ? '' : 'none';
		}
		if (this.overviewContainer) {
			this.overviewContainer.style.display = state === ViewState.Overview ? '' : 'none';
		}
		if (this.logsContainer) {
			this.logsContainer.style.display = state === ViewState.Logs ? '' : 'none';
		}
		if (this.subagentChartContainer) {
			this.subagentChartContainer.style.display = state === ViewState.SubagentChart ? '' : 'none';
		}

		if (state === ViewState.Home) {
			this.renderHomeContent();
		} else if (state === ViewState.Overview) {
			this.loadOverview();
		} else if (state === ViewState.Logs) {
			this.loadEventsForSession(this.currentSessionId);
			this.refreshList();
			this.doLayout();
		} else if (state === ViewState.SubagentChart) {
			this.renderSubagentChart();
		}
	}

	navigateToSession(sessionId: string, view?: 'logs' | 'overview'): void {
		this.currentSessionId = sessionId;
		this.chatDebugService.activeSessionId = sessionId;
		this.trackSessionModelChanges(sessionId);
		this.showView(view === 'logs' ? ViewState.Logs : ViewState.Overview);
	}

	private trackSessionModelChanges(sessionId: string): void {
		const sessionUri = LocalChatSessionUri.forSession(sessionId);
		const model = this.chatService.getSession(sessionUri);
		if (!model) {
			this.sessionModelListener.clear();
			return;
		}
		this.sessionModelListener.value = model.onDidChange(e => {
			if (e.kind === 'addRequest' || e.kind === 'completedRequest') {
				if (this.viewState === ViewState.Overview) {
					this.loadOverview();
				}
			}
		});
	}

	// =====================================================================
	// Home view
	// =====================================================================

	private createHomeView(parent: HTMLElement): void {
		this.homeContainer = document.createElement('div');
		this.homeContainer.className = 'chat-debug-home';
		parent.appendChild(this.homeContainer);
	}

	private renderHomeContent(): void {
		if (!this.homeContainer) {
			return;
		}
		this.homeContainer.textContent = '';

		const title = document.createElement('h2');
		title.className = 'chat-debug-home-title';
		title.textContent = localize('chatDebug.title', "Chat Debug Panel");
		this.homeContainer.appendChild(title);

		// Determine the active session ID
		const activeWidget = this.chatWidgetService.lastFocusedWidget;
		const activeSessionId = activeWidget?.viewModel?.sessionResource
			? chatSessionResourceToId(activeWidget.viewModel.sessionResource)
			: undefined;

		// List all sessions with debug log data, most recent first
		const sessionIds = [...this.chatDebugService.getSessionIds()].reverse();

		// Sort: active session first
		if (activeSessionId) {
			const activeIndex = sessionIds.indexOf(activeSessionId);
			if (activeIndex > 0) {
				sessionIds.splice(activeIndex, 1);
				sessionIds.unshift(activeSessionId);
			}
		}

		const subtitle = document.createElement('p');
		subtitle.className = 'chat-debug-home-subtitle';
		subtitle.textContent = sessionIds.length > 0
			? localize('chatDebug.homeSubtitle', "Select a chat session to debug")
			: localize('chatDebug.noSessions', "Send a chat message to get started");
		this.homeContainer.appendChild(subtitle);

		if (sessionIds.length > 0) {
			const sessionList = document.createElement('div');
			sessionList.className = 'chat-debug-home-session-list';

			for (const sessionId of sessionIds) {
				const sessionUri = LocalChatSessionUri.forSession(sessionId);
				const sessionTitle = this.chatService.getSessionTitle(sessionUri) || sessionId;
				const isActive = sessionId === activeSessionId;

				const item = document.createElement('button');
				item.className = 'chat-debug-home-session-item';
				if (isActive) {
					item.classList.add('chat-debug-home-session-item-active');
				}

				const titleSpan = document.createElement('span');
				titleSpan.className = 'chat-debug-home-session-item-title';
				if (isUUID(sessionTitle)) {
					titleSpan.classList.add('chat-debug-home-session-item-shimmer');
				} else {
					titleSpan.textContent = sessionTitle;
				}
				item.appendChild(titleSpan);

				if (isActive) {
					const badge = document.createElement('span');
					badge.className = 'chat-debug-home-session-badge';
					badge.textContent = localize('chatDebug.active', "Active");
					item.appendChild(badge);
				}

				item.addEventListener('click', () => {
					this.navigateToSession(sessionId);
				});
				sessionList.appendChild(item);
			}

			this.homeContainer.appendChild(sessionList);
		}
	}

	// =====================================================================
	// Overview view
	// =====================================================================

	private createOverviewView(parent: HTMLElement): void {
		this.overviewContainer = document.createElement('div');
		this.overviewContainer.className = 'chat-debug-overview';
		this.overviewContainer.style.display = 'none';
		parent.appendChild(this.overviewContainer);

		// Breadcrumb
		const overviewBreadcrumbContainer = document.createElement('div');
		overviewBreadcrumbContainer.className = 'chat-debug-breadcrumb';
		this.overviewContainer.appendChild(overviewBreadcrumbContainer);
		this.overviewBreadcrumbWidget = this._register(new BreadcrumbsWidget(overviewBreadcrumbContainer, 3, undefined, Codicon.chevronRight, defaultBreadcrumbsWidgetStyles));
		this._register(this.overviewBreadcrumbWidget.onDidSelectItem(e => {
			if (e.type === 'select' && e.item instanceof TextBreadcrumbItem) {
				this.overviewBreadcrumbWidget?.setSelection(undefined);
				// First item = home
				const items = this.overviewBreadcrumbWidget?.getItems() ?? [];
				const idx = items.indexOf(e.item);
				if (idx === 0) {
					this.chatDebugService.activeSessionId = undefined;
					this.currentSessionId = '';
					this.showView(ViewState.Home);
				}
			}
		}));

		this.overviewContent = document.createElement('div');
		this.overviewContent.className = 'chat-debug-overview-content';
		this.overviewContainer.appendChild(this.overviewContent);
	}

	private updateOverviewBreadcrumb(): void {
		if (!this.overviewBreadcrumbWidget) {
			return;
		}
		const sessionUri = LocalChatSessionUri.forSession(this.currentSessionId);
		const sessionTitle = this.chatService.getSessionTitle(sessionUri) || this.currentSessionId;
		this.overviewBreadcrumbWidget.setItems([
			new TextBreadcrumbItem(localize('chatDebug.title', "Chat Debug Panel"), true),
			new TextBreadcrumbItem(sessionTitle),
		]);
	}

	private async loadOverview(): Promise<void> {
		if (!this.overviewContent) {
			return;
		}
		this.overviewContent.textContent = '';
		this.updateOverviewBreadcrumb();

		// Session title from chat service
		const sessionUri = LocalChatSessionUri.forSession(this.currentSessionId);
		const sessionTitle = this.chatService.getSessionTitle(sessionUri) || this.currentSessionId;

		const titleRow = document.createElement('div');
		titleRow.className = 'chat-debug-overview-title-row';

		const titleEl = document.createElement('h2');
		titleEl.className = 'chat-debug-overview-title';
		titleEl.textContent = sessionTitle;
		titleRow.appendChild(titleEl);

		const titleActions = document.createElement('div');
		titleActions.className = 'chat-debug-overview-title-actions';

		const revealSessionBtn = document.createElement('button');
		revealSessionBtn.className = 'chat-debug-icon-button';
		revealSessionBtn.setAttribute('aria-label', localize('chatDebug.revealChatSession', "Reveal Chat Session"));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), revealSessionBtn, localize('chatDebug.revealChatSession', "Reveal Chat Session")));
		const revealIcon = document.createElement('span');
		revealIcon.className = ThemeIcon.asClassName(Codicon.goToFile);
		revealSessionBtn.appendChild(revealIcon);
		revealSessionBtn.addEventListener('click', () => {
			const uri = LocalChatSessionUri.forSession(this.currentSessionId);
			this.chatWidgetService.openSession(uri);
		});
		titleActions.appendChild(revealSessionBtn);

		const deleteBtn = document.createElement('button');
		deleteBtn.className = 'chat-debug-icon-button';
		deleteBtn.setAttribute('aria-label', localize('chatDebug.deleteDebugData', "Delete Debug Data"));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), deleteBtn, localize('chatDebug.deleteDebugData', "Delete Debug Data")));
		const deleteIcon = document.createElement('span');
		deleteIcon.className = ThemeIcon.asClassName(Codicon.trash);
		deleteBtn.appendChild(deleteIcon);
		deleteBtn.addEventListener('click', () => {
			this.chatDebugService.clearSession(this.currentSessionId);
			this.chatDebugService.activeSessionId = undefined;
			this.currentSessionId = '';
			this.showView(ViewState.Home);
		});
		titleActions.appendChild(deleteBtn);

		titleRow.appendChild(titleActions);

		this.overviewContent.appendChild(titleRow);

		// Session details section
		this.renderSessionDetails(sessionUri);

		// Derive overview metrics from typed events
		const events = this.chatDebugService.getEvents(this.currentSessionId);
		this.renderDerivedOverview(events);
	}

	private renderSessionDetails(sessionUri: URI): void {
		if (!this.overviewContent) {
			return;
		}

		const model = this.chatService.getSession(sessionUri);

		interface DetailItem { label: string; value: string }
		const details: DetailItem[] = [];

		// Session type (local vs contributed/cloud)
		const sessionType = getChatSessionType(sessionUri);
		const contribution = this.chatSessionsService.getChatSessionContribution(sessionType);
		const sessionTypeName = contribution?.displayName || (sessionType === 'local'
			? localize('chatDebug.sessionType.local', "Local")
			: sessionType);
		details.push({ label: localize('chatDebug.detail.sessionType', "Session Type"), value: sessionTypeName });

		if (model) {
			// Location
			const locationLabel = this.getLocationLabel(model.initialLocation);
			details.push({ label: localize('chatDebug.detail.location', "Location"), value: locationLabel });

			// Status
			const inProgress = model.requestInProgress.get();
			const statusLabel = inProgress
				? localize('chatDebug.status.inProgress', "In Progress")
				: localize('chatDebug.status.idle', "Idle");
			details.push({ label: localize('chatDebug.detail.status', "Status"), value: statusLabel });

			// Created
			const timing = model.timing;
			details.push({ label: localize('chatDebug.detail.created', "Created"), value: new Date(timing.created).toLocaleString() });

			// Last activity
			if (timing.lastRequestEnded) {
				details.push({ label: localize('chatDebug.detail.lastActivity', "Last Activity"), value: new Date(timing.lastRequestEnded).toLocaleString() });
			} else if (timing.lastRequestStarted) {
				details.push({ label: localize('chatDebug.detail.lastActivity', "Last Activity"), value: new Date(timing.lastRequestStarted).toLocaleString() });
			}
		}

		if (details.length > 0) {
			const section = document.createElement('div');
			section.className = 'chat-debug-overview-section';

			const sectionLabel = document.createElement('h3');
			sectionLabel.className = 'chat-debug-overview-section-label';
			sectionLabel.textContent = localize('chatDebug.sessionDetails', "Session Details");
			section.appendChild(sectionLabel);

			const detailsGrid = document.createElement('div');
			detailsGrid.className = 'chat-debug-overview-details';
			for (const detail of details) {
				const row = document.createElement('div');
				row.className = 'chat-debug-overview-detail-row';
				const labelEl = document.createElement('span');
				labelEl.className = 'chat-debug-overview-detail-label';
				labelEl.textContent = detail.label;
				const valueEl = document.createElement('span');
				valueEl.className = 'chat-debug-overview-detail-value';
				valueEl.textContent = detail.value;
				row.appendChild(labelEl);
				row.appendChild(valueEl);
				detailsGrid.appendChild(row);
			}
			section.appendChild(detailsGrid);
			this.overviewContent.appendChild(section);
		}
	}

	private getLocationLabel(location: ChatAgentLocation): string {
		switch (location) {
			case ChatAgentLocation.Chat: return localize('chatDebug.location.chat', "Chat Panel");
			case ChatAgentLocation.Terminal: return localize('chatDebug.location.terminal', "Terminal");
			case ChatAgentLocation.Notebook: return localize('chatDebug.location.notebook', "Notebook");
			case ChatAgentLocation.EditorInline: return localize('chatDebug.location.editor', "Editor Inline");
			default: return String(location);
		}
	}

	private renderDerivedOverview(events: readonly IChatDebugEvent[]): void {
		if (!this.overviewContent) {
			return;
		}

		// Aggregate metrics from typed events
		const modelTurns = events.filter(e => e.kind === 'modelTurn');
		const toolCalls = events.filter(e => e.kind === 'toolCall');
		const errors = events.filter(e =>
			(e.kind === 'generic' && e.level === ChatDebugLogLevel.Error) ||
			(e.kind === 'toolCall' && e.result === 'error')
		);

		const totalTokens = modelTurns.reduce((sum, e) => sum + (e.totalTokens ?? 0), 0);
		const totalCost = modelTurns.reduce((sum, e) => sum + (e.cost ?? 0), 0);

		interface OverviewMetric { label: string; value: string }
		const metrics: OverviewMetric[] = [];

		if (modelTurns.length > 0) {
			metrics.push({ label: localize('chatDebug.metric.modelTurns', "Model Turns"), value: String(modelTurns.length) });
		}
		if (toolCalls.length > 0) {
			metrics.push({ label: localize('chatDebug.metric.toolCalls', "Tool Calls"), value: String(toolCalls.length) });
		}
		if (totalTokens > 0) {
			metrics.push({ label: localize('chatDebug.metric.totalTokens', "Total Tokens"), value: totalTokens.toLocaleString() });
		}
		if (totalCost > 0) {
			metrics.push({ label: localize('chatDebug.metric.totalCost', "Total Cost"), value: `$${totalCost.toFixed(4)}` });
		}
		if (errors.length > 0) {
			metrics.push({ label: localize('chatDebug.metric.errors', "Errors"), value: String(errors.length) });
		}
		metrics.push({ label: localize('chatDebug.metric.totalEvents', "Total Events"), value: String(events.length) });

		if (metrics.length > 0) {
			const metricsSection = document.createElement('div');
			metricsSection.className = 'chat-debug-overview-section';

			const metricsLabel = document.createElement('h3');
			metricsLabel.className = 'chat-debug-overview-section-label';
			metricsLabel.textContent = localize('chatDebug.sessionAtAGlance', "Session at a Glance");
			metricsSection.appendChild(metricsLabel);

			const metricsRow = document.createElement('div');
			metricsRow.className = 'chat-debug-overview-metrics';
			for (const metric of metrics) {
				const card = document.createElement('div');
				card.className = 'chat-debug-overview-metric-card';
				const label = document.createElement('div');
				label.className = 'chat-debug-overview-metric-label';
				label.textContent = metric.label;
				const value = document.createElement('div');
				value.className = 'chat-debug-overview-metric-value';
				value.textContent = metric.value;
				card.appendChild(label);
				card.appendChild(value);
				metricsRow.appendChild(card);
			}
			metricsSection.appendChild(metricsRow);
			this.overviewContent.appendChild(metricsSection);
		}

		// View Logs action
		const actionsSection = document.createElement('div');
		actionsSection.className = 'chat-debug-overview-section';

		const actionsLabel = document.createElement('h3');
		actionsLabel.className = 'chat-debug-overview-section-label';
		actionsLabel.textContent = localize('chatDebug.exploreTraceData', "Explore Trace Data");
		actionsSection.appendChild(actionsLabel);

		const row = document.createElement('div');
		row.className = 'chat-debug-overview-actions';

		const viewLogsBtn = document.createElement('button');
		viewLogsBtn.className = 'chat-debug-overview-action-button';
		const viewLogsIcon = document.createElement('span');
		viewLogsIcon.className = ThemeIcon.asClassName(Codicon.listFlat);
		viewLogsBtn.appendChild(viewLogsIcon);
		viewLogsBtn.append(localize('chatDebug.viewLogs', "View Logs"));
		viewLogsBtn.addEventListener('click', () => {
			this.showView(ViewState.Logs);
		});
		row.appendChild(viewLogsBtn);

		const viewSubagentBtn = document.createElement('button');
		viewSubagentBtn.className = 'chat-debug-overview-action-button';
		const viewSubagentIcon = document.createElement('span');
		viewSubagentIcon.className = ThemeIcon.asClassName(Codicon.typeHierarchy);
		viewSubagentBtn.appendChild(viewSubagentIcon);
		viewSubagentBtn.append(localize('chatDebug.viewSubagentChart', "Subagent Flow"));
		viewSubagentBtn.addEventListener('click', () => {
			this.showView(ViewState.SubagentChart);
		});
		row.appendChild(viewSubagentBtn);

		actionsSection.appendChild(row);
		this.overviewContent.appendChild(actionsSection);
	}

	// =====================================================================
	// Logs view
	// =====================================================================

	private createLogsView(parent: HTMLElement): void {
		this.logsContainer = document.createElement('div');
		this.logsContainer.className = 'chat-debug-logs';
		this.logsContainer.style.display = 'none';
		parent.appendChild(this.logsContainer);

		// Breadcrumb: Chat Debug Panel > Session Title > Logs
		const logsBreadcrumbContainer = document.createElement('div');
		logsBreadcrumbContainer.className = 'chat-debug-breadcrumb';
		this.logsContainer.appendChild(logsBreadcrumbContainer);
		this.logsBreadcrumbWidget = this._register(new BreadcrumbsWidget(logsBreadcrumbContainer, 3, undefined, Codicon.chevronRight, defaultBreadcrumbsWidgetStyles));
		this._register(this.logsBreadcrumbWidget.onDidSelectItem(e => {
			if (e.type === 'select' && e.item instanceof TextBreadcrumbItem) {
				this.logsBreadcrumbWidget?.setSelection(undefined);
				const items = this.logsBreadcrumbWidget?.getItems() ?? [];
				const idx = items.indexOf(e.item);
				if (idx === 0) {
					this.chatDebugService.activeSessionId = undefined;
					this.currentSessionId = '';
					this.showView(ViewState.Home);
				} else if (idx === 1) {
					this.showView(ViewState.Overview);
				}
			}
		}));

		// Header (filter)
		this.headerContainer = document.createElement('div');
		this.headerContainer.className = 'chat-debug-editor-header';
		this.logsContainer.appendChild(this.headerContainer);

		// Create scoped context key service for filter menu items
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

		// View mode toggle (List / Tree) - placed before the filter widget
		this.viewModeToggle = document.createElement('button');
		this.viewModeToggle.className = 'chat-debug-view-mode-toggle';
		this.updateViewModeToggle();
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.viewModeToggle, localize('chatDebug.toggleViewMode', "Toggle between list and tree view")));
		this._register(addDisposableListener(this.viewModeToggle, EventType.CLICK, () => {
			this.toggleLogsViewMode();
		}));
		this.headerContainer.appendChild(this.viewModeToggle);

		const filterContainer = document.createElement('div');
		filterContainer.className = 'viewpane-filter-container';
		filterContainer.appendChild(this.filterWidget.element);
		this.headerContainer.appendChild(filterContainer);

		this._register(this.filterWidget.onDidChangeFilterText(text => {
			this.filterText = text.toLowerCase();
			this.refreshList();
		}));

		// Register filter toggle commands and menu items
		this.registerFilterMenuItems();

		// Table header
		this.tableHeader = document.createElement('div');
		this.tableHeader.className = 'chat-debug-table-header';
		const thCreated = document.createElement('span');
		thCreated.className = 'chat-debug-col-created';
		thCreated.textContent = localize('chatDebug.col.created', "Created");
		const thName = document.createElement('span');
		thName.className = 'chat-debug-col-name';
		thName.textContent = localize('chatDebug.col.name', "Name");
		const thDetails = document.createElement('span');
		thDetails.className = 'chat-debug-col-details';
		thDetails.textContent = localize('chatDebug.col.details', "Details");
		this.tableHeader.appendChild(thCreated);
		this.tableHeader.appendChild(thName);
		this.tableHeader.appendChild(thDetails);
		this.logsContainer.appendChild(this.tableHeader);

		// Body container (horizontal: list on left, detail on right)
		this.bodyContainer = document.createElement('div');
		this.bodyContainer.className = 'chat-debug-logs-body';
		this.logsContainer.appendChild(this.bodyContainer);

		// List container
		this.listContainer = document.createElement('div');
		this.listContainer.className = 'chat-debug-list-container';
		this.bodyContainer.appendChild(this.listContainer);

		this.list = this._register(this.instantiationService.createInstance(
			WorkbenchList<IChatDebugEvent>,
			'ChatDebugEvents',
			this.listContainer,
			new ChatDebugEventDelegate(),
			[new ChatDebugEventRenderer()],
			{
				identityProvider: { getId: (e: IChatDebugEvent) => e.id ?? `${e.created.getTime()}-${e.kind}` },
				accessibilityProvider: {
					getAriaLabel: (e: IChatDebugEvent) => {
						switch (e.kind) {
							case 'toolCall': return `${e.kind}: ${e.toolName}${e.result ? ` (${e.result})` : ''}`;
							case 'modelTurn': return `${e.kind}: ${e.model ?? 'model'}${e.totalTokens ? ` ${e.totalTokens} tokens` : ''}`;
							case 'generic': return `${e.category ? e.category + ': ' : ''}${e.name}: ${e.details ?? ''}`;
							case 'subagentInvocation': return `${e.kind}: ${e.agentName}${e.description ? ` - ${e.description}` : ''}`;
						}
					},
					getWidgetAriaLabel: () => localize('chatDebug.ariaLabel', "Chat Debug Events"),
				},
			}
		));

		// Tree container (initially hidden)
		this.treeContainer = document.createElement('div');
		this.treeContainer.className = 'chat-debug-list-container';
		this.treeContainer.style.display = 'none';
		this.bodyContainer.appendChild(this.treeContainer);

		this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchObjectTree<IChatDebugEvent, void>,
			'ChatDebugEventsTree',
			this.treeContainer,
			new ChatDebugEventDelegate(),
			[new ChatDebugEventTreeRenderer()],
			{
				identityProvider: { getId: (e: IChatDebugEvent) => e.id ?? `${e.created.getTime()}-${e.kind}` },
				accessibilityProvider: {
					getAriaLabel: (e: IChatDebugEvent) => {
						switch (e.kind) {
							case 'toolCall': return `${e.kind}: ${e.toolName}${e.result ? ` (${e.result})` : ''}`;
							case 'modelTurn': return `${e.kind}: ${e.model ?? 'model'}${e.totalTokens ? ` ${e.totalTokens} tokens` : ''}`;
							case 'generic': return `${e.category ? e.category + ': ' : ''}${e.name}: ${e.details ?? ''}`;
							case 'subagentInvocation': return `${e.kind}: ${e.agentName}${e.description ? ` - ${e.description}` : ''}`;
						}
					},
					getWidgetAriaLabel: () => localize('chatDebug.ariaLabel', "Chat Debug Events"),
				},
			}
		));

		// Detail panel (shown to the right of list when an event is selected)
		this.detailContainer = document.createElement('div');
		this.detailContainer.className = 'chat-debug-detail-panel';
		this.detailContainer.style.display = 'none';
		this.bodyContainer.appendChild(this.detailContainer);

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

	private updateLogsBreadcrumb(): void {
		if (!this.logsBreadcrumbWidget) {
			return;
		}
		const sessionUri = LocalChatSessionUri.forSession(this.currentSessionId);
		const sessionTitle = this.chatService.getSessionTitle(sessionUri) || this.currentSessionId;
		this.logsBreadcrumbWidget.setItems([
			new TextBreadcrumbItem(localize('chatDebug.title', "Chat Debug Panel"), true),
			new TextBreadcrumbItem(sessionTitle, true),
			new TextBreadcrumbItem(localize('chatDebug.logs', "Logs")),
		]);
	}

	private loadEventsForSession(sessionId: string): void {
		this.events = [...this.chatDebugService.getEvents(sessionId || undefined)];
		this.eventListener.value = this.chatDebugService.onDidAddEvent(e => {
			if (!this.currentSessionId || e.sessionId === this.currentSessionId) {
				this.events.push(e);
				this.refreshList();
			}
		});
		this.updateLogsBreadcrumb();
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

		registerKindToggle('chatDebug.filter.toggleToolCall', localize('chatDebug.filter.toolCall', "Tool Calls"), CHAT_DEBUG_KIND_TOOL_CALL, () => this.filterKindToolCall, v => { this.filterKindToolCall = v; }, this.kindToolCallKey!);
		registerKindToggle('chatDebug.filter.toggleModelTurn', localize('chatDebug.filter.modelTurn', "Model Turns"), CHAT_DEBUG_KIND_MODEL_TURN, () => this.filterKindModelTurn, v => { this.filterKindModelTurn = v; }, this.kindModelTurnKey!);
		registerKindToggle('chatDebug.filter.toggleGeneric', localize('chatDebug.filter.generic', "Generic"), CHAT_DEBUG_KIND_GENERIC, () => this.filterKindGeneric, v => { this.filterKindGeneric = v; }, this.kindGenericKey!);
		registerKindToggle('chatDebug.filter.toggleSubagent', localize('chatDebug.filter.subagent', "Subagent Invocations"), CHAT_DEBUG_KIND_SUBAGENT, () => this.filterKindSubagent, v => { this.filterKindSubagent = v; }, this.kindSubagentKey!);

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

		registerLevelToggle('chatDebug.filter.toggleTrace', localize('chatDebug.filter.trace', "Trace"), CHAT_DEBUG_LEVEL_TRACE, () => this.filterLevelTrace, v => { this.filterLevelTrace = v; }, this.levelTraceKey!);
		registerLevelToggle('chatDebug.filter.toggleInfo', localize('chatDebug.filter.info', "Info"), CHAT_DEBUG_LEVEL_INFO, () => this.filterLevelInfo, v => { this.filterLevelInfo = v; }, this.levelInfoKey!);
		registerLevelToggle('chatDebug.filter.toggleWarning', localize('chatDebug.filter.warning', "Warning"), CHAT_DEBUG_LEVEL_WARNING, () => this.filterLevelWarning, v => { this.filterLevelWarning = v; }, this.levelWarningKey!);
		registerLevelToggle('chatDebug.filter.toggleError', localize('chatDebug.filter.error', "Error"), CHAT_DEBUG_LEVEL_ERROR, () => this.filterLevelError, v => { this.filterLevelError = v; }, this.levelErrorKey!);
	}

	private updateMoreFiltersChecked(): void {
		const allOn = this.filterKindToolCall && this.filterKindModelTurn &&
			this.filterKindGeneric && this.filterKindSubagent &&
			this.filterLevelTrace && this.filterLevelInfo &&
			this.filterLevelWarning && this.filterLevelError;
		this.filterWidget?.checkMoreFilters(!allOn);
	}

	private refreshList(): void {
		if (!this.list) {
			return;
		}

		let filtered = this.events;

		// Filter by kind toggles
		filtered = filtered.filter(e => {
			switch (e.kind) {
				case 'toolCall': return this.filterKindToolCall;
				case 'modelTurn': return this.filterKindModelTurn;
				case 'generic': return this.filterKindGeneric;
				case 'subagentInvocation': return this.filterKindSubagent;
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
			filtered = filtered.filter(e => {
				if (e.kind.toLowerCase().includes(this.filterText)) {
					return true;
				}
				switch (e.kind) {
					case 'toolCall':
						return e.toolName.toLowerCase().includes(this.filterText) ||
							(e.input?.toLowerCase().includes(this.filterText)) ||
							(e.output?.toLowerCase().includes(this.filterText));
					case 'modelTurn':
						return (e.model?.toLowerCase().includes(this.filterText));
					case 'generic':
						return e.name.toLowerCase().includes(this.filterText) ||
							(e.details?.toLowerCase().includes(this.filterText)) ||
							(e.category?.toLowerCase().includes(this.filterText));
					case 'subagentInvocation':
						return e.agentName.toLowerCase().includes(this.filterText) ||
							(e.description?.toLowerCase().includes(this.filterText));
				}
			});
		}

		if (this.logsViewMode === LogsViewMode.List) {
			this.list.splice(0, this.list.length, filtered);
		} else {
			this.refreshTree(filtered);
		}
	}

	private refreshTree(filtered: IChatDebugEvent[]): void {
		if (!this.tree) {
			return;
		}

		const treeElements = this.buildTreeHierarchy(filtered);
		this.tree.setChildren(null, treeElements);
	}

	private buildTreeHierarchy(events: IChatDebugEvent[]): IObjectTreeElement<IChatDebugEvent>[] {
		const idToEvent = new Map<string, IChatDebugEvent>();
		const idToChildren = new Map<string, IChatDebugEvent[]>();
		const roots: IChatDebugEvent[] = [];

		// Index events by id
		for (const event of events) {
			if (event.id) {
				idToEvent.set(event.id, event);
			}
		}

		// Group children under parents
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

	private toggleLogsViewMode(): void {
		if (this.logsViewMode === LogsViewMode.List) {
			this.logsViewMode = LogsViewMode.Tree;
			this.updateViewModeToggle();
			if (this.listContainer) {
				this.listContainer.style.display = 'none';
			}
			if (this.treeContainer) {
				this.treeContainer.style.display = '';
			}
		} else {
			this.logsViewMode = LogsViewMode.List;
			this.updateViewModeToggle();
			if (this.listContainer) {
				this.listContainer.style.display = '';
			}
			if (this.treeContainer) {
				this.treeContainer.style.display = 'none';
			}
		}
		this.refreshList();
		this.doLayout();
	}

	private updateViewModeToggle(): void {
		if (!this.viewModeToggle) {
			return;
		}
		this.viewModeToggle.textContent = '';
		const icon = document.createElement('span');
		if (this.logsViewMode === LogsViewMode.Tree) {
			icon.className = ThemeIcon.asClassName(Codicon.listTree);
			this.viewModeToggle.appendChild(icon);
			this.viewModeToggle.append(localize('chatDebug.treeView', "Tree View"));
		} else {
			icon.className = ThemeIcon.asClassName(Codicon.listFlat);
			this.viewModeToggle.appendChild(icon);
			this.viewModeToggle.append(localize('chatDebug.listView', "List View"));
		}
	}

	private async resolveAndShowDetail(event: IChatDebugEvent): Promise<void> {
		if (!this.detailContainer) {
			return;
		}
		const resolved = event.id ? await this.chatDebugService.resolveEvent(event.id) : undefined;

		this.detailContainer.style.display = '';
		this.detailContainer.textContent = '';

		// Header with full-screen and close buttons
		const header = document.createElement('div');
		header.className = 'chat-debug-detail-header';

		const fullScreenButton = document.createElement('button');
		fullScreenButton.className = 'chat-debug-detail-button';
		fullScreenButton.setAttribute('aria-label', localize('chatDebug.openInEditor', "Open in Editor"));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), fullScreenButton, localize('chatDebug.openInEditor', "Open in Editor")));
		const fullScreenIcon = document.createElement('span');
		fullScreenIcon.className = ThemeIcon.asClassName(Codicon.goToFile);
		fullScreenButton.appendChild(fullScreenIcon);
		fullScreenButton.addEventListener('click', () => {
			this.editorService.openEditor({ contents: this.currentDetailText, resource: undefined } satisfies IUntitledTextResourceEditorInput);
		});
		header.appendChild(fullScreenButton);

		const copyButton = document.createElement('button');
		copyButton.className = 'chat-debug-detail-button';
		copyButton.setAttribute('aria-label', localize('chatDebug.copyToClipboard', "Copy"));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), copyButton, localize('chatDebug.copyToClipboard', "Copy")));
		const copyIcon = document.createElement('span');
		copyIcon.className = ThemeIcon.asClassName(Codicon.copy);
		copyButton.appendChild(copyIcon);
		copyButton.addEventListener('click', () => {
			this.clipboardService.writeText(this.currentDetailText);
		});
		header.appendChild(copyButton);

		const closeButton = document.createElement('button');
		closeButton.className = 'chat-debug-detail-button';
		closeButton.setAttribute('aria-label', localize('chatDebug.closeDetail', "Close"));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), closeButton, localize('chatDebug.closeDetail', "Close")));
		const closeIcon = document.createElement('span');
		closeIcon.className = ThemeIcon.asClassName(Codicon.close);
		closeButton.appendChild(closeIcon);
		closeButton.addEventListener('click', () => {
			this.list?.setSelection([]);
			this.hideDetail();
		});
		header.appendChild(closeButton);
		this.detailContainer.appendChild(header);

		const pre = document.createElement('pre');
		pre.tabIndex = 0;
		if (resolved) {
			this.currentDetailText = resolved;
		} else {
			this.currentDetailText = this._formatEventDetail(event);
		}
		pre.textContent = this.currentDetailText;
		this.detailContainer.appendChild(pre);
	}

	private _formatEventDetail(event: IChatDebugEvent): string {
		switch (event.kind) {
			case 'toolCall': {
				const parts = [`Tool: ${event.toolName}`];
				if (event.toolCallId) { parts.push(`Call ID: ${event.toolCallId}`); }
				if (event.result) { parts.push(`Result: ${event.result}`); }
				if (event.durationInMillis !== undefined) { parts.push(`Duration: ${event.durationInMillis}ms`); }
				if (event.input) { parts.push(`\nInput:\n${event.input}`); }
				if (event.output) { parts.push(`\nOutput:\n${event.output}`); }
				return parts.join('\n');
			}
			case 'modelTurn': {
				const parts = [event.model ?? 'Model Turn'];
				if (event.inputTokens !== undefined) { parts.push(`Input tokens: ${event.inputTokens}`); }
				if (event.outputTokens !== undefined) { parts.push(`Output tokens: ${event.outputTokens}`); }
				if (event.totalTokens !== undefined) { parts.push(`Total tokens: ${event.totalTokens}`); }
				if (event.cost !== undefined) { parts.push(`Cost: $${event.cost.toFixed(4)}`); }
				if (event.durationInMillis !== undefined) { parts.push(`Duration: ${event.durationInMillis}ms`); }
				return parts.join('\n');
			}
			case 'generic':
				return `${event.name}\n${event.details ?? ''}`;
			case 'subagentInvocation': {
				const parts = [`Agent: ${event.agentName}`];
				if (event.description) { parts.push(`Description: ${event.description}`); }
				if (event.status) { parts.push(`Status: ${event.status}`); }
				if (event.durationInMillis !== undefined) { parts.push(`Duration: ${event.durationInMillis}ms`); }
				if (event.toolCallCount !== undefined) { parts.push(`Tool calls: ${event.toolCallCount}`); }
				if (event.modelTurnCount !== undefined) { parts.push(`Model turns: ${event.modelTurnCount}`); }
				return parts.join('\n');
			}
		}
	}

	private hideDetail(): void {
		if (this.detailContainer) {
			this.detailContainer.style.display = 'none';
			this.detailContainer.textContent = '';
		}
	}

	// =====================================================================
	// Subagent Chart view
	// =====================================================================

	private createSubagentChartView(parent: HTMLElement): void {
		this.subagentChartContainer = document.createElement('div');
		this.subagentChartContainer.className = 'chat-debug-subagent-chart';
		this.subagentChartContainer.style.display = 'none';
		parent.appendChild(this.subagentChartContainer);

		// Breadcrumb
		const subagentBreadcrumbContainer = document.createElement('div');
		subagentBreadcrumbContainer.className = 'chat-debug-breadcrumb';
		this.subagentChartContainer.appendChild(subagentBreadcrumbContainer);
		this.subagentChartBreadcrumbWidget = this._register(new BreadcrumbsWidget(subagentBreadcrumbContainer, 3, undefined, Codicon.chevronRight, defaultBreadcrumbsWidgetStyles));
		this._register(this.subagentChartBreadcrumbWidget.onDidSelectItem(e => {
			if (e.type === 'select' && e.item instanceof TextBreadcrumbItem) {
				this.subagentChartBreadcrumbWidget?.setSelection(undefined);
				const items = this.subagentChartBreadcrumbWidget?.getItems() ?? [];
				const idx = items.indexOf(e.item);
				if (idx === 0) {
					this.chatDebugService.activeSessionId = undefined;
					this.currentSessionId = '';
					this.showView(ViewState.Home);
				} else if (idx === 1) {
					this.showView(ViewState.Overview);
				}
			}
		}));

		this.subagentChartContent = document.createElement('div');
		this.subagentChartContent.className = 'chat-debug-subagent-chart-content';
		this.subagentChartContainer.appendChild(this.subagentChartContent);
	}

	private updateSubagentChartBreadcrumb(): void {
		if (!this.subagentChartBreadcrumbWidget) {
			return;
		}
		const sessionUri = LocalChatSessionUri.forSession(this.currentSessionId);
		const sessionTitle = this.chatService.getSessionTitle(sessionUri) || this.currentSessionId;
		this.subagentChartBreadcrumbWidget.setItems([
			new TextBreadcrumbItem(localize('chatDebug.title', "Chat Debug Panel"), true),
			new TextBreadcrumbItem(sessionTitle, true),
			new TextBreadcrumbItem(localize('chatDebug.subagentFlow', "Subagent Flow")),
		]);
	}

	private renderSubagentChart(): void {
		if (!this.subagentChartContent) {
			return;
		}
		this.subagentChartContent.textContent = '';
		this.updateSubagentChartBreadcrumb();

		console.log('[chatDebug][renderSubagentChart] currentSessionId:', this.currentSessionId);
		const events = this.chatDebugService.getEvents(this.currentSessionId);
		console.log('[chatDebug][renderSubagentChart] Events from debug service:', events.length);
		const kindCounts: Record<string, number> = {};
		for (const e of events) { kindCounts[e.kind] = (kindCounts[e.kind] || 0) + 1; }
		console.log('[chatDebug][renderSubagentChart] Event kinds breakdown:', kindCounts);
		const mermaidCode = generateSubagentFlowchart(events);

		// Title
		const titleEl = document.createElement('h3');
		titleEl.className = 'chat-debug-subagent-chart-title';
		titleEl.textContent = localize('chatDebug.subagentFlowDiagram', "Subagent Flow Diagram");
		this.subagentChartContent.appendChild(titleEl);

		const desc = document.createElement('p');
		desc.className = 'chat-debug-subagent-chart-desc';
		desc.textContent = localize('chatDebug.subagentFlowDesc', "Mermaid flowchart showing the control flow between the main agent and sub-agents.");
		this.subagentChartContent.appendChild(desc);

		// Actions bar
		const actionsBar = document.createElement('div');
		actionsBar.className = 'chat-debug-subagent-chart-actions';

		const copyBtn = document.createElement('button');
		copyBtn.className = 'chat-debug-overview-action-button';
		copyBtn.textContent = localize('chatDebug.copyMermaid', "Copy Mermaid");
		copyBtn.addEventListener('click', () => {
			this.clipboardService.writeText(mermaidCode);
		});
		actionsBar.appendChild(copyBtn);

		const openBtn = document.createElement('button');
		openBtn.className = 'chat-debug-overview-action-button';
		openBtn.textContent = localize('chatDebug.openAsMarkdown', "Open as Markdown");
		openBtn.addEventListener('click', () => {
			const mdContent = '```mermaid\n' + mermaidCode + '\n```\n';
			this.editorService.openEditor({
				contents: mdContent, resource: undefined, languageId: 'markdown'
			} satisfies IUntitledTextResourceEditorInput);
		});
		actionsBar.appendChild(openBtn);

		this.subagentChartContent.appendChild(actionsBar);

		// Visual flow representation (HTML/CSS)
		const flowContainer = document.createElement('div');
		flowContainer.className = 'chat-debug-subagent-flow-visual';
		renderVisualFlow(flowContainer, events);
		this.subagentChartContent.appendChild(flowContainer);
	}

	// =====================================================================
	// EditorPane overrides
	// =====================================================================

	override focus(): void {
		if (this.viewState === ViewState.Logs) {
			if (this.logsViewMode === LogsViewMode.Tree) {
				this.tree?.domFocus();
			} else {
				this.list?.domFocus();
			}
		} else {
			this.container?.focus();
		}
	}

	override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible) {
			const hint = this.chatDebugService.activeViewHint;
			this.chatDebugService.activeViewHint = undefined; // consume once

			if (hint) {
				const sessionId = this.chatDebugService.activeSessionId;
				if (hint === 'logs' && sessionId) {
					this.currentSessionId = sessionId;
					this.showView(ViewState.Logs);
				} else if (hint === 'overview' && sessionId) {
					this.currentSessionId = sessionId;
					this.showView(ViewState.Overview);
				}
			} else if (this.viewState === ViewState.Home) {
				const sessionId = this.chatDebugService.activeSessionId;
				if (sessionId) {
					this.currentSessionId = sessionId;
					this.showView(ViewState.Overview);
				} else {
					this.showView(ViewState.Home);
				}
			}
			// Otherwise, preserve the current view state (e.g. Logs)
		}
	}

	override layout(dimension: Dimension): void {
		this.currentDimension = dimension;
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
		this.doLayout();
	}

	private doLayout(): void {
		if (!this.currentDimension || this.viewState !== ViewState.Logs) {
			return;
		}
		const breadcrumbHeight = this.logsBreadcrumbWidget ? 22 : 0;
		const headerHeight = this.headerContainer?.offsetHeight ?? 0;
		const tableHeaderHeight = this.tableHeader?.offsetHeight ?? 0;
		const detailVisible = this.detailContainer?.style.display !== 'none';
		const detailWidth = detailVisible ? (this.detailContainer?.offsetWidth ?? 0) : 0;
		const listHeight = this.currentDimension.height - breadcrumbHeight - headerHeight - tableHeaderHeight;
		const listWidth = this.currentDimension.width - detailWidth;
		if (this.logsViewMode === LogsViewMode.Tree) {
			this.tree?.layout(listHeight, listWidth);
		} else {
			this.list?.layout(listHeight, listWidth);
		}
	}

	override dispose(): void {
		super.dispose();
	}
}
