/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/automationsCards.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { EditorPane } from '../../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import type { IAutomation, IAutomationRun, AutomationRunStatus } from '../../../../../workbench/contrib/chat/common/automations/automation.js';
import { IAutomationService } from '../../../../../workbench/contrib/chat/common/automations/automationService.js';
import { IAutomationRunner } from '../../../../../workbench/contrib/chat/common/automations/automationRunner.js';
import { IAutomationDialogService } from '../../../../../workbench/contrib/chat/common/automations/automationDialogService.js';
import { automationIcon } from '../../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationIcons.js';
import { basename } from '../../../../../base/common/resources.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';

const $ = DOM.$;

/**
 * Card-style view of automations for the Agents window sessions sidebar.
 * Displays automations as a grid of cards (similar to the Overview page
 * in AI Customization Management Editor).
 */
export class AutomationsCardsWidget extends Disposable {

	readonly element: HTMLElement;

	private readonly cardsContainer: HTMLElement;
	private readonly emptyContainer: HTMLElement;
	private readonly headerEl: HTMLElement;
	private readonly cardDisposables = this._register(new DisposableStore());

	constructor(
		@IAutomationService private readonly automationService: IAutomationService,
		@IAutomationRunner private readonly automationRunner: IAutomationRunner,
		@IAutomationDialogService private readonly automationDialogService: IAutomationDialogService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.element = $('.automations-cards-widget');

		this.headerEl = DOM.append(this.element, $('.automations-cards-header'));
		this.renderHeader();

		this.cardsContainer = DOM.append(this.element, $('.automations-cards-grid'));
		this.emptyContainer = DOM.append(this.element, $('.automations-cards-empty'));
		this.emptyContainer.style.display = 'none';

		this._register(autorun(reader => {
			const items = this.automationService.automations.read(reader);
			this.automationService.runs.read(reader);
			this.renderCards(items);
		}));
	}

	private renderHeader(): void {
		const titleRow = DOM.append(this.headerEl, $('.automations-cards-header-row'));
		const iconEl = DOM.append(titleRow, $('span.automations-cards-header-icon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(automationIcon));
		const titleEl = DOM.append(titleRow, $('span.automations-cards-header-title'));
		titleEl.textContent = localize('automationsTitle', "Automations");

		const newButton = this._register(new Button(titleRow, {
			...defaultButtonStyles,
			secondary: true,
			title: localize('newAutomation', "New automation"),
		}));
		newButton.label = localize('newAutomationShort', "+ New");
		newButton.element.classList.add('automations-cards-new-button');
		this._register(newButton.onDidClick(() => this.openCreateDialog()));
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
		const card = DOM.append(this.cardsContainer, $('.automations-card'));
		card.setAttribute('tabindex', '0');
		card.setAttribute('role', 'button');

		// Header: name
		const header = DOM.append(card, $('.automations-card-header'));
		const nameEl = DOM.append(header, $('span.automations-card-name'));
		nameEl.textContent = automation.name;

		if (!automation.enabled) {
			const badge = DOM.append(header, $('span.automations-card-disabled-badge'));
			badge.textContent = localize('disabled', "Disabled");
		}

		// Schedule info
		const scheduleEl = DOM.append(card, $('p.automations-card-schedule'));
		scheduleEl.textContent = this.formatSchedule(automation);

		// Prompt preview (truncated)
		const promptEl = DOM.append(card, $('p.automations-card-prompt'));
		const maxLength = 120;
		promptEl.textContent = automation.prompt.length > maxLength
			? automation.prompt.slice(0, maxLength) + '…'
			: automation.prompt;

		// Footer: workspace + last run
		const footer = DOM.append(card, $('.automations-card-footer'));
		const folderEl = DOM.append(footer, $('span.automations-card-folder'));
		folderEl.textContent = basename(automation.folderUri);

		const lastRunEl = DOM.append(footer, $('span.automations-card-last-run'));
		const runs = this.automationService.runsFor(automation.id);
		const latestRun = runs.get()[0];
		if (latestRun) {
			lastRunEl.textContent = this.formatLastRun(latestRun);
				lastRunEl.classList.toggle('automations-card-run-failed', latestRun.status === 'failed');
				lastRunEl.classList.toggle('automations-card-run-success', latestRun.status === 'completed');
		}

		// Actions row
		const actions = DOM.append(card, $('.automations-card-actions'));
		const runBtn = DOM.append(actions, $('button.automations-card-action-btn'));
		runBtn.textContent = localize('runNow', "Run");
		runBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.play));
		this.cardDisposables.add(DOM.addDisposableListener(runBtn, 'click', (e) => {
			e.stopPropagation();
			this.automationRunner.runOnce(automation, 'manual', 0, CancellationToken.None);
		}));

		const editBtn = DOM.append(actions, $('button.automations-card-action-btn'));
		editBtn.textContent = localize('edit', "Edit");
		this.cardDisposables.add(DOM.addDisposableListener(editBtn, 'click', (e) => {
			e.stopPropagation();
			this.openEditDialog(automation);
		}));

		// Click card to edit
		this.cardDisposables.add(DOM.addDisposableListener(card, 'click', () => {
			this.openEditDialog(automation);
		}));
	}

