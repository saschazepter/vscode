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
import { ChatDebugLogLevel, IChatDebugEvent, IChatDebugService } from '../common/chatDebugService.js';
import { IChatService } from '../common/chatService/chatService.js';
import { chatSessionResourceToId, LocalChatSessionUri } from '../common/model/chatUri.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { safeIntl } from '../../../../base/common/date.js';
import { IChatWidgetService } from './chat.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IUntitledTextResourceEditorInput } from '../../../common/editor.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { isUUID } from '../../../../base/common/uuid.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';

interface IChatDebugEventTemplate {
	readonly container: HTMLElement;
	readonly created: HTMLElement;
	readonly name: HTMLElement;
	readonly details: HTMLElement;
}

class ChatDebugEventRenderer implements IListRenderer<IChatDebugEvent, IChatDebugEventTemplate> {
	static readonly TEMPLATE_ID = 'chatDebugEvent';

	get templateId(): string {
		return ChatDebugEventRenderer.TEMPLATE_ID;
	}

	renderTemplate(container: HTMLElement): IChatDebugEventTemplate {
		container.classList.add('chat-debug-log-row');

		const created = document.createElement('span');
		created.className = 'chat-debug-log-created';
		const name = document.createElement('span');
		name.className = 'chat-debug-log-name';
		const details = document.createElement('span');
		details.className = 'chat-debug-log-details';

		container.appendChild(created);
		container.appendChild(name);
		container.appendChild(details);

		return { container, created, name, details };
	}

	renderElement(element: IChatDebugEvent, index: number, templateData: IChatDebugEventTemplate): void {
		const dateFormatter = safeIntl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			second: '2-digit',
		});

		templateData.created.textContent = dateFormatter.value.format(element.created);

		switch (element.kind) {
			case 'toolCall':
				templateData.name.textContent = element.toolName;
				templateData.details.textContent = element.result ?? '';
				break;
			case 'modelTurn':
				templateData.name.textContent = element.model ?? localize('chatDebug.modelTurn', "Model Turn");
				templateData.details.textContent = element.totalTokens !== undefined
					? localize('chatDebug.tokens', "{0} tokens", element.totalTokens)
					: '';
				break;
			case 'generic':
				templateData.name.textContent = element.name;
				templateData.details.textContent = element.details ?? '';
				break;
			case 'subagentInvocation':
				templateData.name.textContent = element.agentName;
				templateData.details.textContent = element.description ?? (element.status ?? '');
				break;
		}

		// Tree indentation for child events
		if (element.parentEventId) {
			templateData.container.classList.add('chat-debug-log-child');
		} else {
			templateData.container.classList.remove('chat-debug-log-child');
		}

		const isError = element.kind === 'generic' && element.level === ChatDebugLogLevel.Error
			|| element.kind === 'toolCall' && element.result === 'error';
		const isWarning = element.kind === 'generic' && element.level === ChatDebugLogLevel.Warning;
		const isTrace = element.kind === 'generic' && element.level === ChatDebugLogLevel.Trace;

		templateData.container.classList.toggle('chat-debug-log-error', isError);
		templateData.container.classList.toggle('chat-debug-log-warning', isWarning);
		templateData.container.classList.toggle('chat-debug-log-trace', isTrace);
	}

	disposeTemplate(_templateData: IChatDebugEventTemplate): void {
		// noop
	}
}

class ChatDebugEventDelegate implements IListVirtualDelegate<IChatDebugEvent> {
	getHeight(_element: IChatDebugEvent): number {
		return 28;
	}

