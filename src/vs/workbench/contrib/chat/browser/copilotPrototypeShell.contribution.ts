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
	private _bannerElement: HTMLElement | undefined;
	private _bannerDismissed = false;
	private _warningCardElement: HTMLElement | undefined;

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
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

		// Intercept chat submission in reached states
		this.setupInputInterceptor();
	}

	private setupInputInterceptor(): void {
		const tryAttach = () => {
			const container = this.layoutService.getContainer(mainWindow);
			const auxBar = container.querySelector('.part.auxiliarybar');
			if (!auxBar) {
				setTimeout(tryAttach, 1000);
				return;
			}

				// Capture-phase listener to intercept before the chat widget processes it
			auxBar.addEventListener('keydown', (e) => {
				if (this.isInputBlocked() && (e as KeyboardEvent).key === 'Enter' && !(e as KeyboardEvent).shiftKey) {
					const target = e.target as HTMLElement;
					if (target.closest('.chat-editor-container') || target.closest('.chat-input-container')) {
						e.preventDefault();
						e.stopPropagation();
					}
				}
			}, true);

			// Also intercept clicks on the send/execute button
			auxBar.addEventListener('click', (e) => {
				if (this.isInputBlocked()) {
					const target = e.target as HTMLElement;
					if (target.closest('.chat-execute-toolbar')) {
						e.preventDefault();
						e.stopPropagation();
					}
				}
			}, true);
		};
		tryAttach();
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
		const hasOverage = this._activeSku === 'Pro/Pro+' || this._activeSku === 'Max';
		// For Pro with overage, only show warning/error icons for overage states
		const isWarning = !this._bannerDismissed && (
			hasOverage
				? this._activeState === 'Overage Approached'
				: this._activeState.includes('Approached')
		);
		const isError = !this._bannerDismissed && (
			hasOverage
				? this._activeState === 'Overage Reached'
				: this._activeState.includes('Reached')
		);
		let text = '$(copilot)';
		if (isWarning) {
			text = '$(copilot-warning)';
		} else if (isError) {
			text = '$(copilot-error)';
		}
		return {
			name: localize('copilotPrototypeDashboardEntry', "Copilot Dashboard"),
			text,
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
		this._bannerDismissed = false;
		// Update the dashboard entry so next tooltip render uses new state
		this._dashboardEntryAccessor.update(this.getDashboardEntryProps());
		// Clear any existing warning card
		this.clearWarningCard();
		// Clear any existing banner
		this.clearBanner();
		// Show the right UI for the state
		const hasOverage = sku === 'Pro/Pro+' || sku === 'Max';
		if (hasOverage) {
			// Pro with overage: only block/warn for overage states
			if (state === 'Overage Reached') {
				this.showWarningCard();
			} else if (state === 'Overage Approached') {
				this.updateBanner(state);
			}
		} else if (state.includes('Reached')) {
			this.showWarningCard();
		} else if (state.includes('Approached')) {
			this.updateBanner(state);
		}
	}

	private isInputBlocked(): boolean {
		const hasOverage = this._activeSku === 'Pro/Pro+' || this._activeSku === 'Max';
		if (hasOverage) {
			// Pro with overage: only block when overage is exhausted
			return this._activeState === 'Overage Reached';
		}
		return this._activeState.includes('Reached');
	}

	private getBannerMessage(state: string): string | undefined {
		switch (state) {
			case 'Session Approached':
				return localize('bannerSessionApproach', "Approaching session limit. Resets at 10:00am.");
			case 'Weekly Approached':
				return localize('bannerWeeklyApproach', "Approaching weekly limit. Resets on April 6th.");
			case 'Overage Approached':
				return localize('bannerOverageApproach', "Approaching overage spend limit. Resets on May 1st.");
			default:
				return undefined;
		}
	}

	private updateBanner(state: string): void {
		const message = this.getBannerMessage(state);
		const container = this.layoutService.getContainer(mainWindow);

		if (!message) {
			this.clearBanner();
			return;
		}

		// Find the tip container in the aux bar (same slot as getting-started tips)
		const tipContainer = container.querySelector('.part.auxiliarybar .chat-getting-started-tip-container');
		if (!tipContainer) {
			return;
		}

		// Create or update the banner
		if (!this._bannerElement) {
			this._bannerElement = mainWindow.document.createElement('div');
			this._bannerElement.className = 'copilot-prototype-chat-banner';
		}

		// Clear and re-render content
		this._bannerElement.textContent = '';

		const text = mainWindow.document.createElement('span');
		text.className = 'copilot-prototype-chat-banner-text';
		text.textContent = message;

		const dismiss = mainWindow.document.createElement('span');
		dismiss.className = 'copilot-prototype-chat-banner-dismiss';
		dismiss.append(...renderLabelWithIcons('$(close)'));
		dismiss.tabIndex = 0;
		dismiss.role = 'button';
		dismiss.title = localize('dismiss', "Dismiss");
		dismiss.addEventListener('click', () => {
			this.clearBanner();
			// Reset status bar icon to default copilot
			this._bannerDismissed = true;
			this._dashboardEntryAccessor.update(this.getDashboardEntryProps());
		});

		this._bannerElement.append(text, dismiss);

		// Insert into the tip container and make it visible
		if (!this._bannerElement.parentElement) {
			tipContainer.appendChild(this._bannerElement);
			(tipContainer as HTMLElement).style.display = '';
		}
	}

	private clearBanner(): void {
		if (this._bannerElement) {
			const tipContainer = this._bannerElement.parentElement;
			this._bannerElement.remove();
			this._bannerElement = undefined;
			if (tipContainer && tipContainer.children.length === 0) {
				(tipContainer as HTMLElement).style.display = 'none';
			}
		}
	}

	private clearWarningCard(): void {
		if (this._warningCardElement) {
			const tipContainer = this._warningCardElement.parentElement;
			this._warningCardElement.remove();
			this._warningCardElement = undefined;
			if (tipContainer && tipContainer.children.length === 0) {
				(tipContainer as HTMLElement).style.display = 'none';
			}
		}
	}

	private showWarningCard(): void {
		const content = this.getInlineWarningContent();
		if (!content) {
			return;
		}

		const container = this.layoutService.getContainer(mainWindow);
		const tipContainer = container.querySelector('.part.auxiliarybar .chat-getting-started-tip-container') as HTMLElement | null;
		if (!tipContainer) {
			return;
		}

		this.clearWarningCard();

		const card = mainWindow.document.createElement('div');
		card.className = 'copilot-prototype-inline-warning';

		const header = mainWindow.document.createElement('div');
		header.className = 'copilot-prototype-inline-warning-header';
		const headerIcon = mainWindow.document.createElement('span');
		headerIcon.className = 'copilot-prototype-inline-warning-icon';
		headerIcon.append(...renderLabelWithIcons('$(warning)'));
		const headerTitle = mainWindow.document.createElement('span');
		headerTitle.className = 'copilot-prototype-inline-warning-title';
		headerTitle.textContent = content.title;
		header.append(headerIcon, headerTitle);

		const desc = mainWindow.document.createElement('div');
		desc.className = 'copilot-prototype-inline-warning-desc';
		desc.textContent = content.description;

		const btnContainer = mainWindow.document.createElement('div');
		btnContainer.className = 'copilot-prototype-inline-warning-actions';
		const btn = mainWindow.document.createElement('button');
		btn.className = 'copilot-prototype-inline-warning-btn';
		btn.textContent = content.buttonLabel;
		btnContainer.appendChild(btn);

		if (content.secondaryButtonLabel) {
			const secondaryBtn = mainWindow.document.createElement('button');
			secondaryBtn.className = 'copilot-prototype-inline-warning-btn secondary';
			secondaryBtn.textContent = content.secondaryButtonLabel;
			btnContainer.appendChild(secondaryBtn);
		}

		card.append(header, desc, btnContainer);
		this._warningCardElement = card;
		tipContainer.appendChild(card);
		tipContainer.style.display = '';
	}

	private getInlineWarningContent(): { title: string; description: string; buttonLabel: string; secondaryButtonLabel?: string } | undefined {
		const sku = this._activeSku;
		const state = this._activeState;

		if (state === 'Session Reached') {
			if (sku === 'Edu/Free') {
				return {
					title: localize('inlineSessionReachedTitle', "You've reached your session limit."),
					description: localize('inlineSessionReachedDescFree', "Your session limit resets at 10:00am. Upgrade for higher limits."),
					buttonLabel: localize('upgrade', "Upgrade"),
				};
			}
			if (sku === 'Pro/Pro+ No O') {
				return {
					title: localize('inlineSessionReachedTitle', "You've reached your session limit."),
					description: localize('inlineSessionReachedDescProNoO', "Your session limit resets at 10:00am. Configure overages to continue using Copilot."),
					buttonLabel: localize('configureOverage', "Configure Overage"),
					secondaryButtonLabel: localize('upgrade', "Upgrade"),
				};
			}
			return {
				title: localize('inlineSessionReachedTitle', "You've reached your session limit."),
				description: localize('inlineSessionReachedDescPro', "Your session limit resets at 10:00am."),
				buttonLabel: localize('learnMore', "Learn more"),
			};
		}

		if (state === 'Weekly Reached') {
			if (sku === 'Edu/Free') {
				return {
					title: localize('inlineWeeklyReachedTitle', "You've reached your weekly limit."),
					description: localize('inlineWeeklyReachedDescFree', "Your weekly limit resets on April 6th. Upgrade for higher limits."),
					buttonLabel: localize('upgrade', "Upgrade"),
				};
			}
			if (sku === 'Pro/Pro+ No O') {
				return {
					title: localize('inlineWeeklyReachedTitle', "You've reached your weekly limit."),
					description: localize('inlineWeeklyReachedDescProNoO', "Your weekly limit resets on April 6th. Configure overages to continue using Copilot."),
					buttonLabel: localize('configureOverage', "Configure Overage"),
					secondaryButtonLabel: localize('upgrade', "Upgrade"),
				};
			}
			return {
				title: localize('inlineWeeklyReachedTitle', "You've reached your weekly limit."),
				description: localize('inlineWeeklyReachedDescPro', "Your weekly limit resets on April 6th. Increase overages budget to continue using premium models."),
				buttonLabel: localize('increaseBudget', "Increase Budget"),
			};
		}

		if (state === 'Overage Reached') {
			return {
				title: localize('inlineOverageReachedTitle', "You've reached your overage budget."),
				description: localize('inlineOverageReachedDesc', "Copilot usage is paused until overage budget is increased or limits reset."),
				buttonLabel: localize('editOverage', "Edit Overage"),
				secondaryButtonLabel: localize('upgradeIncreaseLimits', "Upgrade to Increase Limits"),
			};
		}

		return undefined;
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

		// Header row: title + icons
		const header = append(dashboard, $('div.copilot-prototype-dashboard-header'));
		const titleText = append(header, $('div.copilot-prototype-dashboard-title'));
		const isPro = sku !== 'Edu/Free';
		titleText.textContent = isPro ? localize('dashboardTitlePro', "Copilot  Pro  Usage") : localize('dashboardTitle', "Copilot Free Usage");

		const headerActions = append(header, $('div.copilot-prototype-dashboard-header-actions'));
		const cardIcon = append(headerActions, $('div.copilot-prototype-dashboard-tab'));
		cardIcon.append(...renderLabelWithIcons('$(credit-card)'));
		cardIcon.title = localize('billing', "Billing");
		cardIcon.tabIndex = 0;
		const settingsIcon = append(headerActions, $('div.copilot-prototype-dashboard-tab'));
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

	private renderCopilotTab(content: HTMLElement, disposables: DisposableStore, sku: string, state: string): void {
		const isPro = sku !== 'Edu/Free';
		const hasOverage = sku === 'Pro/Pro+' || sku === 'Max';

		// Pro/Pro+ with overage has fundamentally different behavior:
		// limits don't block — overage kicks in instead. Only overage exhaustion blocks.
		if (hasOverage) {
			this.renderProOverageCopilotTab(content, disposables, state);
			return;
		}

		// Session Limit
		if (state === 'Session Approached') {
			this.createGauge(content, localize('sessionUsed90', "90% Used"), 90, localize('sessionResetBold', "**Session Limit** Resets today at 10:00am"), false, 'warning');
			const warning = append(content, $('div.copilot-prototype-dashboard-warning'));
			const warningIcon = append(warning, $('span.copilot-prototype-dashboard-warning-icon'));
			warningIcon.append(...renderLabelWithIcons('$(warning)'));
			const warningBody = append(warning, $('span.copilot-prototype-dashboard-warning-text'));
			if (isPro) {
				warningBody.appendChild(mainWindow.document.createTextNode(localize('sessionApproachWarningPro', "Copilot will pause at the limit. Upgrade or configure overages to continue. ")));
			} else {
				warningBody.appendChild(mainWindow.document.createTextNode(localize('sessionApproachWarning', "Copilot will pause when the limit is reached. ")));
			}
			const learnMore = append(warningBody, $('a.copilot-prototype-coin-grid-link'));
			learnMore.textContent = localize('learnMore', "Learn more");
			learnMore.tabIndex = 0;
			learnMore.role = 'link';
		} else if (state === 'Session Reached') {
			this.createGauge(content, localize('sessionUsed100', "100% Used"), 100, localize('sessionResetBoldReached', "**Session Limit** Resets today at 10:00am"), false, 'error');
			const warning = append(content, $('div.copilot-prototype-dashboard-warning'));
			const warningIcon = append(warning, $('span.copilot-prototype-dashboard-warning-icon.error'));
			warningIcon.append(...renderLabelWithIcons('$(error)'));
			const warningBody = append(warning, $('span.copilot-prototype-dashboard-warning-text'));
			if (isPro) {
				warningBody.appendChild(mainWindow.document.createTextNode(localize('sessionReachedWarningPro', "Paused until limit resets. Upgrade or configure overages to continue. ")));
			} else {
				warningBody.appendChild(mainWindow.document.createTextNode(localize('sessionReachedWarning', "Paused until the session limit resets. ")));
			}
			const learnMore = append(warningBody, $('a.copilot-prototype-coin-grid-link'));
			learnMore.textContent = localize('learnMore', "Learn more");
			learnMore.tabIndex = 0;
			learnMore.role = 'link';
		} else if (state === 'Weekly Reached') {
			this.createGauge(content, localize('sessionUnavailable', "Unavailable"), 0, localize('sessionResetWithWeekly', "**Session Limit** Resets with Weekly Limit"), true);
		} else {
			this.createGauge(content, localize('sessionUsed', "18% Used"), 18, localize('sessionResetBoldDefault', "**Session Limit** Resets today at 10:00am"));
		}

		// Weekly Limit
		if (state === 'Weekly Approached') {
			this.createGauge(content, localize('weeklyUsed90', "90% Used"), 90, localize('weeklyResetBoldApproached', "**Weekly Limit** Resets on April 6th"), false, 'warning');
			const weeklyWarning = append(content, $('div.copilot-prototype-dashboard-warning'));
			const weeklyWarningIcon = append(weeklyWarning, $('span.copilot-prototype-dashboard-warning-icon'));
			weeklyWarningIcon.append(...renderLabelWithIcons('$(warning)'));
			const weeklyWarningBody = append(weeklyWarning, $('span.copilot-prototype-dashboard-warning-text'));
			if (isPro) {
				weeklyWarningBody.appendChild(mainWindow.document.createTextNode(localize('weeklyApproachWarningPro', "Copilot will pause at the limit. Upgrade or configure overages to continue. ")));
			} else {
				weeklyWarningBody.appendChild(mainWindow.document.createTextNode(localize('weeklyApproachWarning', "Copilot will pause when the limit is reached. ")));
			}
			const weeklyLearnMore = append(weeklyWarningBody, $('a.copilot-prototype-coin-grid-link'));
			weeklyLearnMore.textContent = localize('learnMore', "Learn more");
			weeklyLearnMore.tabIndex = 0;
			weeklyLearnMore.role = 'link';
		} else if (state === 'Weekly Reached') {
			this.createGauge(content, localize('weeklyUsed100', "100% Used"), 100, localize('weeklyResetBoldReached', "**Weekly Limit** Resets on April 6th"), false, 'error');
			const weeklyError = append(content, $('div.copilot-prototype-dashboard-warning'));
			const weeklyErrorIcon = append(weeklyError, $('span.copilot-prototype-dashboard-warning-icon.error'));
			weeklyErrorIcon.append(...renderLabelWithIcons('$(error)'));
			const weeklyErrorBody = append(weeklyError, $('span.copilot-prototype-dashboard-warning-text'));
			if (isPro) {
				weeklyErrorBody.appendChild(mainWindow.document.createTextNode(localize('weeklyReachedWarningPro', "Paused until limit resets. Upgrade or configure overages to continue. ")));
			} else {
				weeklyErrorBody.appendChild(mainWindow.document.createTextNode(localize('weeklyReachedWarning', "Paused until the weekly limit resets. ")));
			}
			const weeklyLearnMore2 = append(weeklyErrorBody, $('a.copilot-prototype-coin-grid-link'));
			weeklyLearnMore2.textContent = localize('learnMore', "Learn more");
			weeklyLearnMore2.tabIndex = 0;
			weeklyLearnMore2.role = 'link';
		} else {
			this.createGauge(content, localize('weeklyUsed', "56% Used"), 56, localize('weeklyResetBold', "**Weekly Limit** Resets on April 6th"));
		}

		// Overage Spend
		if (isPro && !hasOverage) {
			// Pro/Pro+ No O: not configured
			this.createGauge(content, localize('notConfigured', "Not Configured"), 0, localize('overageSpendBold', "**Overage Spend**"), true);
		} else if (!isPro) {
			// Edu/Free: unavailable
			this.createGauge(content, localize('unavailable', "Unavailable"), 0, localize('overageDescBold', "**Overage Spend** Available for Pro and Pro+ users"), true);
		} else {
			// Pro/Pro+ with overage
			this.createGauge(content, localize('overageConfigured', "Configured"), 0, localize('overageSpendBold', "**Overage Spend**"));
		}

		// Action buttons — SKU-aware
		const actions = append(content, $('div.copilot-prototype-dashboard-actions'));
		if (isPro && !hasOverage) {
			const configOverageBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			configOverageBtn.label = localize('configureOverage', "Configure Overage");
			const upgradeLimitsBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			upgradeLimitsBtn.label = localize('upgrade', "Upgrade");
			upgradeLimitsBtn.enabled = false;
		} else if (!isPro) {
			const upgradeBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			upgradeBtn.label = localize('upgrade', "Upgrade");
			const overageBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			overageBtn.label = localize('configureOverages', "Configure Overages");
			overageBtn.enabled = false;
		} else {
			const configBudgetBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			configBudgetBtn.label = localize('configureOverageBudget', "Configure Overage Budget");
		}
	}

	private renderProOverageCopilotTab(content: HTMLElement, disposables: DisposableStore, state: string): void {
		const isOverageInUse = state === 'Session Reached' || state === 'Weekly Reached' || state === 'Overage Approached' || state === 'Overage Reached';

		// Session Limit
		if (state === 'Session Approached') {
			this.createGauge(content, localize('sessionUsed90', "90% Used"), 90, localize('sessionResetBoldApproached', "**Session Limit.** Resets today at 10:00am."));
			this.createInfoMessage(content, localize('proSessionApproachInfo', "Once session limit is reached, you will use overage spend until limit resets."));
		} else if (state === 'Session Reached') {
			this.createGauge(content, localize('sessionUsed100', "100% Used"), 100, localize('sessionResetBoldReached', "**Session Limit.** Resets today at 10:00am."));
			this.createInfoMessage(content, localize('proSessionReachedInfo', "Using overage budget until Session limit resets."));
		} else if (state === 'Weekly Reached' || state === 'Overage Approached' || state === 'Overage Reached') {
			this.createGauge(content, localize('sessionUnavailable', "Unavailable"), 0, localize('sessionResetWithWeekly', "**Session Limit.** Resets with Weekly Limit"), true);
		} else {
			this.createGauge(content, localize('sessionUsed', "18% Used"), 18, localize('sessionResetBoldDefault', "**Session Limit** Resets today at 10:00 AM"));
		}

		// Weekly Limit
		if (state === 'Weekly Approached') {
			this.createGauge(content, localize('weeklyUsed90', "90% Used"), 90, localize('weeklyResetBoldApproached', "**Weekly Limit** Resets on April 6th"));
			this.createInfoMessage(content, localize('proWeeklyApproachInfo', "Once weekly limit is reached, you will use overage spend until limit resets."));
		} else if (state === 'Weekly Reached') {
			this.createGauge(content, localize('weeklyUsed100', "100% Used"), 100, localize('weeklyResetBoldReached', "**Weekly Limit** Resets on April 6th"));
			this.createInfoMessage(content, localize('proWeeklyReachedInfo', "Using overage budget until Weekly limit resets."));
		} else if (state === 'Overage Approached' || state === 'Overage Reached') {
			this.createGauge(content, localize('weeklyUsed100', "100% Used"), 100, localize('weeklyResetBoldReached', "**Weekly Limit** Resets on April 6th"));
		} else {
			this.createGauge(content, localize('weeklyUsed', "56% Used"), 56, localize('weeklyResetBold', "**Weekly Limit** Resets on April 6th"));
		}

		// Overage Spend — with "In use" / "Not in use" status
		if (state === 'Overage Reached') {
			this.createGauge(content, localize('overageUsed100', "100% Used"), 100, localize('overageResetBold', "**Overage Spend** Resets on May 1st"), false, 'error', localize('inUse', "In use"));
			const warning = append(content, $('div.copilot-prototype-dashboard-warning'));
			const warningIcon = append(warning, $('span.copilot-prototype-dashboard-warning-icon'));
			warningIcon.append(...renderLabelWithIcons('$(warning)'));
			const warningBody = append(warning, $('span.copilot-prototype-dashboard-warning-text'));
			warningBody.appendChild(mainWindow.document.createTextNode(localize('proOverageReachedWarning', "Copilot usage is paused until Overage budget is increased or limits reset. ")));
			const learnMore = append(warningBody, $('a.copilot-prototype-coin-grid-link'));
			learnMore.textContent = localize('learnMore', "Learn more");
			learnMore.tabIndex = 0;
			learnMore.role = 'link';
		} else if (state === 'Overage Approached') {
			this.createGauge(content, localize('overageUsed90', "90% Used"), 90, localize('overageResetBold', "**Overage Spend** Resets on May 1st"), false, 'warning', localize('inUse', "In use"));
			const warning = append(content, $('div.copilot-prototype-dashboard-warning'));
			const warningIcon = append(warning, $('span.copilot-prototype-dashboard-warning-icon'));
			warningIcon.append(...renderLabelWithIcons('$(warning)'));
			const warningBody = append(warning, $('span.copilot-prototype-dashboard-warning-text'));
			warningBody.appendChild(mainWindow.document.createTextNode(localize('proOverageApproachWarning', "Once overage spend is reached, Copilot usage will pause until overage limit resets. ")));
			const learnMore = append(warningBody, $('a.copilot-prototype-coin-grid-link'));
			learnMore.textContent = localize('learnMore', "Learn more");
			learnMore.tabIndex = 0;
			learnMore.role = 'link';
		} else if (isOverageInUse) {
			this.createGauge(content, localize('overageUsed22', "22% Used"), 22, localize('overageResetBold', "**Overage Spend** Resets on May 1st"), false, undefined, localize('inUse', "In use"));
		} else {
			this.createGauge(content, localize('overageUsed22', "22% Used"), 22, localize('overageResetBold', "**Overage Spend** Resets on May 1st"), true, undefined, localize('notInUse', "Not in use"));
		}

		// Action buttons
		const actions = append(content, $('div.copilot-prototype-dashboard-actions'));
		const editOverageBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		editOverageBtn.label = localize('editOverage', "Edit Overage");
		const upgradeLimitsBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		upgradeLimitsBtn.label = localize('upgradeIncreaseLimits', "Upgrade to Increase Limits");
	}

	private createInfoMessage(container: HTMLElement, message: string): void {
		const info = append(container, $('div.copilot-prototype-dashboard-info'));
		const infoIcon = append(info, $('span.copilot-prototype-dashboard-info-icon'));
		infoIcon.append(...renderLabelWithIcons('$(info)'));
		const infoBody = append(info, $('span.copilot-prototype-dashboard-info-text'));
		infoBody.appendChild(mainWindow.document.createTextNode(message + ' '));
		const learnMore = append(infoBody, $('a.copilot-prototype-coin-grid-link'));
		learnMore.textContent = localize('learnMore', "Learn more");
		learnMore.tabIndex = 0;
		learnMore.role = 'link';
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

	private createGauge(container: HTMLElement, label: string, percentage: number, description: string, disabled?: boolean, severity?: 'warning' | 'error', statusLabel?: string): void {
		const gauge = append(container, $('div.copilot-prototype-dashboard-gauge'));
		if (disabled) {
			gauge.classList.add('disabled');
		}
		if (severity) {
			gauge.classList.add(severity);
		}

		// Label
		const labelRow = append(gauge, $('div.copilot-prototype-dashboard-gauge-label'));
		const labelText = append(labelRow, $('span'));
		labelText.textContent = label;
		if (statusLabel) {
			const status = append(labelRow, $('span.copilot-prototype-dashboard-gauge-status'));
			status.textContent = statusLabel;
		}

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
