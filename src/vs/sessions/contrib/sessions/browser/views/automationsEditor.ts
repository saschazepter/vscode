/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/automationsCards.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import type { IAutomation, IAutomationRun, AutomationRunStatus } from '../../../../../workbench/contrib/chat/common/automations/automation.js';
import { IAutomationService } from '../../../../../workbench/contrib/chat/common/automations/automationService.js';
import { IAutomationRunner } from '../../../../../workbench/contrib/chat/common/automations/automationRunner.js';
import { IAutomationDialogService } from '../../../../../workbench/contrib/chat/common/automations/automationDialogService.js';
import { automationIcon } from '../../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationIcons.js';
import { basename } from '../../../../../base/common/resources.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { URI } from '../../../../../base/common/uri.js';

import { AbstractChatView, ChatViewKind } from '../../../../browser/parts/chatView.js';

const $ = DOM.$;

/**
 * Card-style view of automations for the Agents window sessions grid.
 * Uses native VS Code components and styling patterns matching the
 * automationsListWidget in AI Customization.
 */
export class AutomationsCardsWidget extends Disposable {

	readonly element: HTMLElement;

	private readonly cardsContainer: HTMLElement;
	private readonly emptyContainer: HTMLElement;
	private readonly historyContainer: HTMLElement;
	private readonly headerEl: HTMLElement;
	private readonly cardDisposables = this._register(new DisposableStore());
	private readonly historyDisposables = this._register(new DisposableStore());

	private static readonly READ_AUTOMATION_RUNS_KEY = 'sessionsListControl.readAutomationRuns';

	constructor(
		@IAutomationService private readonly automationService: IAutomationService,
		@IAutomationRunner private readonly automationRunner: IAutomationRunner,
		@IAutomationDialogService private readonly automationDialogService: IAutomationDialogService,
		@IHoverService private readonly hoverService: IHoverService,
		@ILogService private readonly logService: ILogService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this.element = $('.automations-cards-widget');

		this.headerEl = DOM.append(this.element, $('.automations-cards-header'));
		this.renderHeader();

		this.cardsContainer = DOM.append(this.element, $('.automations-cards-grid'));
		this.emptyContainer = DOM.append(this.element, $('.automations-cards-empty'));
		this.emptyContainer.style.display = 'none';
		this.historyContainer = DOM.append(this.element, $('.automations-history'));

		this._register(autorun(reader => {
			const items = this.automationService.automations.read(reader);
			const allRuns = this.automationService.runs.read(reader);
			this.renderCards(items);
			this.renderHistory(allRuns, items);
		}));
	}

	private renderHeader(): void {
		const titleRow = DOM.append(this.headerEl, $('.automations-cards-header-row'));
		const titleEl = DOM.append(titleRow, $('span.automations-cards-header-title'));
		titleEl.textContent = localize('automationsTitle', "Automations");

		const newButton = this._register(new Button(titleRow, {
			...defaultButtonStyles,
			title: localize('newAutomation', "New automation"),
		}));
		newButton.label = localize('newAutomationLabel', "New Automation");
		newButton.element.classList.add('automations-cards-new-button');
		this._register(newButton.onDidClick(() => this.openCreateDialog()));

		const descEl = DOM.append(this.headerEl, $('p.automations-cards-header-description'));
		descEl.textContent = localize('automationsDescription', "Schedule agent sessions to run automatically on a cadence you choose.");
	}

	private async openCreateDialog(): Promise<void> {
		const result = await this.automationDialogService.showAutomationDialog({});
		if (!result || result.kind !== 'create') {
			return;
		}
		try {
			const created = await this.automationService.createAutomation(result.value);
			status(localize('automationCreatedStatus', "Created automation {0}", created.name));
		} catch (err) {
			this.logService.error('[AutomationsCards] Failed to create automation', err);
		}
	}

	private async openEditDialog(automation: IAutomation): Promise<void> {
		const result = await this.automationDialogService.showAutomationDialog({ existing: automation });
		if (!result || result.kind !== 'update') {
			return;
		}
		try {
			await this.automationService.updateAutomation(result.id, result.value);
			status(localize('automationUpdatedStatus', "Updated automation {0}", automation.name));
		} catch (err) {
			this.logService.error('[AutomationsCards] Failed to update automation', err);
		}
	}

