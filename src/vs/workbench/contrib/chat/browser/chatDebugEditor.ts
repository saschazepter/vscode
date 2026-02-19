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
import { ChatDebugLogLevel, IChatDebugLogEvent, IChatDebugService, IChatDebugSessionOverview, IChatDebugSessionOverviewAction } from '../common/chatDebugService.js';
import { IChatService } from '../common/chatService/chatService.js';
import { chatSessionResourceToId, LocalChatSessionUri } from '../common/model/chatUri.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { safeIntl } from '../../../../base/common/date.js';
import { IChatWidgetService } from './chat.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IUntitledTextResourceEditorInput } from '../../../common/editor.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

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

const enum ViewState {
	Home = 'home',
	Overview = 'overview',
	Logs = 'logs',
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

	// --- Logs view ---
	private logsContainer: HTMLElement | undefined;
	private list: WorkbenchList<IChatDebugLogEvent> | undefined;
	private headerContainer: HTMLElement | undefined;
	private detailContainer: HTMLElement | undefined;
	private searchInput: HTMLInputElement | undefined;
	private tableHeader: HTMLElement | undefined;
	private listContainer: HTMLElement | undefined;
	private breadcrumbContainer: HTMLElement | undefined;
	private events: IChatDebugLogEvent[] = [];
	private filterText: string = '';
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
		@ICommandService private readonly commandService: ICommandService,
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

		// When new debug events arrive, refresh the current view
		this._register(this.chatDebugService.onDidAddEvent(() => {
			if (this.viewState === ViewState.Home) {
				this.renderHomeContent();
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

		if (state === ViewState.Home) {
			this.renderHomeContent();
		} else if (state === ViewState.Overview) {
			this.loadOverview();
		} else if (state === ViewState.Logs) {
			this.loadEventsForSession(this.currentSessionId);
			this.refreshList();
			this.doLayout();
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
				titleSpan.textContent = sessionTitle;
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
			empty.textContent = localize('chatDebug.noSessions', "No sessions with debug data");
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

		// Breadcrumb: Debug View
		const breadcrumb = document.createElement('div');
		breadcrumb.className = 'chat-debug-breadcrumb';
		const homeLink = document.createElement('button');
		homeLink.className = 'chat-debug-breadcrumb-link';
		homeLink.textContent = localize('chatDebug.title', "Debug View");
		homeLink.addEventListener('click', () => {
			this.chatDebugService.activeSessionId = undefined;
			this.currentSessionId = '';
			this.showView(ViewState.Home);
		});
		breadcrumb.appendChild(homeLink);
		this.overviewContainer.appendChild(breadcrumb);

		this.overviewContent = document.createElement('div');
		this.overviewContent.className = 'chat-debug-overview-content';
		this.overviewContainer.appendChild(this.overviewContent);
	}

	private async loadOverview(): Promise<void> {
		if (!this.overviewContent) {
			return;
		}
		this.overviewContent.textContent = '';

		// Session title from chat service
		const sessionUri = LocalChatSessionUri.forSession(this.currentSessionId);
		const sessionTitle = this.chatService.getSessionTitle(sessionUri) || this.currentSessionId;

		const titleEl = document.createElement('h2');
		titleEl.className = 'chat-debug-overview-title';
		titleEl.textContent = sessionTitle;
		this.overviewContent.appendChild(titleEl);

		// Fetch overview data from providers
		const overview = await this.chatDebugService.getOverview(this.currentSessionId);
		this.renderOverviewData(overview);
	}

	private renderOverviewData(overview: IChatDebugSessionOverview | undefined): void {
		if (!this.overviewContent) {
			return;
		}

		// Metrics cards
		if (overview?.metrics && overview.metrics.length > 0) {
			const metricsSection = document.createElement('div');
			metricsSection.className = 'chat-debug-overview-section';

			const metricsLabel = document.createElement('h3');
			metricsLabel.className = 'chat-debug-overview-section-label';
			metricsLabel.textContent = localize('chatDebug.sessionAtAGlance', "Session at a Glance");
			metricsSection.appendChild(metricsLabel);

			const metricsRow = document.createElement('div');
			metricsRow.className = 'chat-debug-overview-metrics';
			for (const metric of overview.metrics) {
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

		// Built-in "View Logs" action + provider actions
		const builtinGroup = localize('chatDebug.exploreTraceData', "Explore Trace Data");
		const viewLogsAction: IChatDebugSessionOverviewAction = { group: builtinGroup, label: localize('chatDebug.viewLogs', "View Logs") };
		const allActions: IChatDebugSessionOverviewAction[] = [viewLogsAction, ...(overview?.actions ?? [])];

		// Group actions by group name
		const groupedActions = new Map<string, typeof allActions>();
		for (const action of allActions) {
			const list = groupedActions.get(action.group) ?? [];
			list.push(action);
			groupedActions.set(action.group, list);
		}

		for (const [groupName, actions] of groupedActions) {
			const section = document.createElement('div');
			section.className = 'chat-debug-overview-section';

			const sectionLabel = document.createElement('h3');
			sectionLabel.className = 'chat-debug-overview-section-label';
			sectionLabel.textContent = groupName;
			section.appendChild(sectionLabel);

			const row = document.createElement('div');
			row.className = 'chat-debug-overview-actions';
			for (const action of actions) {
				const btn = document.createElement('button');
				btn.className = 'chat-debug-overview-action-button';
				btn.textContent = action.label;

				if (action === viewLogsAction) {
					btn.classList.add('chat-debug-overview-action-button-primary');
					btn.addEventListener('click', () => {
						this.showView(ViewState.Logs);
					});
				} else if (action.commandId) {
					const commandId = action.commandId;
					const commandArgs = action.commandArgs;
					btn.addEventListener('click', () => {
						this.commandService.executeCommand(commandId, ...(commandArgs ?? []));
					});
				}
				row.appendChild(btn);
			}
			section.appendChild(row);
			this.overviewContent.appendChild(section);
		}
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
		this.logsContainer.appendChild(this.tableHeader);

		// List container
		this.listContainer = document.createElement('div');
		this.listContainer.className = 'chat-debug-list-container';
		this.logsContainer.appendChild(this.listContainer);

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

		// Detail panel (shown below list when an event is selected)
		this.detailContainer = document.createElement('div');
		this.detailContainer.className = 'chat-debug-detail-panel';
		this.detailContainer.style.display = 'none';
		this.logsContainer.appendChild(this.detailContainer);

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

			const sessionId = this.chatDebugService.activeSessionId;
			if (hint === 'logs' && sessionId) {
				this.currentSessionId = sessionId;
				this.showView(ViewState.Logs);
			} else if (hint === 'overview' && sessionId) {
				this.currentSessionId = sessionId;
				this.showView(ViewState.Overview);
			} else if (sessionId && !hint) {
				this.currentSessionId = sessionId;
				this.showView(ViewState.Overview);
			} else {
				this.showView(ViewState.Home);
			}
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
		const detailHeight = this.detailContainer?.style.display !== 'none' ? (this.detailContainer?.offsetHeight ?? 0) : 0;
		this.list.layout(this.currentDimension.height - breadcrumbHeight - headerHeight - tableHeaderHeight - detailHeight, this.currentDimension.width);
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
.chat-debug-home-session-badge {
	flex-shrink: 0;
	padding: 2px 8px;
	border-radius: 10px;
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
	font-size: 11px;
	font-weight: 500;
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
.chat-debug-overview-title {
	font-size: 16px;
	font-weight: 600;
	margin: 0 0 20px;
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
`;
