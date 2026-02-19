/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, Dimension, EventType } from '../../../../../base/browser/dom.js';
import { createStyleSheet } from '../../../../../base/browser/domStylesheets.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { ChatDebugLogLevel, IChatDebugEvent, IChatDebugService } from '../../common/chatDebugService.js';
import { IChatService } from '../../common/chatService/chatService.js';
import { chatSessionResourceToId, LocalChatSessionUri } from '../../common/model/chatUri.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { IChatWidgetService } from '../chat.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IUntitledTextResourceEditorInput } from '../../../../common/editor.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { isUUID } from '../../../../../base/common/uuid.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { ChatDebugEventRenderer, ChatDebugEventDelegate } from './chatDebugEventList.js';
import { chatDebugStyles } from './chatDebugStyles.js';
import { generateSubagentFlowchart, renderVisualFlow } from './chatDebugSubagentChart.js';

const enum ViewState {
	Home = 'home',
	Overview = 'overview',
	Logs = 'logs',
	SubagentChart = 'subagentChart',
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
	private overviewBreadcrumb: HTMLElement | undefined;

	// --- Logs view ---
	private logsContainer: HTMLElement | undefined;
	private list: WorkbenchList<IChatDebugEvent> | undefined;
	private headerContainer: HTMLElement | undefined;
	private detailContainer: HTMLElement | undefined;
	private searchInput: HTMLInputElement | undefined;
	private tableHeader: HTMLElement | undefined;
	private bodyContainer: HTMLElement | undefined;
	private listContainer: HTMLElement | undefined;
	private breadcrumbContainer: HTMLElement | undefined;
	private events: IChatDebugEvent[] = [];
	private filterText: string = '';
	private filterKind: string = '';
	private filterLevel: string = '';
	private kindSelect: HTMLSelectElement | undefined;
	private levelSelect: HTMLSelectElement | undefined;
	private eventListener: IDisposable | undefined;
	private currentDetailText: string = '';

	// --- Subagent Chart view ---
	private subagentChartContainer: HTMLElement | undefined;
	private subagentChartContent: HTMLElement | undefined;
	private subagentChartBreadcrumb: HTMLElement | undefined;

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

		this._register(this.chatService.onDidCreateModel(() => {
			if (this.viewState === ViewState.Home) {
				this.renderHomeContent();
			}
		}));

		this._register(this.chatService.onDidDisposeSession(() => {
			if (this.viewState === ViewState.Home) {
				this.renderHomeContent();
			}
		}));

		// When a request is submitted, the session title may update
		this._register(this.chatService.onDidSubmitRequest(() => {
			if (this.viewState === ViewState.Home) {
				this.renderHomeContent();
			}
		}));

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

	private navigateToSession(sessionId: string): void {
		this.currentSessionId = sessionId;
		this.chatDebugService.activeSessionId = sessionId;
		this.chatDebugService.invokeProviders(sessionId);
		this.showView(ViewState.Overview);
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
		title.textContent = localize('chatDebug.title', "Debug View");
		this.homeContainer.appendChild(title);

		const subtitle = document.createElement('p');
		subtitle.className = 'chat-debug-home-subtitle';
		subtitle.textContent = localize('chatDebug.homeSubtitle', "Select a chat session to debug");
		this.homeContainer.appendChild(subtitle);

		// Determine the active session ID
		const activeWidget = this.chatWidgetService.lastFocusedWidget;
		const activeSessionId = activeWidget?.viewModel?.sessionResource
			? chatSessionResourceToId(activeWidget.viewModel.sessionResource)
			: undefined;

		// List all sessions with debug log data
		const sessionIds = [...this.chatDebugService.getSessionIds()];

		// Sort: active session first
		if (activeSessionId) {
			const activeIndex = sessionIds.indexOf(activeSessionId);
			if (activeIndex > 0) {
				sessionIds.splice(activeIndex, 1);
				sessionIds.unshift(activeSessionId);
			}
		}

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
		} else {
			const empty = document.createElement('p');
			empty.className = 'chat-debug-home-empty';
			empty.textContent = localize('chatDebug.noSessions', "No sessions with debug data. Send a message in a chat session to get started.");
			this.homeContainer.appendChild(empty);
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
		this.overviewBreadcrumb = document.createElement('div');
		this.overviewBreadcrumb.className = 'chat-debug-breadcrumb';
		this.overviewContainer.appendChild(this.overviewBreadcrumb);

		this.overviewContent = document.createElement('div');
		this.overviewContent.className = 'chat-debug-overview-content';
		this.overviewContainer.appendChild(this.overviewContent);
	}

	private updateOverviewBreadcrumb(): void {
		if (!this.overviewBreadcrumb) {
			return;
		}
		this.overviewBreadcrumb.textContent = '';

		const homeLink = document.createElement('button');
		homeLink.className = 'chat-debug-breadcrumb-link';
		homeLink.textContent = localize('chatDebug.title', "Debug View");
		homeLink.addEventListener('click', () => {
			this.chatDebugService.activeSessionId = undefined;
			this.currentSessionId = '';
			this.showView(ViewState.Home);
		});
		this.overviewBreadcrumb.appendChild(homeLink);

		const sep = document.createElement('span');
		sep.className = 'chat-debug-breadcrumb-sep';
		sep.textContent = '>';
		this.overviewBreadcrumb.appendChild(sep);

		const sessionUri = LocalChatSessionUri.forSession(this.currentSessionId);
		const sessionTitle = this.chatService.getSessionTitle(sessionUri) || this.currentSessionId;
		const sessionLabel = document.createElement('span');
		sessionLabel.className = 'chat-debug-breadcrumb-current';
		sessionLabel.textContent = sessionTitle;
		this.overviewBreadcrumb.appendChild(sessionLabel);
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

		const revealSessionBtn = document.createElement('button');
		revealSessionBtn.className = 'chat-debug-icon-button';
		revealSessionBtn.title = localize('chatDebug.revealChatSession', "Reveal Chat Session");
		revealSessionBtn.setAttribute('aria-label', localize('chatDebug.revealChatSession', "Reveal Chat Session"));
		const revealIcon = document.createElement('span');
		revealIcon.className = ThemeIcon.asClassName(Codicon.goToFile);
		revealSessionBtn.appendChild(revealIcon);
		revealSessionBtn.addEventListener('click', () => {
			const uri = LocalChatSessionUri.forSession(this.currentSessionId);
			this.chatWidgetService.openSession(uri);
		});
		titleRow.appendChild(revealSessionBtn);

		this.overviewContent.appendChild(titleRow);

		// Derive overview metrics from typed events
		const events = this.chatDebugService.getEvents(this.currentSessionId);
		this.renderDerivedOverview(events);
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
		viewLogsBtn.textContent = localize('chatDebug.viewLogs', "View Logs");
		viewLogsBtn.addEventListener('click', () => {
			this.showView(ViewState.Logs);
		});
		row.appendChild(viewLogsBtn);

		const viewSubagentBtn = document.createElement('button');
		viewSubagentBtn.className = 'chat-debug-overview-action-button';
		viewSubagentBtn.textContent = localize('chatDebug.viewSubagentChart', "Subagent Flow");
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

		// Breadcrumb: Debug View > Session Title > Logs
		this.breadcrumbContainer = document.createElement('div');
		this.breadcrumbContainer.className = 'chat-debug-breadcrumb';
		this.logsContainer.appendChild(this.breadcrumbContainer);

		// Header (search)
		this.headerContainer = document.createElement('div');
		this.headerContainer.className = 'chat-debug-editor-header';
		this.logsContainer.appendChild(this.headerContainer);

		this.searchInput = document.createElement('input');
		this.searchInput.className = 'chat-debug-search';
		this.searchInput.type = 'text';
		this.searchInput.placeholder = localize('chatDebug.search', "Search...");
		this._register(addDisposableListener(this.searchInput, EventType.INPUT, () => {
			this.filterText = this.searchInput!.value.toLowerCase();
			this.refreshList();
		}));
		this.headerContainer.appendChild(this.searchInput);

		this.kindSelect = document.createElement('select');
		this.kindSelect.className = 'chat-debug-filter-select';
		const kindOptions: { value: string; label: string }[] = [
			{ value: '', label: localize('chatDebug.filter.allKinds', "All Kinds") },
			{ value: 'toolCall', label: localize('chatDebug.filter.toolCall', "Tool Calls") },
			{ value: 'modelTurn', label: localize('chatDebug.filter.modelTurn', "Model Turns") },
			{ value: 'generic', label: localize('chatDebug.filter.generic', "Generic") },
			{ value: 'subagentInvocation', label: localize('chatDebug.filter.subagent', "Subagent Invocations") },
		];
		for (const opt of kindOptions) {
			const option = document.createElement('option');
			option.value = opt.value;
			option.textContent = opt.label;
			this.kindSelect.appendChild(option);
		}
		this._register(addDisposableListener(this.kindSelect, EventType.CHANGE, () => {
			this.filterKind = this.kindSelect!.value;
			this.refreshList();
		}));
		this.headerContainer.appendChild(this.kindSelect);

		this.levelSelect = document.createElement('select');
		this.levelSelect.className = 'chat-debug-filter-select';
		const levelOptions: { value: string; label: string }[] = [
			{ value: '', label: localize('chatDebug.filter.allLevels', "All Levels") },
			{ value: String(ChatDebugLogLevel.Trace), label: localize('chatDebug.filter.trace', "Trace") },
			{ value: String(ChatDebugLogLevel.Info), label: localize('chatDebug.filter.info', "Info") },
			{ value: String(ChatDebugLogLevel.Warning), label: localize('chatDebug.filter.warning', "Warning") },
			{ value: String(ChatDebugLogLevel.Error), label: localize('chatDebug.filter.error', "Error") },
		];
		for (const opt of levelOptions) {
			const option = document.createElement('option');
			option.value = opt.value;
			option.textContent = opt.label;
			this.levelSelect.appendChild(option);
		}
		this._register(addDisposableListener(this.levelSelect, EventType.CHANGE, () => {
			this.filterLevel = this.levelSelect!.value;
			this.refreshList();
		}));
		this.headerContainer.appendChild(this.levelSelect);

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
	}

	private updateLogsBreadcrumb(): void {
		if (!this.breadcrumbContainer) {
			return;
		}
		this.breadcrumbContainer.textContent = '';

		const homeLink = document.createElement('button');
		homeLink.className = 'chat-debug-breadcrumb-link';
		homeLink.textContent = localize('chatDebug.title', "Debug View");
		homeLink.addEventListener('click', () => {
			this.chatDebugService.activeSessionId = undefined;
			this.currentSessionId = '';
			this.showView(ViewState.Home);
		});
		this.breadcrumbContainer.appendChild(homeLink);

		const sep1 = document.createElement('span');
		sep1.className = 'chat-debug-breadcrumb-sep';
		sep1.textContent = '>';
		this.breadcrumbContainer.appendChild(sep1);

		const sessionUri = LocalChatSessionUri.forSession(this.currentSessionId);
		const sessionTitle = this.chatService.getSessionTitle(sessionUri) || this.currentSessionId;
		const sessionLink = document.createElement('button');
		sessionLink.className = 'chat-debug-breadcrumb-link';
		sessionLink.textContent = sessionTitle;
		sessionLink.addEventListener('click', () => {
			this.showView(ViewState.Overview);
		});
		this.breadcrumbContainer.appendChild(sessionLink);

		const sep2 = document.createElement('span');
		sep2.className = 'chat-debug-breadcrumb-sep';
		sep2.textContent = '>';
		this.breadcrumbContainer.appendChild(sep2);

		const logsLabel = document.createElement('span');
		logsLabel.className = 'chat-debug-breadcrumb-current';
		logsLabel.textContent = localize('chatDebug.logs', "Logs");
		this.breadcrumbContainer.appendChild(logsLabel);
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
		this.updateLogsBreadcrumb();
	}

	private refreshList(): void {
		if (!this.list) {
			return;
		}

		let filtered = this.events;

		// Filter by kind
		if (this.filterKind) {
			filtered = filtered.filter(e => e.kind === this.filterKind);
		}

		// Filter by minimum log level
		if (this.filterLevel) {
			const minLevel = Number(this.filterLevel) as ChatDebugLogLevel;
			filtered = filtered.filter(e => {
				if (e.kind === 'generic') {
					return e.level >= minLevel;
				}
				if (e.kind === 'toolCall' && minLevel > ChatDebugLogLevel.Info) {
					return e.result === 'error';
				}
				// modelTurn and subagentInvocation have no level; show unless filtering for warnings+
				return minLevel <= ChatDebugLogLevel.Info;
			});
		}

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

		this.list.splice(0, this.list.length, filtered);
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
		fullScreenButton.title = localize('chatDebug.openInEditor', "Open in Editor");
		fullScreenButton.setAttribute('aria-label', localize('chatDebug.openInEditor', "Open in Editor"));
		const fullScreenIcon = document.createElement('span');
		fullScreenIcon.className = ThemeIcon.asClassName(Codicon.goToFile);
		fullScreenButton.appendChild(fullScreenIcon);
		fullScreenButton.addEventListener('click', () => {
			this.editorService.openEditor({ contents: this.currentDetailText, resource: undefined } satisfies IUntitledTextResourceEditorInput);
		});
		header.appendChild(fullScreenButton);

		const copyButton = document.createElement('button');
		copyButton.className = 'chat-debug-detail-button';
		copyButton.title = localize('chatDebug.copyToClipboard', "Copy");
		copyButton.setAttribute('aria-label', localize('chatDebug.copyToClipboard', "Copy"));
		const copyIcon = document.createElement('span');
		copyIcon.className = ThemeIcon.asClassName(Codicon.copy);
		copyButton.appendChild(copyIcon);
		copyButton.addEventListener('click', () => {
			this.clipboardService.writeText(this.currentDetailText);
		});
		header.appendChild(copyButton);

		const closeButton = document.createElement('button');
		closeButton.className = 'chat-debug-detail-button';
		closeButton.title = localize('chatDebug.closeDetail', "Close");
		closeButton.setAttribute('aria-label', localize('chatDebug.closeDetail', "Close"));
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
		this.subagentChartBreadcrumb = document.createElement('div');
		this.subagentChartBreadcrumb.className = 'chat-debug-breadcrumb';
		this.subagentChartContainer.appendChild(this.subagentChartBreadcrumb);

		this.subagentChartContent = document.createElement('div');
		this.subagentChartContent.className = 'chat-debug-subagent-chart-content';
		this.subagentChartContainer.appendChild(this.subagentChartContent);
	}

	private updateSubagentChartBreadcrumb(): void {
		if (!this.subagentChartBreadcrumb) {
			return;
		}
		this.subagentChartBreadcrumb.textContent = '';

		const homeLink = document.createElement('button');
		homeLink.className = 'chat-debug-breadcrumb-link';
		homeLink.textContent = localize('chatDebug.title', "Debug View");
		homeLink.addEventListener('click', () => {
			this.chatDebugService.activeSessionId = undefined;
			this.currentSessionId = '';
			this.showView(ViewState.Home);
		});
		this.subagentChartBreadcrumb.appendChild(homeLink);

		const sep1 = document.createElement('span');
		sep1.className = 'chat-debug-breadcrumb-sep';
		sep1.textContent = '>';
		this.subagentChartBreadcrumb.appendChild(sep1);

		const sessionUri = LocalChatSessionUri.forSession(this.currentSessionId);
		const sessionTitle = this.chatService.getSessionTitle(sessionUri) || this.currentSessionId;
		const sessionLink = document.createElement('button');
		sessionLink.className = 'chat-debug-breadcrumb-link';
		sessionLink.textContent = sessionTitle;
		sessionLink.addEventListener('click', () => {
			this.showView(ViewState.Overview);
		});
		this.subagentChartBreadcrumb.appendChild(sessionLink);

		const sep2 = document.createElement('span');
		sep2.className = 'chat-debug-breadcrumb-sep';
		sep2.textContent = '>';
		this.subagentChartBreadcrumb.appendChild(sep2);

		const chartLabel = document.createElement('span');
		chartLabel.className = 'chat-debug-breadcrumb-current';
		chartLabel.textContent = localize('chatDebug.subagentFlow', "Subagent Flow");
		this.subagentChartBreadcrumb.appendChild(chartLabel);
	}

	private renderSubagentChart(): void {
		if (!this.subagentChartContent) {
			return;
		}
		this.subagentChartContent.textContent = '';
		this.updateSubagentChartBreadcrumb();

		const events = this.chatDebugService.getEvents(this.currentSessionId);
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

		// Mermaid code block
		const codeSection = document.createElement('div');
		codeSection.className = 'chat-debug-subagent-chart-code-section';

		const codeLabel = document.createElement('h4');
		codeLabel.className = 'chat-debug-subagent-chart-code-label';
		codeLabel.textContent = localize('chatDebug.mermaidSource', "Mermaid Source");
		codeSection.appendChild(codeLabel);

		const pre = document.createElement('pre');
		pre.className = 'chat-debug-subagent-chart-code';
		const code = document.createElement('code');
		code.textContent = mermaidCode;
		pre.appendChild(code);
		codeSection.appendChild(pre);

		this.subagentChartContent.appendChild(codeSection);
	}

	// =====================================================================
	// EditorPane overrides
	// =====================================================================

	override focus(): void {
		if (this.viewState === ViewState.Logs) {
			this.list?.domFocus();
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
		if (!this.currentDimension || !this.list || this.viewState !== ViewState.Logs) {
			return;
		}
		const breadcrumbHeight = this.breadcrumbContainer?.offsetHeight ?? 0;
		const headerHeight = this.headerContainer?.offsetHeight ?? 0;
		const tableHeaderHeight = this.tableHeader?.offsetHeight ?? 0;
		const detailVisible = this.detailContainer?.style.display !== 'none';
		const detailWidth = detailVisible ? (this.detailContainer?.offsetWidth ?? 0) : 0;
		const listHeight = this.currentDimension.height - breadcrumbHeight - headerHeight - tableHeaderHeight;
		const listWidth = this.currentDimension.width - detailWidth;
		this.list.layout(listHeight, listWidth);
	}

	override dispose(): void {
		this.eventListener?.dispose();
		super.dispose();
	}
}