	private renderCards(automations: readonly IAutomation[]): void {
		this.cardDisposables.clear();
		DOM.clearNode(this.cardsContainer);

		if (automations.length === 0) {
			this.cardsContainer.style.display = 'none';
			this.emptyContainer.style.display = '';
			this.renderEmptyState();
			return;
		}

		this.cardsContainer.style.display = '';
		this.emptyContainer.style.display = 'none';

		for (const automation of automations) {
			this.renderCard(automation);
		}
	}

	private renderCard(automation: IAutomation): void {
		const wrapper = DOM.append(this.cardsContainer, $('.automations-card-wrapper'));
		const card = DOM.append(wrapper, $('.automations-card'));
		card.setAttribute('tabindex', '0');
		card.setAttribute('role', 'button');
		card.setAttribute('aria-label', automation.name);

		const main = DOM.append(card, $('.automations-card-main'));

		// Name row with disabled badge
		const nameRow = DOM.append(main, $('.automations-card-name'));
		const nameTextEl = DOM.append(nameRow, $('span.automations-card-name-text'));
		nameTextEl.textContent = automation.name;

		if (!automation.enabled) {
			const badge = DOM.append(nameRow, $('span.automations-card-disabled-badge'));
			badge.textContent = localize('disabled', "Disabled");
		}

		// Metadata row (schedule · folder · last run)
		const metaEl = DOM.append(main, $('.automations-card-meta'));
		const scheduleEl = DOM.append(metaEl, $('span.automations-card-meta-item'));
		scheduleEl.textContent = this.formatSchedule(automation);

		const folderEl = DOM.append(metaEl, $('span.automations-card-meta-item'));
		folderEl.textContent = basename(automation.folderUri);

		// Prompt preview (truncated)
		const promptEl = DOM.append(main, $('.automations-card-prompt'));
		const maxLength = 120;
		promptEl.textContent = automation.prompt.length > maxLength
			? automation.prompt.slice(0, maxLength) + '…'
			: automation.prompt;

		// Action buttons (icon-only with hover tooltips)
		const actions = DOM.append(card, $('.automations-card-actions'));
		const runBtn = this.createIconButton(actions, Codicon.play, localize('runNow', "Run now"), false);
		this.cardDisposables.add(DOM.addStandardDisposableListener(runBtn, 'click', (e) => {
			DOM.EventHelper.stop(e, true);
			this.automationRunner.runOnce(automation, 'manual', 0, CancellationToken.None);
		}));

		const editBtn = this.createIconButton(actions, Codicon.edit, localize('editAutomation', "Edit"), false);
		this.cardDisposables.add(DOM.addStandardDisposableListener(editBtn, 'click', (e) => {
			DOM.EventHelper.stop(e, true);
			this.openEditDialog(automation);
		}));

		// Click card to edit
		this.cardDisposables.add(DOM.addDisposableListener(card, 'click', () => {
			this.openEditDialog(automation);
		}));
	}