	getTemplateId(_element: IChatDebugEvent): string {
		return ChatDebugEventRenderer.TEMPLATE_ID;
	}
}

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
		const mermaidCode = this._generateSubagentFlowchart(events);

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
		this._renderVisualFlow(flowContainer, events);
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

	/**
	 * Derive subagent info from events:
	 * - Explicit `subagentInvocation` events
	 * - `toolCall` events where toolName is 'runSubagent'
	 * - `toolCall` events that have a parentEventId matching a subagent
	 */
	private _deriveSubagentData(events: readonly IChatDebugEvent[]): { name: string; description?: string; status?: string; toolCalls: number; modelTurns: number; durationMs?: number; childEvents: readonly IChatDebugEvent[] }[] {
		const subagents: Map<string, { name: string; description?: string; status?: string; toolCalls: number; modelTurns: number; durationMs?: number; childEvents: IChatDebugEvent[] }> = new Map();

		// Collect from explicit subagentInvocation events
		for (const event of events) {
			if (event.kind === 'subagentInvocation') {
				const key = event.id ?? event.agentName;
				subagents.set(key, {
					name: event.agentName,
					description: event.description,
					status: event.status,
					toolCalls: event.toolCallCount ?? 0,
					modelTurns: event.modelTurnCount ?? 0,
					durationMs: event.durationInMillis,
					childEvents: [],
				});
			}
		}

		// Collect from runSubagent tool calls
		for (const event of events) {
			if (event.kind === 'toolCall' && event.toolName === 'runSubagent') {
				const key = event.id ?? `runSubagent-${event.created.getTime()}`;
				if (!subagents.has(key)) {
					// Try to extract agent name from input JSON
					let agentName = 'Subagent';
					let description: string | undefined;
					if (event.input) {
						try {
							const parsed: { agentName?: string; description?: string } = JSON.parse(event.input);
							agentName = parsed.agentName ?? 'Subagent';
							description = parsed.description;
						} catch {
							// best effort
						}
					}
					subagents.set(key, {
						name: agentName,
						description,
						status: event.result,
						toolCalls: 0,
						modelTurns: 0,
						durationMs: event.durationInMillis,
						childEvents: [],
					});
				}
			}
		}

		// Infer subagents from orphaned parentEventId references
		const eventsById = new Map<string, IChatDebugEvent>();
		for (const event of events) {
			if (event.id) {
				eventsById.set(event.id, event);
			}
		}
		for (const event of events) {
			if (event.parentEventId && !subagents.has(event.parentEventId)) {
				const parentEvent = eventsById.get(event.parentEventId);
				const name = parentEvent?.kind === 'generic' ? (parentEvent.name || 'Subagent') : 'Subagent';
				const description = parentEvent?.kind === 'generic' ? parentEvent.details : undefined;
				subagents.set(event.parentEventId, {
					name,
					description,
					status: undefined,
					toolCalls: 0,
					modelTurns: 0,
					durationMs: undefined,
					childEvents: [],
				});
			}
		}

		// Attach child events (by parentEventId)
		for (const event of events) {
			if (event.parentEventId && subagents.has(event.parentEventId)) {
				const sub = subagents.get(event.parentEventId)!;
				sub.childEvents.push(event);
				if (event.kind === 'toolCall') {
					sub.toolCalls++;
				} else if (event.kind === 'modelTurn') {
					sub.modelTurns++;
				}
			}
		}

		return [...subagents.values()];
	}

	/**
	 * Generate a Mermaid flowchart from events, showing main agent flow
	 * with subagent invocations as subgraphs.
	 */
	private _generateSubagentFlowchart(events: readonly IChatDebugEvent[]): string {
		const subagents = this._deriveSubagentData(events);
		const modelTurns = events.filter(e => e.kind === 'modelTurn');
		const mainToolCalls = events.filter(e => e.kind === 'toolCall' && e.toolName !== 'runSubagent' && !e.parentEventId);

		const lines: string[] = [];
		lines.push('flowchart TD');

		// Start node
		lines.push('    start([Start]) --> mainAgent');
		lines.push(`    mainAgent["Main Agent<br/>${modelTurns.length} model turns<br/>${mainToolCalls.length} tool calls"]`);

		if (subagents.length === 0) {
			lines.push('    mainAgent --> finish([End])');
		} else {
			// Connect main agent to each subagent
			for (let i = 0; i < subagents.length; i++) {
				const sub = subagents[i];
				const nodeId = `sub${i}`;
				const statusIcon = sub.status === 'failed' ? '&#10060;' : sub.status === 'completed' ? '&#9989;' : '&#9654;';

				lines.push('');
				lines.push(`    mainAgent --> ${nodeId}`);
				lines.push(`    subgraph ${nodeId}_group["${sub.name}"]`);
				lines.push(`        ${nodeId}["${statusIcon} ${sub.name}<br/>${sub.description ? sub.description.substring(0, 50) + '<br/>' : ''}${sub.modelTurns} model turns, ${sub.toolCalls} tool calls${sub.durationMs !== undefined ? '<br/>' + sub.durationMs + 'ms' : ''}"]`);

				// Show top tool calls for this subagent
				const childTools = sub.childEvents.filter(e => e.kind === 'toolCall');
				const toolNames = new Map<string, number>();
				for (const tc of childTools) {
					if (tc.kind === 'toolCall') {
						toolNames.set(tc.toolName, (toolNames.get(tc.toolName) ?? 0) + 1);
					}
				}
				if (toolNames.size > 0) {
					const toolSummary = [...toolNames.entries()]
						.sort((a, b) => b[1] - a[1])
						.slice(0, 5)
						.map(([name, count]) => `${name} x${count}`)
						.join('<br/>');
					lines.push(`        ${nodeId}_tools["Tools:<br/>${toolSummary}"]`);
					lines.push(`        ${nodeId} --> ${nodeId}_tools`);
				}

				lines.push('    end');
				lines.push(`    ${nodeId}_group --> mainAgent_return${i}(["Return to Main Agent"])`);
			}

			// Final node
			const lastIdx = subagents.length - 1;
			lines.push(`    mainAgent_return${lastIdx} --> finish([End])`);

			// Connect intermediate returns
			for (let i = 0; i < lastIdx; i++) {
				lines.push(`    mainAgent_return${i} --> mainAgent`);
			}
		}

		// Styling
		lines.push('');
		lines.push('    classDef mainNode fill:#4a9eff,stroke:#2b7de9,color:#fff');
		lines.push('    classDef subNode fill:#9c27b0,stroke:#7b1fa2,color:#fff');
		lines.push('    classDef toolNode fill:#455a64,stroke:#37474f,color:#cfd8dc');
		lines.push('    classDef returnNode fill:#66bb6a,stroke:#43a047,color:#fff');
		lines.push('    class mainAgent mainNode');

		for (let i = 0; i < subagents.length; i++) {
			lines.push(`    class sub${i} subNode`);
			lines.push(`    class sub${i}_tools toolNode`);
			lines.push(`    class mainAgent_return${i} returnNode`);
		}

		return lines.join('\n');
	}

	/**
	 * Render a simple visual HTML/CSS flow representation of the subagent invocations.
	 */
	private _renderVisualFlow(container: HTMLElement, events: readonly IChatDebugEvent[]): void {
		const subagents = this._deriveSubagentData(events);

		if (subagents.length === 0) {
			const empty = document.createElement('p');
			empty.className = 'chat-debug-subagent-flow-empty';
			empty.textContent = localize('chatDebug.noSubagents', "No subagent invocations detected in this session.");
			container.appendChild(empty);
			return;
		}

		// Main agent node
		const mainNode = document.createElement('div');
		mainNode.className = 'chat-debug-flow-node chat-debug-flow-main';
		mainNode.textContent = localize('chatDebug.mainAgent', "Main Agent");
		container.appendChild(mainNode);

		for (const sub of subagents) {
			// Arrow
			const arrow = document.createElement('div');
			arrow.className = 'chat-debug-flow-arrow';
			arrow.textContent = '\u2193'; // ↓
			container.appendChild(arrow);

			// Subagent node
			const subNode = document.createElement('div');
			subNode.className = 'chat-debug-flow-node chat-debug-flow-subagent';

			const nameEl = document.createElement('div');
			nameEl.className = 'chat-debug-flow-subagent-name';
			const statusIcon = sub.status === 'failed' ? '\u274C' : sub.status === 'completed' ? '\u2705' : '\u25B6';
			nameEl.textContent = `${statusIcon} ${sub.name}`;
			subNode.appendChild(nameEl);

			if (sub.description) {
				const descEl = document.createElement('div');
				descEl.className = 'chat-debug-flow-subagent-desc';
				descEl.textContent = sub.description.length > 60 ? sub.description.substring(0, 60) + '...' : sub.description;
				subNode.appendChild(descEl);
			}

			const statsEl = document.createElement('div');
			statsEl.className = 'chat-debug-flow-subagent-stats';
			const parts: string[] = [];
			if (sub.modelTurns > 0) {
				parts.push(localize('chatDebug.flowModelTurns', "{0} model turns", sub.modelTurns));
			}
			if (sub.toolCalls > 0) {
				parts.push(localize('chatDebug.flowToolCalls', "{0} tool calls", sub.toolCalls));
			}
			if (sub.durationMs !== undefined) {
				parts.push(`${sub.durationMs}ms`);
			}
			statsEl.textContent = parts.join(' \u00B7 ');
			subNode.appendChild(statsEl);

			container.appendChild(subNode);

			// Return arrow
			const returnArrow = document.createElement('div');
			returnArrow.className = 'chat-debug-flow-arrow chat-debug-flow-arrow-return';
			returnArrow.textContent = '\u2193'; // ↓
			container.appendChild(returnArrow);
		}

		// End node
		const endNode = document.createElement('div');
		endNode.className = 'chat-debug-flow-node chat-debug-flow-end';
		endNode.textContent = localize('chatDebug.end', "End");
		container.appendChild(endNode);
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

const chatDebugStyles = `
.chat-debug-editor {
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

/* ---- Home view ---- */
.chat-debug-home {
	display: flex;
	flex-direction: column;
	align-items: center;
	padding: 48px 24px;
	overflow-y: auto;
	flex: 1;
}
.chat-debug-home-title {
	font-size: 18px;
	font-weight: 600;
	margin: 0 0 8px;
}
.chat-debug-home-subtitle {
	font-size: 13px;
	color: var(--vscode-descriptionForeground);
	margin: 0 0 24px;
}
.chat-debug-home-empty {
	font-size: 13px;
	color: var(--vscode-descriptionForeground);
	margin: 0;
}
.chat-debug-home-session-list {
	display: flex;
	flex-direction: column;
	gap: 4px;
	width: 100%;
	max-width: 400px;
}
.chat-debug-home-session-item {
	display: flex;
	align-items: center;
	width: 100%;
	text-align: left;
	padding: 8px 12px;
	border: 1px solid var(--vscode-widget-border, transparent);
	background: transparent;
	color: var(--vscode-foreground);
	border-radius: 4px;
	cursor: pointer;
	font-size: 13px;
	gap: 8px;
}
.chat-debug-home-session-item:hover {
	background: var(--vscode-list-hoverBackground);
}
.chat-debug-home-session-item-active {
	border-color: var(--vscode-focusBorder);
}
.chat-debug-home-session-item-title {
	flex: 1;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.chat-debug-home-session-item-shimmer {
	height: 14px;
	min-width: 160px;
	border-radius: 3px;
	background: linear-gradient(
		90deg,
		var(--vscode-descriptionForeground) 25%,
		var(--vscode-chat-thinkingShimmer, rgba(255, 255, 255, 0.3)) 50%,
		var(--vscode-descriptionForeground) 75%
	);
	background-size: 200% 100%;
	animation: chat-debug-shimmer 2s linear infinite;
	opacity: 0.15;
}
.chat-debug-home-session-badge {
	flex-shrink: 0;
	padding: 2px 8px;
	border-radius: 10px;
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
	font-size: 11px;
	font-weight: 500;
}

@keyframes chat-debug-shimmer {
	0% { background-position: 120% 0; }
	100% { background-position: -120% 0; }
}

/* ---- Breadcrumb ---- */
.chat-debug-breadcrumb {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 8px 16px;
	font-size: 12px;
	flex-shrink: 0;
	border-bottom: 1px solid var(--vscode-widget-border, transparent);
}
.chat-debug-breadcrumb-link {
	border: none;
	background: transparent;
	color: var(--vscode-textLink-foreground);
	cursor: pointer;
	font-size: 12px;
	padding: 0;
	text-decoration: none;
}
.chat-debug-breadcrumb-link:hover {
	text-decoration: underline;
}
.chat-debug-breadcrumb-sep {
	color: var(--vscode-descriptionForeground);
}
.chat-debug-breadcrumb-current {
	color: var(--vscode-foreground);
}

/* ---- Overview view ---- */
.chat-debug-overview {
	display: flex;
	flex-direction: column;
	overflow-y: auto;
	flex: 1;
}
.chat-debug-overview-content {
	padding: 16px 24px;
}
.chat-debug-overview-title-row {
	display: flex;
	align-items: center;
	gap: 12px;
	margin-bottom: 20px;
}
.chat-debug-overview-title {
	font-size: 16px;
	font-weight: 600;
	margin: 0;
}
.chat-debug-overview-section {
	margin-bottom: 24px;
}
.chat-debug-overview-section-label {
	font-size: 13px;
	font-weight: 600;
	margin: 0 0 10px;
	color: var(--vscode-foreground);
}
.chat-debug-overview-metrics {
	display: flex;
	gap: 12px;
	flex-wrap: wrap;
}
.chat-debug-overview-metric-card {
	border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
	border-radius: 4px;
	padding: 12px 16px;
	min-width: 120px;
}
.chat-debug-overview-metric-label {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	margin-bottom: 4px;
}
.chat-debug-overview-metric-value {
	font-size: 16px;
	font-weight: 600;
}
.chat-debug-overview-actions {
	display: flex;
	gap: 10px;
	flex-wrap: wrap;
}
.chat-debug-overview-action-button {
	padding: 8px 16px;
	border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
	background: var(--vscode-button-secondaryBackground);
	color: var(--vscode-button-secondaryForeground);
	border-radius: 2px;
	cursor: pointer;
	font-size: 13px;
}
.chat-debug-overview-action-button:hover {
	background: var(--vscode-button-secondaryHoverBackground);
}
.chat-debug-icon-button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 26px;
	height: 26px;
	border: none;
	background: transparent;
	color: var(--vscode-foreground);
	border-radius: 4px;
	cursor: pointer;
	opacity: 0.7;
	flex-shrink: 0;
}
.chat-debug-icon-button:hover {
	opacity: 1;
	background: var(--vscode-toolbar-hoverBackground);
}
.chat-debug-overview-action-button-primary {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
}
.chat-debug-overview-action-button-primary:hover {
	background: var(--vscode-button-hoverBackground);
}

/* ---- Logs view ---- */
.chat-debug-logs {
	display: flex;
	flex-direction: column;
	overflow: hidden;
	flex: 1;
}
.chat-debug-editor-header {
	display: flex;
	align-items: center;
	padding: 8px 16px;
	gap: 12px;
	flex-shrink: 0;
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
.chat-debug-filter-select {
	padding: 4px 8px;
	border: 1px solid var(--vscode-input-border, transparent);
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border-radius: 2px;
	outline: none;
	font-size: 12px;
}
.chat-debug-filter-select:focus {
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
.chat-debug-table-header .chat-debug-col-details {
	flex: 1;
}
.chat-debug-logs-body {
	display: flex;
	flex-direction: row;
	flex: 1;
	overflow: hidden;
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
	width: 350px;
	overflow-y: auto;
	padding: 8px 16px;
	border-left: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
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
	user-select: text;
	-webkit-user-select: text;
	cursor: text;
}

/* ---- Subagent Chart view ---- */
.chat-debug-subagent-chart {
	display: flex;
	flex-direction: column;
	overflow-y: auto;
	flex: 1;
}
.chat-debug-subagent-chart-content {
	padding: 16px 24px;
}
.chat-debug-subagent-chart-title {
	font-size: 14px;
	font-weight: 600;
	margin: 0 0 6px;
}
.chat-debug-subagent-chart-desc {
	font-size: 12px;
	color: var(--vscode-descriptionForeground);
	margin: 0 0 16px;
}
.chat-debug-subagent-chart-actions {
	display: flex;
	gap: 8px;
	margin-bottom: 20px;
}
.chat-debug-subagent-flow-visual {
	display: flex;
	flex-direction: column;
	align-items: center;
	padding: 16px 0;
	margin-bottom: 24px;
}
.chat-debug-flow-node {
	padding: 10px 20px;
	border-radius: 6px;
	font-size: 13px;
	font-weight: 500;
	text-align: center;
	min-width: 180px;
	max-width: 360px;
}
.chat-debug-flow-main {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
}
.chat-debug-flow-subagent {
	background: var(--vscode-editorWidget-background);
	border: 2px solid var(--vscode-focusBorder);
	color: var(--vscode-foreground);
}
.chat-debug-flow-subagent-name {
	font-weight: 600;
	margin-bottom: 4px;
}
.chat-debug-flow-subagent-desc {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	margin-bottom: 4px;
}
.chat-debug-flow-subagent-stats {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
}
.chat-debug-flow-end {
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
}
.chat-debug-flow-arrow {
	font-size: 20px;
	line-height: 1;
	padding: 4px 0;
	color: var(--vscode-foreground);
	opacity: 0.5;
}
.chat-debug-flow-arrow-return {
	opacity: 0.3;
}
.chat-debug-subagent-flow-empty {
	font-size: 13px;
	color: var(--vscode-descriptionForeground);
	text-align: center;
	padding: 32px 0;
}
.chat-debug-subagent-chart-code-section {
	border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
	padding-top: 16px;
}
.chat-debug-subagent-chart-code-label {
	font-size: 13px;
	font-weight: 600;
	margin: 0 0 8px;
}
.chat-debug-subagent-chart-code {
	background: var(--vscode-textCodeBlock-background);
	border: 1px solid var(--vscode-widget-border, transparent);
	border-radius: 4px;
	padding: 12px;
	margin: 0;
	overflow-x: auto;
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 12px;
	white-space: pre;
	user-select: text;
	-webkit-user-select: text;
	cursor: text;
}
`;