	private renderEmptyState(): void {
		DOM.clearNode(this.emptyContainer);

		const icon = DOM.append(this.emptyContainer, $('span.automations-cards-empty-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(automationIcon));
		const title = DOM.append(this.emptyContainer, $('h3.automations-cards-empty-title'));
		title.textContent = localize('noAutomationsYet', "No automations yet");
		const desc = DOM.append(this.emptyContainer, $('p.automations-cards-empty-description'));
		desc.textContent = localize('noAutomationsDesc', "Create an automation to schedule an agent session to run on a cadence you choose.");

		const createButton = this._register(new Button(this.emptyContainer, {
			...defaultButtonStyles,
			title: localize('createAutomation', "Create automation"),
		}));
		createButton.label = localize('createAutomation', "Create automation");
		createButton.element.classList.add('automations-cards-create-button');
		this._register(createButton.onDidClick(() => this.openCreateDialog()));
	}

	private formatSchedule(automation: IAutomation): string {
		const { interval } = automation.schedule;
		switch (interval) {
			case 'hourly': return localize('scheduleHourly', "Runs hourly");
			case 'daily': return localize('scheduleDaily', "Runs daily");
			case 'weekly': return localize('scheduleWeekly', "Runs weekly");
			case 'manual': return localize('scheduleManual', "Manual only");
			default: return String(interval);
		}
	}

	private formatLastRun(run: IAutomationRun): string {
		switch (run.status) {
			case 'completed':
				return localize('lastRunSuccess', "Last run succeeded");
			case 'failed':
				return localize('lastRunFailed', "Last run failed");
			case 'running':
			case 'pending':
				return localize('lastRunInProgress', "Running…");
			default:
				return '';
		}
	}

	layout(width: number, height: number): void {
		this.element.style.width = `${width}px`;
		this.element.style.height = `${height}px`;
	}
}

//#region Editor Input

export const AUTOMATIONS_EDITOR_ID = 'workbench.editor.automations';
export const AUTOMATIONS_EDITOR_INPUT_ID = 'workbench.editorinputs.automations';

export class AutomationsEditorInput extends EditorInput {

	static readonly ID: string = AUTOMATIONS_EDITOR_INPUT_ID;

	readonly resource = undefined;

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	private static _instance: AutomationsEditorInput | undefined;

	static getOrCreate(): AutomationsEditorInput {
		if (!AutomationsEditorInput._instance || AutomationsEditorInput._instance.isDisposed()) {
			AutomationsEditorInput._instance = new AutomationsEditorInput();
		}
		return AutomationsEditorInput._instance;
	}

	constructor() {
		super();
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof AutomationsEditorInput;
	}

	override get typeId(): string {
		return AutomationsEditorInput.ID;
	}

	override getName(): string {
		return localize('automationsEditorName', "Automations");
	}

	override getIcon(): ThemeIcon {
		return automationIcon;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}

//#endregion

//#region Editor Pane

export class AutomationsEditorPane extends EditorPane {

	static readonly ID = AUTOMATIONS_EDITOR_ID;

	private container!: HTMLElement;
	private widget: AutomationsCardsWidget | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(AutomationsEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = DOM.append(parent, DOM.$('.automations-editor-pane'));
		this.widget = this._register(this.instantiationService.createInstance(AutomationsCardsWidget));
		this.container.appendChild(this.widget.element);
	}

	layout(dimension: DOM.Dimension): void {
		this.widget?.layout(dimension.width, dimension.height);
	}
}

//#endregion