	private createIconButton(container: HTMLElement, icon: ThemeIcon, tooltip: string, disabled: boolean): HTMLElement {
		const button = DOM.append(container, $('button.automations-card-action-button', {
			type: 'button',
			'aria-label': tooltip,
			tabindex: '0',
		})) as HTMLButtonElement;
		button.classList.add(...ThemeIcon.asClassNameArray(icon));
		button.disabled = disabled;
		this.cardDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('element'), button, tooltip));
		return button;
	}

	private renderEmptyState(): void {
		DOM.clearNode(this.emptyContainer);

		const icon = DOM.append(this.emptyContainer, $('span.automations-cards-empty-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(automationIcon));
		const title = DOM.append(this.emptyContainer, $('h3.automations-cards-empty-title'));
		title.textContent = localize('noAutomationsYet', "No automations yet");
		const desc = DOM.append(this.emptyContainer, $('p.automations-cards-empty-description'));
		desc.textContent = localize('noAutomationsDesc', "Create an automation to schedule an agent session to run on a cadence you choose.");

		const createButton = this.cardDisposables.add(new Button(this.emptyContainer, {
			...defaultButtonStyles,
			title: localize('createAutomation', "Create automation"),
		}));
		createButton.label = localize('createAutomation', "Create automation");
		createButton.element.classList.add('automations-cards-create-button');
		this.cardDisposables.add(createButton.onDidClick(() => this.openCreateDialog()));
	}

	private formatSchedule(automation: IAutomation): string {
		const { interval } = automation.schedule;
		switch (interval) {
			case 'hourly': return localize('scheduleHourly', "Runs hourly");
			case 'daily': return localize('scheduleDaily', "Runs daily");
			case 'weekly': return localize('scheduleWeekly', "Runs weekly");
			case 'manual': return localize('scheduleManual', "Manual");
			default: return localize('scheduleManual', "Manual");
		}
	}

	private renderHistory(runs: readonly IAutomationRun[], automations: readonly IAutomation[]): void {
		this.historyDisposables.clear();
		DOM.clearNode(this.historyContainer);

		if (runs.length === 0) {
			this.historyContainer.style.display = 'none';
			return;
		}

		this.historyContainer.style.display = '';

		const headerEl = DOM.append(this.historyContainer, $('.automations-history-header'));
		headerEl.textContent = localize('historyHeader', "History");

		const automationMap = new Map(automations.map(a => [a.id, a]));
		const groups = this.groupRunsByDate(runs);

		for (const group of groups) {
			const groupEl = DOM.append(this.historyContainer, $('.automations-history-group'));
			const groupHeader = DOM.append(groupEl, $('.automations-history-group-header'));
			groupHeader.textContent = group.label;

			const groupGrid = DOM.append(groupEl, $('.automations-run-cards-grid'));
			for (const run of group.runs) {
				this.renderRunRow(groupGrid, run, automationMap, group.kind);
			}
		}
	}

	private renderRunRow(parent: HTMLElement, run: IAutomationRun, automationMap: Map<string, IAutomation>, bucketKind: DateBucketKind): void {
		const card = DOM.append(parent, $('.automations-run-card'));

		const automation = automationMap.get(run.automationId);

		// Name + workspace on same line
		const nameEl = DOM.append(card, $('.automations-run-card-name'));
		const title = automation?.name ?? localize('unknownAutomation', "Unknown");
		const titleSpan = DOM.append(nameEl, $('span.automations-run-card-name-title'));
		titleSpan.textContent = title;
		if (automation?.folderUri) {
			const suffixSpan = DOM.append(nameEl, $('span.automations-run-card-name-workspace'));
			suffixSpan.textContent = ` in ${basename(automation.folderUri)}`;
		}

		// Status icon + timestamp + error (single row)
		const statusRow = DOM.append(card, $('.automations-run-card-status-row'));

		const statusInfo = runStatusIcon(run.status);
		const iconEl = DOM.append(statusRow, $('span.automations-run-card-icon.codicon'));
		iconEl.classList.add(`codicon-${statusInfo.iconId}`);
		if (statusInfo.spin) {
			iconEl.classList.add('codicon-modifier-spin');
		}

		const timeEl = DOM.append(statusRow, $('span.automations-run-card-time'));
		timeEl.textContent = formatTimestamp(run.startedAt, bucketKind);

		if (run.errorMessage) {
			DOM.append(statusRow, $('.meta-sep')).textContent = '\u00B7';
			const errorEl = DOM.append(statusRow, $('span.automations-run-card-error'));
			errorEl.textContent = run.errorMessage;
		}

		if (run.sessionResource) {
			card.setAttribute('tabindex', '0');
			card.setAttribute('role', 'button');
			this.historyDisposables.add(DOM.addDisposableListener(card, 'click', () => {
				this.sessionsService.openSession(URI.parse(run.sessionResource!), { preserveFocus: false });
				this.markRunRead(run.id);
			}));
		}
	}

	private markRunRead(runId: string): void {
		const raw = this.storageService.get(AutomationsCardsWidget.READ_AUTOMATION_RUNS_KEY, StorageScope.PROFILE);
		let ids: string[];
		try {
			ids = raw ? JSON.parse(raw) : [];
		} catch {
			ids = [];
		}
		if (!ids.includes(runId)) {
			ids.push(runId);
			// Prune stale IDs to prevent unbounded growth
			const currentRunIds = new Set(this.automationService.runs.get().map(r => r.id));
			ids = ids.filter(id => id === runId || currentRunIds.has(id));
			this.storageService.store(
				AutomationsCardsWidget.READ_AUTOMATION_RUNS_KEY,
				JSON.stringify(ids),
				StorageScope.PROFILE,
				StorageTarget.USER,
			);
		}
	}

	private groupRunsByDate(runs: readonly IAutomationRun[]): { label: string; kind: DateBucketKind; runs: IAutomationRun[] }[] {
		const now = new Date();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const yesterday = new Date(today.getTime() - 86400000);
		const lastWeekStart = new Date(today.getTime() - 7 * 86400000);

		const groups: Map<string, { label: string; kind: DateBucketKind; order: number; runs: IAutomationRun[] }> = new Map();

		for (const run of runs) {
			const t = Date.parse(run.startedAt);
			if (Number.isNaN(t)) {
				continue;
			}
			const date = new Date(t);
			const { label, kind, order } = this.getDateBucket(date, today, yesterday, lastWeekStart);

			let group = groups.get(label);
			if (!group) {
				group = { label, kind, order, runs: [] };
				groups.set(label, group);
			}
			group.runs.push(run);
		}

		return [...groups.values()].sort((a, b) => a.order - b.order);
	}

	private getDateBucket(date: Date, today: Date, yesterday: Date, lastWeekStart: Date): { label: string; kind: DateBucketKind; order: number } {
		if (date >= today) {
			return { label: localize('today', "Today"), kind: 'today', order: 0 };
		}
		if (date >= yesterday) {
			return { label: localize('yesterday', "Yesterday"), kind: 'yesterday', order: 1 };
		}
		if (date >= lastWeekStart) {
			return { label: localize('lastWeek', "Last week"), kind: 'week', order: 2 };
		}
		const monthLabel = date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
		const order = 100 - (date.getFullYear() * 12 + date.getMonth());
		return { label: monthLabel, kind: 'month', order };
	}

	layout(width: number, height: number): void {
		this.element.style.width = `${width}px`;
		this.element.style.height = `${height}px`;
	}
}

//#region Run history helpers

type DateBucketKind = 'today' | 'yesterday' | 'week' | 'month';

function runStatusIcon(status: AutomationRunStatus): { iconId: string; spin: boolean } {
	switch (status) {
		case 'pending': return { iconId: 'circle-outline', spin: false };
		case 'running': return { iconId: 'sync', spin: true };
		case 'completed': return { iconId: 'check', spin: false };
		case 'failed': return { iconId: 'error', spin: false };
	}
}

function formatTimestamp(iso: string, kind: DateBucketKind): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) {
		return iso;
	}
	const date = new Date(t);
	const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

	switch (kind) {
		case 'today':
		case 'yesterday':
			return time;
		case 'week':
			return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
		case 'month':
			return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
	}
}

//#endregion

//#region AutomationsView

/**
 * A chat view that hosts the automations management page within the
 * sessions grid, following the same pattern as NewChatView/ChatView.
 */
export class AutomationsView extends AbstractChatView {

	static readonly TYPE = 'sessions.automations';

	override readonly kind: ChatViewKind = 'automations';

	private readonly _widget: AutomationsCardsWidget;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();

		this.element.classList.add('chat-view-automations');

		this._widget = this._register(instantiationService.createInstance(AutomationsCardsWidget));
		this.element.appendChild(this._widget.element);
	}

	protected override doLayout(width: number, height: number, _top: number, _left: number): void {
		this._widget.layout(width, height);
	}

	override toJSON(): object {
		return { type: AutomationsView.TYPE };
	}

	override focus(): void {
		this._widget.element.focus();
	}
}

//#endregion
