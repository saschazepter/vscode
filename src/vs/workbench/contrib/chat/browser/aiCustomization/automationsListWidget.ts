/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationManagement.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { fromNow, getDurationString } from '../../../../../base/common/date.js';
import * as resources from '../../../../../base/common/resources.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { IAutomation, IAutomationRun, AutomationRunStatus, AutomationRunTrigger } from '../../common/automations/automation.js';
import { IAutomationRunner } from '../../common/automations/automationRunner.js';
import { IAutomationService } from '../../common/automations/automationService.js';
import { IAutomationDialogService } from '../../common/automations/automationDialogService.js';
import { CHAT_AUTOMATIONS_ENABLED_SETTING } from '../../common/automations/automationsEnabled.js';
import { DAYS_OF_WEEK } from '../../common/automations/schedule.js';
import { IAgentSessionsService } from '../agentSessions/agentSessionsService.js';
import { openSession as openSessionFromOpener } from '../agentSessions/agentSessionsOpener.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';

const $ = DOM.$;

const MAX_VISIBLE_RUNS = 20;

interface IAutomationItemEntry {
	readonly type: 'automation-item';
	readonly automation: IAutomation;
	readonly runs: readonly IAutomationRun[];
	readonly expanded: boolean;
	readonly inFlight: boolean;
}

export type IAutomationListEntry = IAutomationItemEntry;

/**
 * Widget that renders the Automations section of the AI Customization editor.
 */
export class AutomationsListWidget extends Disposable {

	readonly element: HTMLElement;

	private readonly _onDidChangeItemCount = this._register(new Emitter<number>());
	readonly onDidChangeItemCount = this._onDidChangeItemCount.event;

	private readonly headerEl: HTMLElement;
	private readonly scrollableNode: HTMLElement;
	private readonly listContainer: HTMLElement;
	private readonly cardsGrid: HTMLElement;
	private readonly emptyContainer: HTMLElement;
	private readonly scrollable: DomScrollableElement;

	private readonly newButtonHover = this._register(new MutableDisposable());
	private readonly newEmptyStateButtonHover = this._register(new MutableDisposable());
	private readonly _emptyStateStore = this._register(new DisposableStore());
	private readonly _cardsStore = this._register(new DisposableStore());

	private readonly runInFlight = new Set<string>();
	private readonly expandedRows = new Set<string>();
	private displayEntries: IAutomationListEntry[] = [];

	private lastHeight = 0;
	private lastWidth = 0;
	private _layoutDeferred = false;
	private readonly _layoutRAF = this._register(new MutableDisposable());

	constructor(
		@IAutomationService private readonly automationService: IAutomationService,
		@IAutomationRunner private readonly automationRunner: IAutomationRunner,
		@IDialogService private readonly dialogService: IDialogService,
		@IAutomationDialogService private readonly automationDialogService: IAutomationDialogService,
		@IHoverService private readonly hoverService: IHoverService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
	) {
		super();

		this.element = $('.automations-list-widget');
		this.headerEl = DOM.append(this.element, $('.automations-header'));
		this.emptyContainer = DOM.append(this.element, $('.automations-empty-state'));
		this.emptyContainer.style.display = 'none';
		this.listContainer = $('.automations-list');
		this.listContainer.setAttribute('role', 'list');
		this.listContainer.setAttribute('aria-label', localize('automationsListAriaLabel', "Automations"));
		this.scrollable = this._register(new DomScrollableElement(this.listContainer, {
			horizontal: ScrollbarVisibility.Hidden,
			vertical: ScrollbarVisibility.Auto,
			useShadows: false,
		}));
		this.scrollableNode = this.scrollable.getDomNode();
		this.scrollableNode.classList.add('automations-list-scrollable');
		this.cardsGrid = DOM.append(this.listContainer, $('.automations-cards-grid'));
		this.element.appendChild(this.scrollableNode);

		this.renderHeader();
		const resizeObserver = this._register(new DOM.DisposableResizeObserver('AutomationsListWidget.scrollable', () => this.scrollable.scanDomNode()));
		this._register(resizeObserver.observe(this.scrollableNode));

		this._register(autorun(reader => {
			const items = this.automationService.automations.read(reader);
			this.automationService.runs.read(reader);
			this.updateList(items);
			this._onDidChangeItemCount.fire(items.length);
		}));
	}

