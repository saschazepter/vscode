/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/copilotPrototypeShell.css';
import { $, append } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { renderLabelWithIcons } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Event } from '../../../../base/common/event.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles, defaultCheckboxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { ViewContainerLocation, IViewDescriptorService } from '../../../common/views.js';
import { IStatusbarEntry, IStatusbarService, ShowTooltipCommand, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ChatViewId } from './chat.js';

export class CopilotPrototypeShellContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.copilotPrototypeShell';

	private ensureShellPromise: Promise<void> | undefined;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IViewsService private readonly viewsService: IViewsService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
	) {
		super();

		this._register(Event.filter(this.layoutService.onDidChangePartVisibility, e =>
			(e.partId === Parts.AUXILIARYBAR_PART && !e.visible) ||
			(e.partId === Parts.TITLEBAR_PART && e.visible) ||
			(e.partId === Parts.ACTIVITYBAR_PART && e.visible) ||
			(e.partId === Parts.SIDEBAR_PART && e.visible) ||
			(e.partId === Parts.EDITOR_PART && e.visible) ||
			(e.partId === Parts.PANEL_PART && e.visible)
		)(() => {
			void this.ensureShell();
		}));
		this._register(this.layoutService.onDidChangeAuxiliaryBarMaximized(() => {
			if (!this.layoutService.isAuxiliaryBarMaximized()) {
				void this.ensureShell();
			}
		}));
		this._register(Event.filter(this.viewsService.onDidChangeViewVisibility, e => e.id === ChatViewId && !e.visible)(() => {
			void this.ensureShell();
		}));
		this._register(Event.filter(this.viewDescriptorService.onDidChangeLocation, e => e.views.some(view => view.id === ChatViewId) && e.to !== ViewContainerLocation.AuxiliaryBar)(() => {
			void this.ensureShell();
		}));

		void this.ensureShell();
	}

	private ensureShell(): Promise<void> {
		if (!this.ensureShellPromise) {
			this.ensureShellPromise = this.doEnsureShell().finally(() => {
				this.ensureShellPromise = undefined;
			});
		}

		return this.ensureShellPromise;
	}

	private async doEnsureShell(): Promise<void> {
		this.layoutService.getContainer(mainWindow).classList.add('copilot-prototype-shell');
		this.layoutService.setPartHidden(true, Parts.TITLEBAR_PART);
		this.layoutService.setPartHidden(true, Parts.ACTIVITYBAR_PART);
		this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		this.layoutService.setPartHidden(false, Parts.STATUSBAR_PART);
		this.layoutService.setPartHidden(true, Parts.PANEL_PART);
		this.layoutService.setAuxiliaryBarMaximized(true);

		const chatView = this.viewDescriptorService.getViewDescriptorById(ChatViewId);
		if (chatView && this.viewDescriptorService.getViewLocationById(ChatViewId) !== ViewContainerLocation.AuxiliaryBar) {
			this.viewDescriptorService.moveViewToLocation(chatView, ViewContainerLocation.AuxiliaryBar, CopilotPrototypeShellContribution.ID);
		}

		await this.viewsService.openView(ChatViewId, false);
	}
}

class CopilotPrototypeShellCoinStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.copilotPrototypeShellCoinStatusBar';
	private static readonly STATUS_BAR_ENTRY_ID = 'chat.prototypeCoinStatusBarEntry';
	private static readonly DASHBOARD_ENTRY_ID = 'chat.prototypeDashboardEntry';

	private _activeSku = 'Edu/Free';
	private _activeState = 'Default';
	private readonly _dashboardEntryAccessor;

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
	) {
		super();

		// Left-side coin (controller grid)
		this._register(statusbarService.addEntry(this.getEntryProps(), CopilotPrototypeShellCoinStatusBarContribution.STATUS_BAR_ENTRY_ID, StatusbarAlignment.LEFT, {
			location: { id: 'status.prototype.coin', priority: 1000 },
			alignment: StatusbarAlignment.LEFT,
		}));

		// Right-side Copilot icon (shows dashboard tooltip)
		this._dashboardEntryAccessor = this._register(statusbarService.addEntry(this.getDashboardEntryProps(), CopilotPrototypeShellCoinStatusBarContribution.DASHBOARD_ENTRY_ID, StatusbarAlignment.RIGHT, {
			location: { id: 'status.prototype.dashboard', priority: 1000 },
			alignment: StatusbarAlignment.RIGHT,
		}));
	}

	private getEntryProps(): IStatusbarEntry {
		return {
			name: localize('copilotPrototypeShellCoinEntry', "Prototype Coin"),
			text: '$(circle-large-filled)',
			ariaLabel: localize('copilotPrototypeShellCoinEntryAria', "Prototype Coin"),
			tooltip: {
				element: token => this.renderTooltip(token),
			},
			command: ShowTooltipCommand,
		};
	}

	private getDashboardEntryProps(): IStatusbarEntry {
		return {
			name: localize('copilotPrototypeDashboardEntry', "Copilot Dashboard"),
			text: '$(copilot)',
			ariaLabel: localize('copilotPrototypeDashboardEntryAria', "Copilot Dashboard"),
			tooltip: {
				element: token => this.renderDashboard(token),
			},
			command: ShowTooltipCommand,
		};
	}

	private setActiveCell(sku: string, state: string): void {
		this._activeSku = sku;
		this._activeState = state;
		// Update the dashboard entry so next tooltip render uses new state
		this._dashboardEntryAccessor.update(this.getDashboardEntryProps());
	}

	private static readonly SKUS = ['Edu/Free', 'Pro/Pro+ No O', 'Pro/Pro+', 'Max', 'Ent/Bus ULB', 'Ent/Bus'];
	private static readonly STATES = ['First Time', 'Default', 'Session Approached', 'Session Reached', 'Weekly Approached', 'Weekly Reached', 'Overage Approached', 'Overage Reached'];
	private static readonly EXCLUDED_CELLS: ReadonlySet<string> = new Set([
		'Edu/Free|Overage Approached',
		'Edu/Free|Overage Reached',
		'Pro/Pro+ No O|Overage Approached',
		'Pro/Pro+ No O|Overage Reached',
		'Max|Session Approached',
		'Max|Session Reached',
		'Ent/Bus ULB|First Time',
		'Ent/Bus ULB|Session Approached',
		'Ent/Bus ULB|Session Reached',
		'Ent/Bus ULB|Weekly Approached',
		'Ent/Bus ULB|Weekly Reached',
		'Ent/Bus ULB|Overage Approached',
		'Ent/Bus ULB|Overage Reached',
		'Ent/Bus|First Time',
		'Ent/Bus|Session Approached',
		'Ent/Bus|Session Reached',
		'Ent/Bus|Weekly Approached',
		'Ent/Bus|Weekly Reached',
		'Ent/Bus|Overage Approached',
		'Ent/Bus|Overage Reached',
	]);

	private renderTooltip(token: CancellationToken): HTMLElement {
		const disposables = new DisposableStore();
		disposables.add(token.onCancellationRequested(() => disposables.dispose()));

		const container = mainWindow.document.createElement('div');
		container.className = 'copilot-prototype-coin-widget';

		const title = mainWindow.document.createElement('div');
		title.className = 'copilot-prototype-coin-widget-title';
		title.textContent = localize('copilotPrototypeShellCoinWidgetTitle', "Prototype Coin");

		// Grid: SKU columns x State rows
		const skus = CopilotPrototypeShellCoinStatusBarContribution.SKUS;
		const states = CopilotPrototypeShellCoinStatusBarContribution.STATES;

		const grid = mainWindow.document.createElement('div');
		grid.className = 'copilot-prototype-coin-grid';
		grid.style.gridTemplateColumns = `auto repeat(${skus.length}, 1fr)`;
		grid.style.gridTemplateRows = `auto repeat(${states.length}, 1fr)`;

		// Top-left corner: empty cell
		const corner = mainWindow.document.createElement('div');
		corner.className = 'copilot-prototype-coin-grid-corner';
		corner.textContent = localize('copilotPrototypeShellCoinGridStates', "States \\ SKU");
		grid.appendChild(corner);

		// Column headers (SKU) — as links
		for (const sku of skus) {
			const header = mainWindow.document.createElement('div');
			header.className = 'copilot-prototype-coin-grid-col-header';
			const link = mainWindow.document.createElement('a');
			link.className = 'copilot-prototype-coin-grid-link';
			link.textContent = sku;
			link.tabIndex = 0;
			link.role = 'button';
			header.appendChild(link);
			grid.appendChild(header);
		}

		// Rows
		for (const state of states) {
			// Row header (State)
			const rowHeader = mainWindow.document.createElement('div');
			rowHeader.className = 'copilot-prototype-coin-grid-row-header';
			rowHeader.textContent = state;
			grid.appendChild(rowHeader);

			// Grid cells: unlabeled buttons (skip excluded intersections)
			for (const sku of skus) {
				const cell = mainWindow.document.createElement('div');
				cell.className = 'copilot-prototype-coin-grid-cell';
				const cellKey = `${sku}|${state}`;
				if (!CopilotPrototypeShellCoinStatusBarContribution.EXCLUDED_CELLS.has(cellKey)) {
					const btn = disposables.add(new Button(cell, {
						...defaultButtonStyles,
						secondary: true,
					}));
					btn.label = '';
					disposables.add(btn.onDidClick(() => {
						this.setActiveCell(sku, state);
					}));
				}
				grid.appendChild(cell);
			}
		}

		container.append(title, grid);
		return container;
	}

	private renderDashboard(token: CancellationToken): HTMLElement {
		const disposables = new DisposableStore();
		disposables.add(token.onCancellationRequested(() => disposables.dispose()));

		const sku = this._activeSku;
		const state = this._activeState;

		const dashboard = $('div.copilot-prototype-dashboard');

		// Header row: title + settings gear
		const header = append(dashboard, $('div.copilot-prototype-dashboard-header'));
		const titleText = append(header, $('div.copilot-prototype-dashboard-title'));
		titleText.textContent = localize('dashboardTitle', "Copilot Free Usage");

		const settingsIcon = append(header, $('div.copilot-prototype-dashboard-tab'));
		settingsIcon.append(...renderLabelWithIcons('$(settings-gear)'));
		settingsIcon.title = localize('settings', "Settings");
		settingsIcon.tabIndex = 0;

		// Tab content wrapper (grid overlap so both tabs size the container)
		const contentWrapper = append(dashboard, $('div.copilot-prototype-dashboard-content-wrapper'));
		const copilotContent = append(contentWrapper, $('div.copilot-prototype-dashboard-content.active'));
		const inlineContent = append(contentWrapper, $('div.copilot-prototype-dashboard-content'));

		// === Copilot Tab Content ===
		this.renderCopilotTab(copilotContent, disposables, sku, state);

		// === Inline Suggestions Tab Content ===
		this.renderInlineTab(inlineContent, disposables, sku, state);

		// Bottom tab bar
		const tabBar = append(dashboard, $('div.copilot-prototype-dashboard-bottom-tabs'));
		const copilotTabBtn = append(tabBar, $('div.copilot-prototype-dashboard-tab.active'));
		copilotTabBtn.append(...renderLabelWithIcons('$(comment-discussion)'));
		copilotTabBtn.title = localize('copilotTab', "Copilot");
		copilotTabBtn.tabIndex = 0;
		copilotTabBtn.role = 'tab';

		const inlineTabBtn = append(tabBar, $('div.copilot-prototype-dashboard-tab'));
		inlineTabBtn.append(...renderLabelWithIcons('$(lightbulb-sparkle)'));
		inlineTabBtn.title = localize('inlineTab', "Inline Suggestions");
		inlineTabBtn.tabIndex = 0;
		inlineTabBtn.role = 'tab';

		// Tab switching
		copilotTabBtn.addEventListener('click', () => {
			copilotTabBtn.classList.add('active');
			inlineTabBtn.classList.remove('active');
			copilotContent.classList.add('active');
			inlineContent.classList.remove('active');
		});
		inlineTabBtn.addEventListener('click', () => {
			inlineTabBtn.classList.add('active');
			copilotTabBtn.classList.remove('active');
			inlineContent.classList.add('active');
			copilotContent.classList.remove('active');
		});

		return dashboard;
	}

	private renderCopilotTab(content: HTMLElement, disposables: DisposableStore, _sku: string, state: string): void {
		if (state === 'Session Approached') {
			// Session Limit at 90% — warning state
			this.createGauge(content, localize('sessionUsed90', "90% Used"), 90, localize('sessionResetBold', "**Session Limit** Resets today at 10:00am"), false, 'warning');

			// Warning callout
			const warning = append(content, $('div.copilot-prototype-dashboard-warning'));
			const warningIcon = append(warning, $('span.copilot-prototype-dashboard-warning-icon'));
			warningIcon.append(...renderLabelWithIcons('$(warning)'));
			const warningBody = append(warning, $('span.copilot-prototype-dashboard-warning-text'));
			warningBody.appendChild(mainWindow.document.createTextNode(localize('sessionApproachWarning', "Copilot will be paused when the session limit is reached. ")));
			const learnMore = append(warningBody, $('a.copilot-prototype-coin-grid-link'));
			learnMore.textContent = localize('learnMore', "Learn more");
			learnMore.tabIndex = 0;
			learnMore.role = 'link';
		} else if (state === 'Session Reached') {
			// Session Limit at 100% — error state
			this.createGauge(content, localize('sessionUsed100', "100% Used"), 100, localize('sessionResetBoldReached', "**Session Limit** Resets today at 10:00am"), false, 'error');

			// Error callout
			const warning = append(content, $('div.copilot-prototype-dashboard-warning'));
			const warningIcon = append(warning, $('span.copilot-prototype-dashboard-warning-icon.error'));
			warningIcon.append(...renderLabelWithIcons('$(error)'));
			const warningBody = append(warning, $('span.copilot-prototype-dashboard-warning-text'));
			warningBody.appendChild(mainWindow.document.createTextNode(localize('sessionReachedWarning', "Copilot is paused until the session limit resets. ")));
			const learnMore = append(warningBody, $('a.copilot-prototype-coin-grid-link'));
			learnMore.textContent = localize('learnMore', "Learn more");
			learnMore.tabIndex = 0;
			learnMore.role = 'link';
		} else if (state === 'Weekly Reached') {
			// Session Limit unavailable when weekly limit is reached
			this.createGauge(content, localize('sessionUnavailable', "Unavailable"), 0, localize('sessionResetWithWeekly', "**Session Limit** Resets with Weekly Limit"), true);
		} else {
			// Default: Session Limit at 18%
			this.createGauge(content, localize('sessionUsed', "18% Used"), 18, localize('sessionResetBoldDefault', "**Session Limit** Resets today at 10:00am"));
		}

		// Weekly Limit
		if (state === 'Weekly Approached') {
			this.createGauge(content, localize('weeklyUsed90', "90% Used"), 90, localize('weeklyResetBoldApproached', "**Weekly Limit** Resets on April 6th"), false, 'warning');

			// Warning callout
			const weeklyWarning = append(content, $('div.copilot-prototype-dashboard-warning'));
			const weeklyWarningIcon = append(weeklyWarning, $('span.copilot-prototype-dashboard-warning-icon'));
			weeklyWarningIcon.append(...renderLabelWithIcons('$(warning)'));
			const weeklyWarningBody = append(weeklyWarning, $('span.copilot-prototype-dashboard-warning-text'));
			weeklyWarningBody.appendChild(mainWindow.document.createTextNode(localize('weeklyApproachWarning', "Copilot will be paused when the weekly limit is reached. ")));
			const weeklyLearnMore = append(weeklyWarningBody, $('a.copilot-prototype-coin-grid-link'));
			weeklyLearnMore.textContent = localize('learnMore', "Learn more");
			weeklyLearnMore.tabIndex = 0;
			weeklyLearnMore.role = 'link';
		} else if (state === 'Weekly Reached') {
			this.createGauge(content, localize('weeklyUsed100', "100% Used"), 100, localize('weeklyResetBoldReached', "**Weekly Limit** Resets on April 6th"), false, 'error');

			// Error callout
			const weeklyError = append(content, $('div.copilot-prototype-dashboard-warning'));
			const weeklyErrorIcon = append(weeklyError, $('span.copilot-prototype-dashboard-warning-icon.error'));
			weeklyErrorIcon.append(...renderLabelWithIcons('$(error)'));
			const weeklyErrorBody = append(weeklyError, $('span.copilot-prototype-dashboard-warning-text'));
			weeklyErrorBody.appendChild(mainWindow.document.createTextNode(localize('weeklyReachedWarning', "Copilot is paused until the weekly limit resets. ")));
			const weeklyLearnMore2 = append(weeklyErrorBody, $('a.copilot-prototype-coin-grid-link'));
			weeklyLearnMore2.textContent = localize('learnMore', "Learn more");
			weeklyLearnMore2.tabIndex = 0;
			weeklyLearnMore2.role = 'link';
		} else {
			this.createGauge(content, localize('weeklyUsed', "56% Used"), 56, localize('weeklyResetBold', "**Weekly Limit** Resets on April 6th"));
		}

		// Overage Spend (unavailable)
		this.createGauge(content, localize('unavailable', "Unavailable"), 0, localize('overageDescBold', "**Overage Spend** Available for Pro and Pro+ users"), true);

		// Action buttons
		const actions = append(content, $('div.copilot-prototype-dashboard-actions'));
		const upgradeBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		upgradeBtn.label = localize('upgradeToPro', "Upgrade to Pro");

		const overageBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		overageBtn.label = localize('configureOverages', "Configure Overages");
		overageBtn.enabled = false;
	}

	private renderInlineTab(content: HTMLElement, disposables: DisposableStore, _sku: string, _state: string): void {
		// Inline Suggestions gauge
		this.createGauge(content, localize('inlineUsed', "12% Used"), 12, localize('inlineResetBold', "**Inline Suggestions** Resets on May 1st"));

		// Settings section
		const settings = append(content, $('div.copilot-prototype-dashboard-settings'));

		// Checkboxes
		const allFilesCheckbox = disposables.add(new Checkbox(localize('allFiles', "All files"), true, { ...defaultCheckboxStyles }));
		const allFilesRow = append(settings, $('div.copilot-prototype-dashboard-setting-row'));
		allFilesRow.appendChild(allFilesCheckbox.domNode);
		append(allFilesRow, $('span.copilot-prototype-dashboard-setting-label')).textContent = localize('allFiles', "All files");

		const tsCheckbox = disposables.add(new Checkbox(localize('typescript', "TypeScript"), true, { ...defaultCheckboxStyles }));
		const tsRow = append(settings, $('div.copilot-prototype-dashboard-setting-row'));
		tsRow.appendChild(tsCheckbox.domNode);
		append(tsRow, $('span.copilot-prototype-dashboard-setting-label')).textContent = localize('typescript', "TypeScript");

		const nesCheckbox = disposables.add(new Checkbox(localize('nextEditSuggestions', "Next edit suggestions"), true, { ...defaultCheckboxStyles }));
		const nesRow = append(settings, $('div.copilot-prototype-dashboard-setting-row'));
		nesRow.appendChild(nesCheckbox.domNode);
		append(nesRow, $('span.copilot-prototype-dashboard-setting-label')).textContent = localize('nextEditSuggestions', "Next edit suggestions");

		// Eagerness selector
		const eagernessRow = append(settings, $('div.copilot-prototype-dashboard-eagerness'));
		append(eagernessRow, $('span.copilot-prototype-dashboard-setting-label')).textContent = localize('eagerness', "Eagerness");
		const eagernessOptions = ['Auto', 'Low', 'Medium', 'High'];
		const eagernessGroup = append(eagernessRow, $('div.copilot-prototype-dashboard-eagerness-group'));
		for (const opt of eagernessOptions) {
			const optBtn = disposables.add(new Button(eagernessGroup, {
				...defaultButtonStyles,
				secondary: true,
			}));
			optBtn.label = opt;
			if (opt === 'Auto') {
				optBtn.element.classList.add('active');
			}
		}

		// Snooze
		const snoozeRow = append(settings, $('div.copilot-prototype-dashboard-snooze'));
		const snoozeBtn = disposables.add(new Button(snoozeRow, { ...defaultButtonStyles, secondary: true }));
		snoozeBtn.label = localize('snooze', "Snooze");
		append(snoozeRow, $('span.copilot-prototype-dashboard-snooze-label')).textContent = localize('hideSuggestions', "Hide suggestions for 5 min");
	}

	private createGauge(container: HTMLElement, label: string, percentage: number, description: string, disabled?: boolean, severity?: 'warning' | 'error'): void {
		const gauge = append(container, $('div.copilot-prototype-dashboard-gauge'));
		if (disabled) {
			gauge.classList.add('disabled');
		}
		if (severity) {
			gauge.classList.add(severity);
		}

		// Label
		const labelRow = append(gauge, $('div.copilot-prototype-dashboard-gauge-label'));
		labelRow.textContent = label;

		// Progress bar
		const barContainer = append(gauge, $('div.copilot-prototype-dashboard-gauge-bar'));
		const bar = append(barContainer, $('div.copilot-prototype-dashboard-gauge-bar-fill'));
		bar.style.width = `${percentage}%`;

		// Description — supports **bold** markers
		const desc = append(gauge, $('div.copilot-prototype-dashboard-gauge-desc'));
		const parts = description.split('**');
		for (let i = 0; i < parts.length; i++) {
			if (i % 2 === 1) {
				append(desc, $('strong')).textContent = parts[i];
			} else if (parts[i]) {
				desc.appendChild(mainWindow.document.createTextNode(parts[i]));
			}
		}
	}
}

registerWorkbenchContribution2(CopilotPrototypeShellContribution.ID, CopilotPrototypeShellContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(CopilotPrototypeShellCoinStatusBarContribution.ID, CopilotPrototypeShellCoinStatusBarContribution, WorkbenchPhase.AfterRestored);