	private renderHeader(): void {
		const titleRow = DOM.append(this.headerEl, $('.automations-header-row'));
		const titleEl = DOM.append(titleRow, $('h2.automations-header-title'));
		titleEl.textContent = localize('automationsHeaderTitle', "Automations");
		const subtitleEl = DOM.append(this.headerEl, $('p.automations-header-subtitle'));
		subtitleEl.textContent = localize('automationsHeaderSubtitle', "Schedule agent sessions to run on a cadence you choose.");

		const newButton = this._register(new Button(titleRow, { ...defaultButtonStyles, title: localize('newAutomation', "New automation") }));
		newButton.label = localize('newAutomation', "New automation");
		newButton.element.classList.add('automations-new-button');
		this._register(newButton.onDidClick(() => this.openCreateDialog()));
		this.newButtonHover.value = this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), newButton.element, localize('newAutomationTooltip', "Create a new automation"));
	}

	private updateList(items: readonly IAutomation[]): void {
		if (items.length === 0) {
			this.element.classList.add('automations-empty');
			this.emptyContainer.style.display = '';
			this.scrollableNode.style.display = 'none';
			this.renderEmptyState();
			this.displayEntries = [];
			this._cardsStore.clear();
			DOM.clearNode(this.cardsGrid);
			this.scrollable.scanDomNode();
			return;
		}

		this.element.classList.remove('automations-empty');
		this.emptyContainer.style.display = 'none';
		this.scrollableNode.style.display = '';
		this.newEmptyStateButtonHover.clear();

		this.displayEntries = items.map(automation => ({
			type: 'automation-item' as const,
			automation,
			runs: this.automationService.runsFor(automation.id).get(),
			expanded: this.expandedRows.has(automation.id),
			inFlight: this.runInFlight.has(automation.id),
		}));

		this.renderCards();
	}

	private renderEmptyState(): void {
		this._emptyStateStore.clear();
		DOM.clearNode(this.emptyContainer);
		this.emptyContainer.setAttribute('role', 'status');
		const title = DOM.append(this.emptyContainer, $('h3.automations-empty-title'));
		title.textContent = localize('automationsEmptyTitle', "No automations yet");
		const message = DOM.append(this.emptyContainer, $('p.automations-empty-message'));
		message.textContent = localize('automationsEmptyMessage', "Create an automation to schedule an agent session to run on a cadence you choose.");

		const ctaButton = this._emptyStateStore.add(new Button(this.emptyContainer, { ...defaultButtonStyles }));
		ctaButton.label = localize('automationsEmptyCta', "Create automation");
		ctaButton.element.classList.add('automations-empty-cta');
		this._emptyStateStore.add(ctaButton.onDidClick(() => this.openCreateDialog()));
		this.newEmptyStateButtonHover.value = this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), ctaButton.element, localize('newAutomationTooltip', "Create a new automation"));
	}

	private renderCards(): void {
		this._cardsStore.clear();
		DOM.clearNode(this.cardsGrid);
		for (const entry of this.displayEntries) {
			this.renderCard(entry, this._cardsStore);
		}
		this.scrollable.scanDomNode();
	}

	private renderCard(entry: IAutomationListEntry, disposables: DisposableStore): void {
		const { automation, expanded, inFlight, runs } = entry;
		const wrapper = DOM.append(this.cardsGrid, $('.automations-card-wrapper'));
		wrapper.setAttribute('role', 'listitem');
		wrapper.classList.toggle('automations-card-wrapper-expanded', expanded);

		const card = DOM.append(wrapper, $('.automations-card')) as HTMLDivElement;
		card.classList.toggle('automations-card-disabled', !automation.enabled);
		card.classList.toggle('automations-card-expanded', expanded);
		card.tabIndex = 0;
		card.title = `${formatSchedule(automation)}\n${formatNextRun(automation)}`;
		card.setAttribute('aria-label', automation.enabled
			? localize('automationAriaLabel', "{0}, {1}", automation.name, formatSchedule(automation))
			: localize('automationAriaLabelDisabled', "{0}, disabled", automation.name));

		const historyPanel = DOM.append(wrapper, $('.automations-row-history'));
		historyPanel.id = `automation-history-${automation.id}`;
		card.setAttribute('aria-expanded', expanded ? 'true' : 'false');
		card.setAttribute('aria-controls', historyPanel.id);

		disposables.add(DOM.addDisposableListener(card, 'click', () => {
			this.toggleExpanded(automation.id);
		}));
		disposables.add(DOM.addDisposableListener(card, 'keydown', (e: KeyboardEvent) => {
			if (e.target !== card) {
				return;
			}
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.toggleExpanded(automation.id);
			}
		}));

		const header = DOM.append(card, $('.automations-card-header'));
		const title = DOM.append(header, $('h3.automations-card-title'));
		title.textContent = automation.name;
		const badge = DOM.append(header, $('span.automations-card-badge'));
		badge.textContent = automation.enabled
			? localize('automationEnabledBadge', "Enabled")
			: localize('automationDisabled', "Disabled");
		badge.classList.add(automation.enabled ? 'enabled' : 'disabled');

		const body = DOM.append(card, $('.automations-card-body'));
		const meta = DOM.append(body, $('.automations-card-meta'));
		this.appendMetaRow(meta, localize('automationMetaSchedule', "Schedule"), formatSchedule(automation));
		this.appendMetaRow(meta, localize('automationMetaNextRun', "Next run"), formatNextRunValue(automation));
		this.appendMetaRow(meta, localize('automationMetaFolder', "Folder"), this.formatFolderLabel(automation.folderUri), automation.folderUri.toString());
		this.appendMetaRow(meta, localize('automationMetaLastRun', "Last run"), automation.lastRunAt
			? formatRelativeTimeOrIso(automation.lastRunAt)
			: localize('automationMetaNeverRun', "Not run yet"));

		const prompt = DOM.append(body, $('p.automations-card-prompt'));
		prompt.textContent = truncate(automation.prompt, 160);
		prompt.title = automation.prompt;

		const actions = DOM.append(card, $('.automations-card-actions'));
		disposables.add(DOM.addDisposableListener(actions, 'click', e => {
			e.stopPropagation();
		}));
		disposables.add(DOM.addDisposableListener(actions, 'keydown', e => {
			e.stopPropagation();
		}));
		this.renderActions(actions, automation, expanded, inFlight, historyPanel.id, disposables);

		DOM.clearNode(historyPanel);
		if (expanded) {
			this.renderHistoryPanel(historyPanel, automation, runs, disposables);
		} else {
			historyPanel.style.display = 'none';
		}
	}

	private appendMetaRow(container: HTMLElement, label: string, value: string, title?: string): void {
		const row = DOM.append(container, $('.automations-card-meta-row'));
		const labelEl = DOM.append(row, $('span.automations-card-meta-label'));
		labelEl.textContent = label;
		const valueEl = DOM.append(row, $('span.automations-card-meta-value'));
		valueEl.textContent = value;
		if (title) {
			valueEl.title = title;
		}
	}

	private renderActions(container: HTMLElement, automation: IAutomation, expanded: boolean, inFlight: boolean, historyPanelId: string, disposables: DisposableStore): void {
		const runBtn = this.createIconButton(container, Codicon.play, localize('runNow', "Run now"), inFlight, disposables);
		disposables.add(DOM.addStandardDisposableListener(runBtn, 'click', () => {
			void this.runNow(automation);
		}));

		const toggleIcon = automation.enabled ? Codicon.eye : Codicon.eyeClosed;
		const toggleTooltip = automation.enabled ? localize('disableAutomation', "Disable") : localize('enableAutomation', "Enable");
		const toggleBtn = this.createIconButton(container, toggleIcon, toggleTooltip, false, disposables);
		disposables.add(DOM.addStandardDisposableListener(toggleBtn, 'click', () => {
			void this.toggleEnabled(automation);
		}));

		const editBtn = this.createIconButton(container, Codicon.edit, localize('editAutomation', "Edit"), false, disposables);
		disposables.add(DOM.addStandardDisposableListener(editBtn, 'click', () => {
			void this.openEditDialog(automation);
		}));

		const deleteBtn = this.createIconButton(container, Codicon.trash, localize('deleteAutomation', "Delete"), false, disposables);
		disposables.add(DOM.addStandardDisposableListener(deleteBtn, 'click', () => {
			void this.deleteAutomation(automation);
		}));

		const histIcon = expanded ? Codicon.chevronDown : Codicon.chevronRight;
		const histTooltip = expanded ? localize('hideHistory', "Hide history") : localize('showHistory', "Show history");
		const histBtn = this.createIconButton(container, histIcon, histTooltip, false, disposables);
		histBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
		histBtn.setAttribute('aria-controls', historyPanelId);
		disposables.add(DOM.addStandardDisposableListener(histBtn, 'click', () => {
			this.toggleExpanded(automation.id);
		}));
	}

	private renderHistoryPanel(container: HTMLElement, automation: IAutomation, runs: readonly IAutomationRun[], disposables: DisposableStore): void {
		container.style.display = '';
		container.setAttribute('role', 'region');
		container.setAttribute('aria-label', localize('historyAriaLabel', "Run history for {0}", automation.name));

		if (runs.length === 0) {
			const empty = DOM.append(container, $('.automations-history-empty'));
			empty.textContent = localize('noRunsYet', "No runs yet.");
			return;
		}

		const heading = DOM.append(container, $('h4.automations-history-heading'));
		heading.textContent = localize('runHistory', "Run history");

		const runsList = DOM.append(container, $('ul.automations-history-list'));
		const visibleRuns = runs.slice(0, MAX_VISIBLE_RUNS);
		for (const run of visibleRuns) {
			this.renderRunRow(runsList, run, disposables);
		}
		if (runs.length > MAX_VISIBLE_RUNS) {
			const more = DOM.append(container, $('.automations-history-more'));
			more.textContent = localize('historyMore', "{0} more run(s) not shown.", runs.length - visibleRuns.length);
		}
	}

	private renderRunRow(container: HTMLElement, run: IAutomationRun, disposables: DisposableStore): void {
		const li = DOM.append(container, $('li.automations-history-row', {
			'data-run-id': run.id,
			'data-run-status': run.status,
		}));

		const statusIcon = DOM.append(li, $('span.automations-history-status.codicon'));
		const { iconId, spin } = runStatusIcon(run.status);
		statusIcon.classList.add(`codicon-${iconId}`);
		if (spin) {
			statusIcon.classList.add('codicon-modifier-spin');
		}
		statusIcon.setAttribute('aria-hidden', 'true');

		const text = DOM.append(li, $('.automations-history-row-text'));
		const first = DOM.append(text, $('.automations-history-row-first'));
		const statusLabel = DOM.append(first, $('span.automations-history-row-status'));
		statusLabel.textContent = runStatusLabel(run.status);
		const sep = DOM.append(first, $('span.automations-history-row-sep'));
		sep.textContent = '·';
		const trig = DOM.append(first, $('span.automations-history-row-trigger'));
		trig.textContent = runTriggerLabel(run.trigger);
		const sep2 = DOM.append(first, $('span.automations-history-row-sep'));
		sep2.textContent = '·';
		const started = DOM.append(first, $('span.automations-history-row-started'));
		started.textContent = localize('runStarted', "Started {0}", formatRelativeTimeOrIso(run.startedAt));
		const dur = formatRunDuration(run);
		if (dur) {
			const sep3 = DOM.append(first, $('span.automations-history-row-sep'));
			sep3.textContent = '·';
			const durEl = DOM.append(first, $('span.automations-history-row-duration'));
			durEl.textContent = dur;
		}

		if (run.errorMessage) {
			const err = DOM.append(text, $('.automations-history-row-error'));
			err.textContent = run.errorMessage;
			err.setAttribute('role', 'status');
			err.setAttribute('aria-live', 'polite');
		}

		if (run.sessionResource) {
			const openButton = DOM.append(li, $('span.automations-history-row-open.codicon.codicon-link-external'));
			openButton.setAttribute('role', 'button');
			openButton.setAttribute('tabindex', '0');
			openButton.setAttribute('aria-label', localize('openRunSession', "Open session"));
			disposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), openButton, localize('openRunSession', "Open session")));
			const openSession = (e: Event) => {
				e.stopPropagation();
				const sessionResource = URI.parse(run.sessionResource!);
				this.logService.debug(`[AutomationsListWidget] Opening session: ${sessionResource.toString()}`);
				const activeEditor = this.editorService.activeEditor;
				const activeGroupId = this.editorGroupsService.activeGroup.id;
				const agentSession = this.agentSessionsService.getSession(sessionResource);
				if (!agentSession) {
					this.logService.warn(`[AutomationsListWidget] Session not found for ${sessionResource.toString()}`);
					this.notificationService.error(localize('openRunSessionFailed', "Failed to open automation session"));
					return;
				}
				this.instantiationService.invokeFunction(openSessionFromOpener, agentSession).then(() => {
					if (activeEditor) {
						this.editorService.closeEditor({ editor: activeEditor, groupId: activeGroupId });
					}
				}).catch((err) => {
					this.logService.error(`[AutomationsListWidget] openSession failed for ${sessionResource.toString()}`, err);
					this.notificationService.error(localize('openRunSessionFailed', "Failed to open automation session"));
				});
			};
			disposables.add(DOM.addDisposableListener(openButton, 'click', openSession));
			disposables.add(DOM.addDisposableListener(openButton, 'keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					openSession(e);
				}
			}));
		}
	}

	private createIconButton(container: HTMLElement, icon: ThemeIcon, tooltip: string, disabled: boolean, disposables: DisposableStore): HTMLElement {
		const button = DOM.append(container, $('button.automations-card-action-button', {
			type: 'button',
			'aria-label': tooltip,
			tabindex: '0',
		})) as HTMLButtonElement;
		button.classList.add(...ThemeIcon.asClassNameArray(icon));
		button.disabled = disabled;
		disposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), button, tooltip));
		return button;
	}

	toggleExpanded(automationId: string): void {
		if (this.expandedRows.has(automationId)) {
			this.expandedRows.delete(automationId);
		} else {
			this.expandedRows.add(automationId);
		}
		this.updateList(this.automationService.automations.get());
	}

	async runNow(automation: IAutomation): Promise<void> {
		if (!this._isEnabled()) {
			await this._notifyDisabled();
			return;
		}
		if (this.runInFlight.has(automation.id)) {
			return;
		}
		this.runInFlight.add(automation.id);
		this.updateList(this.automationService.automations.get());
		const previousRunId = this.automationService.runsFor(automation.id).get()[0]?.id;
		try {
			// The runner does not support cancellation yet.
			await this.automationRunner.runOnce(automation, 'manual', 0, CancellationToken.None);
			const latestRun = this.automationService.runsFor(automation.id).get()[0];
			if (latestRun && latestRun.id !== previousRunId && latestRun.status !== 'failed') {
				status(localize('automationStartedStatus', "Started automation {0}", automation.name));
			}
		} catch (err) {
			this.logService.error('[Automations] runNow failed unexpectedly', err);
		} finally {
			this.runInFlight.delete(automation.id);
			this.updateList(this.automationService.automations.get());
		}
	}

	async toggleEnabled(automation: IAutomation): Promise<void> {
		if (!this._isEnabled()) {
			await this._notifyDisabled();
			return;
		}
		try {
			await this.automationService.updateAutomation(automation.id, { enabled: !automation.enabled });
			status(automation.enabled
				? localize('automationDisabledStatus', "Disabled automation {0}", automation.name)
				: localize('automationEnabledStatus', "Enabled automation {0}", automation.name));
		} catch (err) {
			this.logService.error('[Automations] Failed to toggle automation', err);
		}
	}

	async deleteAutomation(automation: IAutomation): Promise<void> {
		if (!this._isEnabled()) {
			await this._notifyDisabled();
			return;
		}
		const result = await this.dialogService.confirm({
			type: 'warning',
			message: localize('confirmDeleteAutomation', "Delete automation \u201C{0}\u201D?", automation.name),
			detail: localize('confirmDeleteAutomationDetail', "Runs already in flight will continue. This cannot be undone."),
			primaryButton: localize('delete', "Delete"),
		});
		if (!result.confirmed) {
			return;
		}
		if (!this._isEnabled()) {
			await this._notifyDisabled();
			return;
		}
		try {
			await this.automationService.deleteAutomation(automation.id);
			status(localize('automationDeletedStatus', "Deleted automation {0}", automation.name));
		} catch (err) {
			this.logService.error('[Automations] Failed to delete automation', err);
		}
	}

	async openEditDialog(automation: IAutomation): Promise<void> {
		if (!this._isEnabled()) {
			await this._notifyDisabled();
			return;
		}
		const result = await this.automationDialogService.showAutomationDialog({
			existing: automation,
		});
		if (!result || result.kind !== 'update') {
			return;
		}
		if (!this._isEnabled()) {
			await this._notifyDisabled();
			return;
		}
		try {
			await this.automationService.updateAutomation(result.id, result.value);
			status(localize('automationUpdatedStatus', "Updated automation {0}", automation.name));
		} catch (err) {
			this.logService.error('[Automations] Failed to update automation', err);
			await this.dialogService.error(
				localize('automationUpdateFailed', "Failed to update automation."),
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	formatFolderLabel(folderUri: URI): string {
		const folders = this.workspaceContextService.getWorkspace().folders;
		const match = folders.find(f => resources.isEqual(f.uri, folderUri));
		if (match) {
			return match.name || match.uri.toString();
		}
		const segments = folderUri.path.split('/').filter(s => s.length > 0);
		return segments[segments.length - 1] ?? folderUri.toString();
	}

	private _isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(CHAT_AUTOMATIONS_ENABLED_SETTING) === true;
	}

	private async _notifyDisabled(): Promise<void> {
		await this.dialogService.info(
			localize('automationsDisabledTitle', "Automations are disabled."),
			localize('automationsDisabledDetail', "Enable \u201C{0}\u201D to make changes.", CHAT_AUTOMATIONS_ENABLED_SETTING),
		);
	}

	private async openCreateDialog(): Promise<void> {
		if (!this._isEnabled()) {
			await this._notifyDisabled();
			return;
		}
		const result = await this.automationDialogService.showAutomationDialog({});
		if (!result || result.kind !== 'create') {
			return;
		}
		if (!this._isEnabled()) {
			await this._notifyDisabled();
			return;
		}
		try {
			const created = await this.automationService.createAutomation(result.value);
			status(localize('automationCreatedStatus', "Created automation {0}", created.name));
		} catch (err) {
			this.logService.error('[Automations] Failed to create automation', err);
			await this.dialogService.error(
				localize('automationCreateFailed', "Failed to create automation."),
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	layout(height: number, width: number): void {
		this.lastHeight = height;
		this.lastWidth = width;

		this.element.style.height = `${height}px`;

		// Measure the header to calculate the list height.
		// When offsetHeight returns 0 the container may have just become visible
		// after display:none and the browser hasn't reflowed yet. Defer layout
		// once so measurements are accurate. Only retry once to avoid an endless
		// loop when the widget is created while permanently hidden.
		const headerHeight = this.headerEl.offsetHeight;
		if (headerHeight === 0 && !this._layoutDeferred) {
			this._layoutDeferred = true;
			this._layoutRAF.value = DOM.scheduleAtNextAnimationFrame(DOM.getWindow(this.element), () => {
				this._layoutDeferred = false;
				this.layout(this.lastHeight, this.lastWidth);
			});
			return;
		}
		const listHeight = Math.max(0, height - headerHeight);

		this.scrollableNode.style.height = `${listHeight}px`;
		this.scrollable.scanDomNode();
	}

	fireItemCount(): void {
		this._onDidChangeItemCount.fire(this.automationService.automations.get().length);
	}

	/** Test-only: number of cards currently in the grid. */
	get itemCount(): number {
		return this.displayEntries.length;
	}

	/**
	 * Test-only: snapshot of the view-model cards the widget is displaying.
	 */
	getDisplayEntriesForTest(): readonly IAutomationListEntry[] {
		return this.displayEntries;
	}

	focus(): void {
		const firstCard = this.cardsGrid.querySelector<HTMLElement>('.automations-card');
		if (firstCard) {
			firstCard.focus();
			return;
		}

		this.emptyContainer.querySelector<HTMLElement>('.automations-empty-cta')?.focus();
	}
}

function formatSchedule(a: IAutomation): string {
	switch (a.schedule.interval) {
		case 'manual':
			return localize('scheduleManual', "Manual");
		case 'hourly':
			return localize('scheduleHourly', "Hourly");
		case 'daily':
			return localize('scheduleDaily', "Daily at {0}", formatHourMinute(a.schedule.scheduleHour, a.schedule.scheduleMinute));
		case 'weekly': {
			const day = dayName(a.schedule.scheduleDay);
			return localize('scheduleWeekly', "Weekly on {0} at {1}", day, formatHourMinute(a.schedule.scheduleHour, a.schedule.scheduleMinute));
		}
	}
}

function formatHourMinute(hour: number, minute: number): string {
	const date = new Date();
	date.setHours(Math.max(0, Math.min(23, hour | 0)), Math.max(0, Math.min(59, minute | 0)), 0, 0);
	return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function dayName(day: number): string {
	const idx = ((day % 7) + 7) % 7;
	return DAYS_OF_WEEK[idx];
}

function formatNextRun(a: IAutomation): string {
	if (a.schedule.interval === 'manual' || !a.nextRunAt) {
		return localize('nextRunNever', "No scheduled run");
	}
	return localize('nextRun', "Next run {0}", formatRelativeTimeOrIso(a.nextRunAt));
}

function formatNextRunValue(a: IAutomation): string {
	if (a.schedule.interval === 'manual' || !a.nextRunAt) {
		return localize('nextRunNeverValue', "No scheduled run");
	}
	return formatRelativeTimeOrIso(a.nextRunAt);
}

function formatRelativeTimeOrIso(iso: string): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) {
		return iso;
	}
	const date = new Date(t);
	const rel = fromNow(date, true);
	const absolute = date.toLocaleString();
	return `${rel} (${absolute})`;
}

function truncate(s: string, max: number): string {
	const single = s.replace(/\s+/g, ' ').trim();
	if (single.length <= max) {
		return single;
	}
	return single.slice(0, Math.max(0, max - 1)) + '\u2026';
}

function runStatusIcon(status: AutomationRunStatus): { iconId: string; spin: boolean } {
	switch (status) {
		case 'pending': return { iconId: 'circle-outline', spin: false };
		case 'running': return { iconId: 'sync', spin: true };
		case 'completed': return { iconId: 'check', spin: false };
		case 'failed': return { iconId: 'error', spin: false };
	}
}

function runStatusLabel(status: AutomationRunStatus): string {
	switch (status) {
		case 'pending': return localize('runStatusPending', "Pending");
		case 'running': return localize('runStatusRunning', "Running");
		case 'completed': return localize('runStatusCompleted', "Completed");
		case 'failed': return localize('runStatusFailed', "Failed");
	}
}

function runTriggerLabel(trigger: AutomationRunTrigger): string {
	switch (trigger) {
		case 'schedule': return localize('runTriggerSchedule', "Scheduled");
		case 'manual': return localize('runTriggerManual', "Manual");
		case 'catch_up': return localize('runTriggerCatchUp', "Catch-up");
	}
}

function formatRunDuration(run: IAutomationRun): string | undefined {
	if (!run.completedAt) {
		return undefined;
	}
	const startMs = Date.parse(run.startedAt);
	const endMs = Date.parse(run.completedAt);
	if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
		return undefined;
	}
	const durationMs = Math.max(0, endMs - startMs);
	return getDurationString(durationMs);
}
