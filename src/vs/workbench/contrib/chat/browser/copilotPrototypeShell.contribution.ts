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
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles, defaultCheckboxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { ViewContainerLocation, IViewDescriptorService } from '../../../common/views.js';
import { IStatusbarEntry, IStatusbarService, ShowTooltipCommand, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IHostService } from '../../../services/host/browser/host.js';
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
	private _microTransaction = false;
	private _autoAdvanceStates: string[] | undefined;
	private _autoAdvanceIndex = 0;
	private _resumed = false;

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IHostService private readonly hostService: IHostService,
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

	private startAutoAdvance(sku: string): void {
		const states = CopilotPrototypeShellCoinStatusBarContribution.STATES;
		const excluded = CopilotPrototypeShellCoinStatusBarContribution.EXCLUDED_CELLS;
		// Build the valid state sequence for this SKU
		this._autoAdvanceStates = states.filter(s => !excluded.has(`${sku}|${s}`));
		this._autoAdvanceIndex = 0;
		if (this._autoAdvanceStates.length > 0) {
			this.setActiveCell(sku, this._autoAdvanceStates[0]);
		}
	}

	private advanceState(): void {
		if (!this._autoAdvanceStates || this._autoAdvanceStates.length === 0) {
			return;
		}
		this._autoAdvanceIndex++;
		if (this._autoAdvanceIndex >= this._autoAdvanceStates.length) {
			// Wrap around to the beginning
			this._autoAdvanceIndex = 0;
		}
		this.setActiveCell(this._activeSku, this._autoAdvanceStates[this._autoAdvanceIndex]);
	}

	private setupInputInterceptor(): void {
		const tryAttach = () => {
			const container = this.layoutService.getContainer(mainWindow);
			const auxBar = container.querySelector('.part.auxiliarybar'); // eslint-disable-line no-restricted-syntax
			if (!auxBar) {
				setTimeout(tryAttach, 1000);
				return;
			}

			// Capture-phase listener — advance state on submit, or block if input blocked
			auxBar.addEventListener('keydown', (e) => {
				const ke = e as KeyboardEvent;
				if (ke.key !== 'Enter' || ke.shiftKey) {
					return;
				}
				const target = e.target as HTMLElement;
				if (!target.closest('.chat-editor-container') && !target.closest('.chat-input-container')) {
					return;
				}
				if (this.isInputBlocked()) {
					e.preventDefault();
					e.stopPropagation();
				} else {
					this.clearResumedState();
					if (this._autoAdvanceStates) {
						// Schedule advance after the message is sent
						setTimeout(() => this.advanceState(), 1500);
					}
				}
			}, true);

			// Also intercept clicks on the send/execute button
			auxBar.addEventListener('click', (e) => {
				const target = e.target as HTMLElement;
				if (!target.closest('.chat-execute-toolbar')) {
					return;
				}
				if (this.isInputBlocked()) {
					e.preventDefault();
					e.stopPropagation();
				} else {
					this.clearResumedState();
					if (this._autoAdvanceStates) {
						setTimeout(() => this.advanceState(), 1500);
					}
				}
			}, true);
		};
		tryAttach();
	}

	private getEntryProps(): IStatusbarEntry {
		return {
			name: localize('copilotPrototypeShellCoinEntry', "Prototype Coin"),
			text: '$(dashboard)',
			ariaLabel: localize('copilotPrototypeShellCoinEntryAria', "Prototype Coin"),
			tooltip: {
				element: token => this.renderTooltip(token),
			},
			command: ShowTooltipCommand,
		};
	}

	private getDashboardEntryProps(): IStatusbarEntry {
		// Resumed state: green icon with "Copilot Resumed"
		if (this._resumed) {
			return {
				name: localize('copilotPrototypeDashboardEntry', "Copilot Dashboard"),
				text: '$(copilot) Copilot Resumed',
				ariaLabel: localize('copilotPrototypeDashboardEntryResumedAria', "Copilot Resumed"),
				backgroundColor: '#2ea04370',
				tooltip: {
					element: token => this.renderDashboard(token),
				},
				command: ShowTooltipCommand,
			};
		}
		const hasOverage = this._activeSku === 'Pro/Pro+' || this._activeSku === 'Max';
		// For Pro with overage, only show warning/error icons for overage states
		const isWarning = (
			hasOverage
				? this._activeState === 'Overage Approached'
				: this._activeState.includes('Approached')
		);
		const isError = (
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
		this._resumed = false;
		// Update the dashboard entry so next tooltip render uses new state
		this._dashboardEntryAccessor.update(this.getDashboardEntryProps());
		// Clear any existing warning card
		this.clearWarningCard();

		// Handle Reset states — OS notification + green status bar
		if (state.includes('Reset')) {
			this.clearBanner();
			this._resumed = true;
			this._dashboardEntryAccessor.update(this.getDashboardEntryProps());
			this.fireResetNotification(state);
			return;
		}

		// Show the right UI for the state
		const isEnterprise = sku === 'Ent/Bus' || sku === 'Ent/Bus ULB';
		const hasOverage = sku === 'Pro/Pro+' || sku === 'Max';
		if (isEnterprise) {
			// Enterprise: approached shows banner, reached shows warning card, no overage
			if (state === 'Overage Reached') {
				this.clearBanner();
				this.showWarningCard();
			} else if (state === 'Overage Approached') {
				this.updateBanner(state);
			} else {
				this.clearBanner();
			}
		} else if (hasOverage) {
			// Pro with overage: only block for overage exhaustion
			if (state === 'Overage Reached') {
				this.clearBanner();
				this.showWarningCard();
			} else if (state.includes('Approached') || state === 'Session Reached' || state === 'Weekly Reached') {
				this.updateBanner(state);
			} else {
				this.clearBanner();
			}
		} else if (state.includes('Reached')) {
			this.clearBanner();
			this.showWarningCard();
		} else if (state.includes('Approached')) {
			this.updateBanner(state);
		} else {
			this.clearBanner();
		}
	}

	private isInputBlocked(): boolean {
		const isEnterprise = this._activeSku === 'Ent/Bus' || this._activeSku === 'Ent/Bus ULB';
		if (isEnterprise) {
			return this._activeState === 'Overage Reached';
		}
		const hasOverage = this._activeSku === 'Pro/Pro+' || this._activeSku === 'Max';
		if (hasOverage) {
			// Pro with overage: only block when overage is exhausted
			return this._activeState === 'Overage Reached';
		}
		return this._activeState.includes('Reached');
	}

	private clearResumedState(): void {
		if (this._resumed) {
			this._resumed = false;
			this._dashboardEntryAccessor.update(this.getDashboardEntryProps());
		}
	}

	private fireResetNotification(state: string): void {
		const isEnterprise = this._activeSku === 'Ent/Bus' || this._activeSku === 'Ent/Bus ULB';
		let limitType: string;
		if (isEnterprise && state === 'Overage Reset') {
			limitType = localize('monthlyLimitType', "monthly limit");
		} else if (state === 'Session Reset') {
			limitType = localize('fiveHourLimit', "five-hour limit");
		} else if (state === 'Weekly Reset') {
			limitType = localize('weeklyLimit', "weekly limit");
		} else {
			limitType = localize('runoverBudget', "runover budget");
		}

		const title = localize('resetNotificationTitle', "Copilot is available again!");
		const body = localize('resetNotificationBody', "Your {0} has reset. Happy coding!", limitType);

		// Fire OS notification via host service
		const cts = new CancellationTokenSource();
		this.hostService.showToast({ title, body }, cts.token);
		// Auto-dispose after 30s so we don't leak
		setTimeout(() => cts.dispose(true), 30000);
	}

	private getBannerMessage(state: string): string | undefined {
		const isEnterprise = this._activeSku === 'Ent/Bus' || this._activeSku === 'Ent/Bus ULB';
		const hasOverage = this._activeSku === 'Pro/Pro+' || this._activeSku === 'Max';

		if (isEnterprise) {
			switch (state) {
				case 'Overage Approached':
					return localize('bannerEntMonthlyApproach', "You've used most of your Monthly Limit. It resets on May 1st. Contact your administrator for more information.");
				default:
					return undefined;
			}
		}

		switch (state) {
			case 'Session Approached':
				if (hasOverage) {
					return localize('bannerSessionApproachOverage', "You've used most of your Five-Hour Limit. You'll start spending your Runover Budget soon.");
				}
				return localize('bannerSessionApproach', "You've used most of your Five-Hour Limit. It resets at 10:00am.");
			case 'Session Reached':
				if (hasOverage) {
					return localize('bannerSessionReachedOverage', "You've hit your Five-Hour Limit. Using Runover Budget until it resets at 10:00am.");
				}
				return undefined;
			case 'Weekly Approached':
				if (hasOverage) {
					return localize('bannerWeeklyApproachOverage', "You've used most of your Weekly Limit. You'll start spending your Runover Budget soon.");
				}
				return localize('bannerWeeklyApproach', "You've used most of your Weekly Limit. It resets on April 6th.");
			case 'Weekly Reached':
				if (hasOverage) {
					return localize('bannerWeeklyReachedOverage', "You've hit your Weekly Limit. Using Runover Budget until it resets on April 6th.");
				}
				return undefined;
			case 'Overage Approached':
				return localize('bannerOverageApproach', "You've spent most of your Runover Budget. It resets on May 1st.");
			default:
				return undefined;
		}
	}

	private getOrCreatePrototypeContainer(): HTMLElement | null {
		const container = this.layoutService.getContainer(mainWindow);
		const inputPart = container.querySelector('.part.auxiliarybar .interactive-input-part') as HTMLElement | null; // eslint-disable-line no-restricted-syntax
		if (!inputPart) {
			return null;
		}
		let protoContainer = inputPart.querySelector('.copilot-prototype-banner-container') as HTMLElement | null; // eslint-disable-line no-restricted-syntax
		if (!protoContainer) {
			protoContainer = mainWindow.document.createElement('div');
			protoContainer.className = 'copilot-prototype-banner-container';
			protoContainer.style.display = 'none';
			// Insert before the first child so it renders above the input box
			inputPart.insertBefore(protoContainer, inputPart.firstChild);
		}
		return protoContainer;
	}

	private updateBanner(state: string): void {
		const message = this.getBannerMessage(state);

		if (!message) {
			this.clearBanner();
			return;
		}

		const protoContainer = this.getOrCreatePrototypeContainer();
		if (!protoContainer) {
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

		// Insert into the prototype container and make it visible
		if (!this._bannerElement.parentElement) {
			protoContainer.appendChild(this._bannerElement);
			protoContainer.style.display = '';
		}
	}

	private clearBanner(): void {
		if (this._bannerElement) {
			const protoContainer = this._bannerElement.parentElement;
			this._bannerElement.remove();
			this._bannerElement = undefined;
			if (protoContainer && protoContainer.children.length === 0) {
				(protoContainer as HTMLElement).style.display = 'none';
			}
		}
	}

	private clearWarningCard(): void {
		if (this._warningCardElement) {
			const protoContainer = this._warningCardElement.parentElement;
			this._warningCardElement.remove();
			this._warningCardElement = undefined;
			if (protoContainer && protoContainer.children.length === 0) {
				(protoContainer as HTMLElement).style.display = 'none';
			}
		}
	}

	private showWarningCard(): void {
		const content = this.getInlineWarningContent();
		if (!content) {
			return;
		}

		const protoContainer = this.getOrCreatePrototypeContainer();
		if (!protoContainer) {
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

		if (content.budgetButtons) {
			for (let i = 0; i < content.budgetButtons.length; i++) {
				const budgetBtn = mainWindow.document.createElement('button');
				budgetBtn.className = i === 0 ? 'copilot-prototype-inline-warning-btn' : 'copilot-prototype-inline-warning-btn budget';
				budgetBtn.textContent = content.budgetButtons[i];
				budgetBtn.addEventListener('click', () => this.advanceState());
				btnContainer.appendChild(budgetBtn);
			}
			if (content.buttonLabel) {
				const otherBtn = mainWindow.document.createElement('button');
				otherBtn.className = 'copilot-prototype-inline-warning-btn secondary';
				otherBtn.textContent = content.buttonLabel;
				otherBtn.addEventListener('click', () => this.advanceState());
				btnContainer.appendChild(otherBtn);
			}
		} else if (content.buttonLabel) {
			const btn = mainWindow.document.createElement('button');
			btn.className = 'copilot-prototype-inline-warning-btn';
			btn.textContent = content.buttonLabel;
			btn.addEventListener('click', () => this.advanceState());
			btnContainer.appendChild(btn);

			if (content.secondaryButtonLabel) {
				const secondaryBtn = mainWindow.document.createElement('button');
				secondaryBtn.className = 'copilot-prototype-inline-warning-btn secondary';
				secondaryBtn.textContent = content.secondaryButtonLabel;
				secondaryBtn.addEventListener('click', () => this.advanceState());
				btnContainer.appendChild(secondaryBtn);
			}
		}

		card.append(header, desc, btnContainer);
		this._warningCardElement = card;
		protoContainer.appendChild(card);
		protoContainer.style.display = '';
	}

	private getInlineWarningContent(): { title: string; description: string; buttonLabel?: string; secondaryButtonLabel?: string; budgetButtons?: string[] } | undefined {
		const sku = this._activeSku;
		const state = this._activeState;
		const isEnterprise = sku === 'Ent/Bus' || sku === 'Ent/Bus ULB';

		if (isEnterprise && state === 'Overage Reached') {
			return {
				title: localize('inlineEntMonthlyReachedTitle', "You've reached your Monthly Limit."),
				description: localize('inlineEntMonthlyReachedDesc', "Copilot is paused until your limit resets on May 1st. Contact your administrator for more information."),
			};
		}

		if (state === 'Session Reached') {
			if (sku === 'Edu/Free') {
				return {
					title: localize('inlineSessionReachedTitle', "You've reached your Five-Hour Limit."),
					description: localize('inlineSessionReachedDescFree', "Resets at 10:00am, or upgrade to increase your limits."),
					buttonLabel: localize('upgrade', "Upgrade"),
				};
			}
			if (sku === 'Pro/Pro+ No O') {
				if (this._microTransaction) {
					return {
						title: localize('inlineSessionReachedTitle', "You've reached your Five-Hour Limit."),
						description: localize('inlineSessionReachedDescProNoOMicro', "Add a Runover Budget to keep using Copilot until your limit resets."),
						budgetButtons: ['+$5', '+$10', '+$20'],
						buttonLabel: localize('otherBudget', "Other"),
					};
				}
				return {
					title: localize('inlineSessionReachedTitle', "You've reached your Five-Hour Limit."),
					description: localize('inlineSessionReachedDescProNoO', "Resets at 10:00am. Configure a Runover Budget or upgrade to increase your limits."),
					buttonLabel: localize('configureBudget', "Configure Budget"),
					secondaryButtonLabel: localize('upgrade', "Upgrade"),
				};
			}
			return {
				title: localize('inlineSessionReachedTitle', "You've reached your Five-Hour Limit."),
				description: localize('inlineSessionReachedDescPro', "Resets at 10:00am."),
				buttonLabel: localize('learnMore', "Learn more"),
			};
		}

		if (state === 'Weekly Reached') {
			if (sku === 'Edu/Free') {
				return {
					title: localize('inlineWeeklyReachedTitle', "You've reached your Weekly Limit."),
					description: localize('inlineWeeklyReachedDescFree', "Resets on April 6th, or upgrade to increase your limits."),
					buttonLabel: localize('upgrade', "Upgrade"),
				};
			}
			if (sku === 'Pro/Pro+ No O') {
				if (this._microTransaction) {
					return {
						title: localize('inlineWeeklyReachedTitle', "You've reached your Weekly Limit."),
						description: localize('inlineWeeklyReachedDescProNoOMicro', "Add a Runover Budget to keep using Copilot until your limit resets."),
						budgetButtons: ['+$5', '+$10', '+$20'],
						buttonLabel: localize('otherBudget', "Other"),
					};
				}
				return {
					title: localize('inlineWeeklyReachedTitle', "You've reached your Weekly Limit."),
					description: localize('inlineWeeklyReachedDescProNoO', "Resets on April 6th. Configure a Runover Budget or upgrade to increase your limits."),
					buttonLabel: localize('configureBudget', "Configure Budget"),
					secondaryButtonLabel: localize('upgrade', "Upgrade"),
				};
			}
			return {
				title: localize('inlineWeeklyReachedTitle', "You've reached your Weekly Limit."),
				description: localize('inlineWeeklyReachedDescPro', "Resets on April 6th. Increase Runover Budget to continue using premium models."),
				buttonLabel: localize('increaseBudget', "Increase Budget"),
			};
		}

		if (state === 'Overage Reached') {
			if (this._microTransaction) {
				return {
					title: localize('inlineOverageReachedTitle', "You've reached your Runover Budget."),
					description: localize('inlineOverageReachedDescMicro', "Add more to your Runover Budget to keep using Copilot."),
					budgetButtons: ['+$5', '+$10', '+$20'],
					buttonLabel: localize('otherBudget', "Other"),
				};
			}
			return {
				title: localize('inlineOverageReachedTitle', "You've reached your Runover Budget."),
				description: localize('inlineOverageReachedDesc', "Copilot is paused until your Runover Budget is increased or limits reset. Upgrade to increase your limit."),
				buttonLabel: localize('editBudget', "Edit Budget"),
				secondaryButtonLabel: localize('upgrade', "Upgrade"),
			};
		}

		return undefined;
	}

	private static readonly SKUS = ['Edu/Free', 'Pro/Pro+ No O', 'Pro/Pro+', 'Max', 'Ent/Bus ULB', 'Ent/Bus'];
	private static readonly STATES = ['Default', 'Session Approached', 'Session Reached', 'Session Reset', 'Weekly Approached', 'Weekly Reached', 'Weekly Reset', 'Overage Approached', 'Overage Reached', 'Overage Reset'];
	private static readonly EXCLUDED_CELLS: ReadonlySet<string> = new Set([
		'Edu/Free|Overage Approached',
		'Edu/Free|Overage Reached',
		'Edu/Free|Overage Reset',
		'Pro/Pro+ No O|Overage Approached',
		'Pro/Pro+ No O|Overage Reached',
		'Pro/Pro+ No O|Overage Reset',
		'Max|Session Approached',
		'Max|Session Reached',
		'Max|Session Reset',
		// Enterprise: no session/weekly/overage — uses Monthly Approached/Reached/Reset via the shared state names
		'Ent/Bus ULB|First Time',
		'Ent/Bus ULB|Session Approached',
		'Ent/Bus ULB|Session Reached',
		'Ent/Bus ULB|Session Reset',
		'Ent/Bus ULB|Weekly Approached',
		'Ent/Bus ULB|Weekly Reached',
		'Ent/Bus ULB|Weekly Reset',
		'Ent/Bus|First Time',
		'Ent/Bus|Session Approached',
		'Ent/Bus|Session Reached',
		'Ent/Bus|Session Reset',
		'Ent/Bus|Weekly Approached',
		'Ent/Bus|Weekly Reached',
		'Ent/Bus|Weekly Reset',
	]);

	private renderTooltip(token: CancellationToken): HTMLElement {
		const disposables = new DisposableStore();
		disposables.add(token.onCancellationRequested(() => disposables.dispose()));

		const container = mainWindow.document.createElement('div');
		container.className = 'copilot-prototype-coin-widget';

		const title = mainWindow.document.createElement('div');
		title.className = 'copilot-prototype-coin-widget-title';
		title.textContent = localize('copilotPrototypeShellCoinWidgetTitle', "Prototype Coin · 04.07");

		// Grid: SKU columns x State rows
		const skus = CopilotPrototypeShellCoinStatusBarContribution.SKUS;
		const states = CopilotPrototypeShellCoinStatusBarContribution.STATES;

		const grid = mainWindow.document.createElement('div');
		grid.className = 'copilot-prototype-coin-grid';
		grid.style.gridTemplateColumns = `auto repeat(${skus.length}, minmax(70px, 1fr))`;
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
			link.addEventListener('click', () => {
				this.startAutoAdvance(sku);
			});
			header.appendChild(link);
			grid.appendChild(header);
		}

		// Rows
		for (const state of states) {
			// Row header (State) — display-friendly names in the grid
			const rowHeader = mainWindow.document.createElement('div');
			rowHeader.className = 'copilot-prototype-coin-grid-row-header';
			rowHeader.textContent = state.replace('Reached', 'Exhausted').replace('Overage', 'Runover').replace('Session', 'Five-Hour');
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
						this._autoAdvanceStates = undefined;
						this._microTransaction = false;
						this.setActiveCell(sku, state);
					}));
					// Add red button for Pro/Pro+ No O exhausted states
					if (sku === 'Pro/Pro+ No O' && (state === 'Session Reached' || state === 'Weekly Reached')) {
						const redBtn = disposables.add(new Button(cell, {
							...defaultButtonStyles,
							secondary: true,
						}));
						redBtn.label = '';
						redBtn.element.classList.add('red');
						disposables.add(redBtn.onDidClick(() => {
							this._autoAdvanceStates = undefined;
							this._microTransaction = true;
							this.setActiveCell(sku, state);
						}));
					}
					// Add red button for Pro/Pro+ and Max overage exhausted
					if ((sku === 'Pro/Pro+' || sku === 'Max') && state === 'Overage Reached') {
						const redBtn = disposables.add(new Button(cell, {
							...defaultButtonStyles,
							secondary: true,
						}));
						redBtn.label = '';
						redBtn.element.classList.add('red');
						disposables.add(redBtn.onDidClick(() => {
							this._autoAdvanceStates = undefined;
							this._microTransaction = true;
							this.setActiveCell(sku, state);
						}));
					}
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

		const isEnterprise = sku === 'Ent/Bus' || sku === 'Ent/Bus ULB';

		if (isEnterprise) {
			// Enterprise: single combined view with title header, no tabs
			const header = append(dashboard, $('div.copilot-prototype-dashboard-header'));
			const titleText = append(header, $('div.copilot-prototype-dashboard-title'));
			titleText.textContent = localize('dashboardTitleEnterprise', "Copilot Enterprise Usage");

			const headerActions = append(header, $('div.copilot-prototype-dashboard-header-actions'));
			const settingsIcon = append(headerActions, $('div.copilot-prototype-dashboard-icon'));
			settingsIcon.append(...renderLabelWithIcons('$(settings)'));
			settingsIcon.title = localize('settings', "Settings");
			settingsIcon.tabIndex = 0;

			const contentWrapper = append(dashboard, $('div.copilot-prototype-dashboard-content-wrapper'));
			const combinedContent = append(contentWrapper, $('div.copilot-prototype-dashboard-content.active'));
			this.renderEnterpriseCombinedTab(combinedContent, disposables, sku, state);
			return dashboard;
		}

		// Non-enterprise: labeled tab bar header with plan label on right
		const header = append(dashboard, $('div.copilot-prototype-dashboard-header'));

		// Tab buttons on the left
		const tabsContainer = append(header, $('div.copilot-prototype-dashboard-tabs'));
		const tokenUsageTab = append(tabsContainer, $('div.copilot-prototype-dashboard-header-tab.active'));
		tokenUsageTab.append(...renderLabelWithIcons('$(comment-discussion)'));
		tokenUsageTab.title = localize('tab.tokenUsage', "Token Usage");
		tokenUsageTab.tabIndex = 0;
		tokenUsageTab.role = 'tab';
		const inlineSuggestionsTab = append(tabsContainer, $('div.copilot-prototype-dashboard-header-tab'));
		inlineSuggestionsTab.append(...renderLabelWithIcons('$(lightbulb-sparkle)'));
		inlineSuggestionsTab.title = localize('tab.inlineSuggestions', "Inline Suggestions");
		inlineSuggestionsTab.tabIndex = 0;
		inlineSuggestionsTab.role = 'tab';

		// Plan label + settings icon on the right
		const planLabel = append(header, $('div.copilot-prototype-dashboard-plan-label'));
		const isPro = sku !== 'Edu/Free';
		const shortName = isPro ? localize('planShortPro', "Copilot Pro") : localize('planShortFree', "Copilot Free");
		append(planLabel, $('span.copilot-prototype-dashboard-plan-name', undefined, shortName));
		const settingsIcon = append(planLabel, $('div.copilot-prototype-dashboard-icon'));
		settingsIcon.append(...renderLabelWithIcons('$(settings)'));
		settingsIcon.title = localize('settings', "Settings");
		settingsIcon.tabIndex = 0;

		// Tab content wrapper (grid overlap so both tabs size the container)
		const contentWrapper = append(dashboard, $('div.copilot-prototype-dashboard-content-wrapper'));
		const copilotContent = append(contentWrapper, $('div.copilot-prototype-dashboard-content.active'));
		const inlineContent = append(contentWrapper, $('div.copilot-prototype-dashboard-content'));

		// === Token Usage Tab Content ===
		this.renderCopilotTab(copilotContent, disposables, sku, state);

		// === Inline Suggestions Tab Content ===
		this.renderInlineTab(inlineContent, disposables, sku, state);

		// Tab switching
		tokenUsageTab.addEventListener('click', () => {
			tokenUsageTab.classList.add('active');
			inlineSuggestionsTab.classList.remove('active');
			copilotContent.classList.add('active');
			inlineContent.classList.remove('active');
		});
		inlineSuggestionsTab.addEventListener('click', () => {
			inlineSuggestionsTab.classList.add('active');
			tokenUsageTab.classList.remove('active');
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
			this.createGauge(content, localize('sessionUsed90', "90% Used"), 90, localize('sessionResetBold', "**Five-Hour Limit** resets today at 10:00am"), false, 'warning');
			const warning = append(content, $('div.copilot-prototype-dashboard-warning'));
			const warningIcon = append(warning, $('span.copilot-prototype-dashboard-warning-icon'));
			warningIcon.append(...renderLabelWithIcons('$(warning)'));
			const warningBody = append(warning, $('span.copilot-prototype-dashboard-warning-text'));
			if (isPro) {
				warningBody.appendChild(mainWindow.document.createTextNode(localize('sessionApproachWarningPro', "Copilot will pause at the limit. Upgrade or configure budget to continue. ")));
			} else {
				warningBody.appendChild(mainWindow.document.createTextNode(localize('sessionApproachWarning', "Copilot will pause when the limit is reached. ")));
			}
			const learnMore = append(warningBody, $('a.copilot-prototype-coin-grid-link'));
			learnMore.textContent = localize('learnMore', "Learn more");
			learnMore.tabIndex = 0;
			learnMore.role = 'link';
		} else if (state === 'Session Reached') {
			this.createGauge(content, localize('sessionUsed100', "100% Used"), 100, localize('sessionResetBoldReached', "**Five-Hour Limit** resets today at 10:00am"), false, 'error');
			const warning = append(content, $('div.copilot-prototype-dashboard-warning'));
			const warningIcon = append(warning, $('span.copilot-prototype-dashboard-warning-icon.error'));
			warningIcon.append(...renderLabelWithIcons('$(error)'));
			const warningBody = append(warning, $('span.copilot-prototype-dashboard-warning-text'));
			if (isPro) {
				warningBody.appendChild(mainWindow.document.createTextNode(localize('sessionReachedWarningPro', "Copilot is paused until the limit resets. Upgrade or configure budget to continue. ")));
			} else {
				warningBody.appendChild(mainWindow.document.createTextNode(localize('sessionReachedWarning', "Copilot is paused until the Five-Hour Limit resets. ")));
			}
			const learnMore = append(warningBody, $('a.copilot-prototype-coin-grid-link'));
			learnMore.textContent = localize('learnMore', "Learn more");
			learnMore.tabIndex = 0;
			learnMore.role = 'link';
		} else if (state === 'Weekly Reached') {
			this.createGauge(content, localize('sessionUsed100', "100% Used"), 100, localize('sessionResetWithWeekly', "**Five-Hour Limit** resets with Weekly Limit"), false, 'error');
		} else if (state === 'Session Reset' || state === 'Weekly Reset' || state === 'Overage Reset') {
			this.createGauge(content, localize('sessionUsed0', "0% Used"), 0, localize('sessionResetBoldDefault', "**Five-Hour Limit** resets today at 10:00am"));
		} else {
			this.createGauge(content, localize('sessionUsed', "18% Used"), 18, localize('sessionResetBoldDefault', "**Five-Hour Limit** resets today at 10:00am"));
		}

		// Weekly Limit
		if (state === 'Weekly Approached') {
			this.createGauge(content, localize('weeklyUsed90', "90% Used"), 90, localize('weeklyResetBoldApproached', "**Weekly Limit** resets on April 6th"), false, 'warning');
			const weeklyWarning = append(content, $('div.copilot-prototype-dashboard-warning'));
			const weeklyWarningIcon = append(weeklyWarning, $('span.copilot-prototype-dashboard-warning-icon'));
			weeklyWarningIcon.append(...renderLabelWithIcons('$(warning)'));
			const weeklyWarningBody = append(weeklyWarning, $('span.copilot-prototype-dashboard-warning-text'));
			if (isPro) {
				weeklyWarningBody.appendChild(mainWindow.document.createTextNode(localize('weeklyApproachWarningPro', "Copilot will pause at the limit. Upgrade or configure budget to continue. ")));
			} else {
				weeklyWarningBody.appendChild(mainWindow.document.createTextNode(localize('weeklyApproachWarning', "Copilot will pause when the limit is reached. ")));
			}
			const weeklyLearnMore = append(weeklyWarningBody, $('a.copilot-prototype-coin-grid-link'));
			weeklyLearnMore.textContent = localize('learnMore', "Learn more");
			weeklyLearnMore.tabIndex = 0;
			weeklyLearnMore.role = 'link';
		} else if (state === 'Weekly Reached') {
			this.createGauge(content, localize('weeklyUsed100', "100% Used"), 100, localize('weeklyResetBoldReached', "**Weekly Limit** resets on April 6th"), false, 'error');
			const weeklyError = append(content, $('div.copilot-prototype-dashboard-warning'));
			const weeklyErrorIcon = append(weeklyError, $('span.copilot-prototype-dashboard-warning-icon.error'));
			weeklyErrorIcon.append(...renderLabelWithIcons('$(error)'));
			const weeklyErrorBody = append(weeklyError, $('span.copilot-prototype-dashboard-warning-text'));
			if (isPro) {
				weeklyErrorBody.appendChild(mainWindow.document.createTextNode(localize('weeklyReachedWarningPro', "Copilot is paused until the limit resets. Upgrade or configure budget to continue. ")));
			} else {
				weeklyErrorBody.appendChild(mainWindow.document.createTextNode(localize('weeklyReachedWarning', "Copilot is paused until the Weekly Limit resets. ")));
			}
			const weeklyLearnMore2 = append(weeklyErrorBody, $('a.copilot-prototype-coin-grid-link'));
			weeklyLearnMore2.textContent = localize('learnMore', "Learn more");
			weeklyLearnMore2.tabIndex = 0;
			weeklyLearnMore2.role = 'link';
		} else if (state === 'Weekly Reset' || state === 'Overage Reset') {
			this.createGauge(content, localize('weeklyUsed0', "0% Used"), 0, localize('weeklyResetBold', "**Weekly Limit** resets on April 6th"));
		} else {
			this.createGauge(content, localize('weeklyUsed', "56% Used"), 56, localize('weeklyResetBold', "**Weekly Limit** resets on April 6th"));
		}

		// Runover Budget
		if (isPro && !hasOverage && this._microTransaction && (state === 'Session Reached' || state === 'Weekly Reached')) {
			// Microtransaction: show $0/$0 undimmed
			this.createGauge(content, localize('zeroBudget', "$0 / $0"), 0, localize('runoverBudgetBold', "**Runover Budget**"));
		} else if (isPro && !hasOverage) {
			// Pro/Pro+ No O: not configured
			this.createGauge(content, localize('notConfigured', "Not Configured"), 0, localize('runoverBudgetBold', "**Runover Budget**"), true);
		} else if (!isPro) {
			// Edu/Free: no runover budget
			this.createGauge(content, localize('zeroUsed', "0% Used"), 0, localize('runoverDescBold', "**Runover Budget** For Pro, Pro+, and Max users"), true);
		} else {
			// Pro/Pro+ with overage
			this.createGauge(content, localize('overageConfigured', "Configured"), 0, localize('runoverBudgetBold', "**Runover Budget**"));
		}

		// Action buttons — SKU-aware
		const actions = append(content, $('div.copilot-prototype-dashboard-actions'));
		if (isPro && !hasOverage && this._microTransaction && (state === 'Session Reached' || state === 'Weekly Reached')) {
			// Microtransaction: quick budget buttons
			const fiveBtn = disposables.add(new Button(actions, { ...defaultButtonStyles }));
			fiveBtn.label = '+$5';
			disposables.add(fiveBtn.onDidClick(() => this.advanceState()));
			for (const amount of ['+$10', '+$20']) {
				const budgetBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
				budgetBtn.label = amount;
				disposables.add(budgetBtn.onDidClick(() => this.advanceState()));
			}
			const otherBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			otherBtn.label = localize('otherBudget', "Other");
			disposables.add(otherBtn.onDidClick(() => this.advanceState()));
		} else if (isPro && !hasOverage) {
			const configOverageBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			configOverageBtn.label = localize('configureBudget', "Configure Budget");
			disposables.add(configOverageBtn.onDidClick(() => this.advanceState()));
			const upgradeLimitsBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			upgradeLimitsBtn.label = localize('upgrade', "Upgrade");
			upgradeLimitsBtn.enabled = false;
		} else if (!isPro) {
			const upgradeBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			upgradeBtn.label = localize('upgrade', "Upgrade");
			disposables.add(upgradeBtn.onDidClick(() => this.advanceState()));
		} else {
			const configBudgetBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			configBudgetBtn.label = localize('configureBudget', "Configure Budget");
			disposables.add(configBudgetBtn.onDidClick(() => this.advanceState()));
		}
	}

	private renderProOverageCopilotTab(content: HTMLElement, disposables: DisposableStore, state: string): void {
		const isOverageInUse = state === 'Session Reached' || state === 'Weekly Reached' || state === 'Overage Approached' || state === 'Overage Reached';

		// Five-Hour Limit
		if (state === 'Session Approached') {
			this.createGauge(content, localize('sessionUsed90', "90% Used"), 90, localize('sessionResetBoldApproached', "**Five-Hour Limit** resets today at 10:00am"));
			this.createInfoMessage(content, localize('proSessionApproachInfo', "Once Five-Hour Limit is reached, your Runover Budget will be used until it resets."));
		} else if (state === 'Session Reached') {
			// Gray out — overage has kicked in
			this.createGauge(content, localize('sessionUsed100', "100% Used"), 100, localize('proSessionResetBoldReached', "**Five-Hour Limit** resets today at 10:00am"), true);
			this.createInfoMessage(content, localize('proSessionReachedInfo', "Using Runover Budget until Five-Hour Limit resets."));
		} else if (state === 'Weekly Reached' || state === 'Overage Approached' || state === 'Overage Reached') {
			// Both session and weekly limits exhaust together
			this.createGauge(content, localize('sessionUsed100', "100% Used"), 100, localize('proSessionResetWithWeekly', "**Five-Hour Limit** resets with Weekly Limit"), true);
		} else if (state === 'Session Reset' || state === 'Weekly Reset' || state === 'Overage Reset') {
			this.createGauge(content, localize('sessionUsed0', "0% Used"), 0, localize('proSessionResetBoldDefault', "**Five-Hour Limit** resets today at 10:00am"));
		} else {
			this.createGauge(content, localize('sessionUsed', "18% Used"), 18, localize('proSessionResetBoldDefault', "**Five-Hour Limit** resets today at 10:00am"));
		}

		// Weekly Limit
		if (state === 'Weekly Approached') {
			this.createGauge(content, localize('weeklyUsed90', "90% Used"), 90, localize('proWeeklyResetBoldApproached', "**Weekly Limit** resets on April 6th"));
			this.createInfoMessage(content, localize('proWeeklyApproachInfo', "Once Weekly Limit is reached, your Runover Budget will be used until it resets."));
		} else if (state === 'Weekly Reached') {
			// Gray out — overage has kicked in
			this.createGauge(content, localize('weeklyUsed100', "100% Used"), 100, localize('proWeeklyResetBoldReached', "**Weekly Limit** resets on April 6th"), true);
			this.createInfoMessage(content, localize('proWeeklyReachedInfo', "Using Runover Budget until Weekly Limit resets."));
		} else if (state === 'Session Reached' || state === 'Overage Approached' || state === 'Overage Reached') {
			// Gray out — overage is in use, weekly limit is not counting
			this.createGauge(content, localize('weeklyUsed100', "100% Used"), 100, localize('proWeeklyResetBoldReached2', "**Weekly Limit** resets on April 6th"), true);
		} else if (state === 'Weekly Reset' || state === 'Overage Reset') {
			this.createGauge(content, localize('weeklyUsed0', "0% Used"), 0, localize('weeklyResetBold', "**Weekly Limit** resets on April 6th"));
		} else {
			this.createGauge(content, localize('weeklyUsed', "56% Used"), 56, localize('weeklyResetBold', "**Weekly Limit** resets on April 6th"));
		}

		// Runover Budget — with "In use" / "Not in use" status
		if (state === 'Overage Reached') {
			this.createGauge(content, localize('overageUsed100', "100% Used"), 100, localize('runoverResetBold', "**Runover Budget** resets on May 1st"), false, 'error', localize('inUse', "In use"));
			const warning = append(content, $('div.copilot-prototype-dashboard-warning'));
			const warningIcon = append(warning, $('span.copilot-prototype-dashboard-warning-icon'));
			warningIcon.append(...renderLabelWithIcons('$(warning)'));
			const warningBody = append(warning, $('span.copilot-prototype-dashboard-warning-text'));
			warningBody.appendChild(mainWindow.document.createTextNode(localize('proOverageReachedWarning', "Copilot is paused until your runover budget is increased or limits reset. ")));
			const learnMore = append(warningBody, $('a.copilot-prototype-coin-grid-link'));
			learnMore.textContent = localize('learnMore', "Learn more");
			learnMore.tabIndex = 0;
			learnMore.role = 'link';
		} else if (state === 'Overage Approached') {
			this.createGauge(content, localize('overageUsed90', "90% Used"), 90, localize('runoverResetBold', "**Runover Budget** resets on May 1st"), false, 'warning', localize('inUse', "In use"));
			const warning = append(content, $('div.copilot-prototype-dashboard-warning'));
			const warningIcon = append(warning, $('span.copilot-prototype-dashboard-warning-icon'));
			warningIcon.append(...renderLabelWithIcons('$(warning)'));
			const warningBody = append(warning, $('span.copilot-prototype-dashboard-warning-text'));
			warningBody.appendChild(mainWindow.document.createTextNode(localize('proOverageApproachWarning', "Once your runover budget runs out, Copilot will pause until it resets. ")));
			const learnMore = append(warningBody, $('a.copilot-prototype-coin-grid-link'));
			learnMore.textContent = localize('learnMore', "Learn more");
			learnMore.tabIndex = 0;
			learnMore.role = 'link';
		} else if (isOverageInUse) {
			this.createGauge(content, localize('overageUsed22', "22% Used"), 22, localize('runoverResetBold', "**Runover Budget** resets on May 1st"), false, undefined, localize('inUse', "In use"));
		} else if (state === 'Overage Reset') {
			this.createGauge(content, localize('overageUsed0', "0% Used"), 0, localize('runoverResetBold', "**Runover Budget** resets on May 1st"), true, undefined, localize('notInUse', "Not in use"));
		} else {
			this.createGauge(content, localize('overageUsed22', "22% Used"), 22, localize('runoverResetBold', "**Runover Budget** resets on May 1st"), true, undefined, localize('notInUse', "Not in use"));
		}

		// Action buttons
		const actions = append(content, $('div.copilot-prototype-dashboard-actions'));
		if (this._microTransaction && state === 'Overage Reached') {
			// Microtransaction: quick budget buttons
			const fiveBtn = disposables.add(new Button(actions, { ...defaultButtonStyles }));
			fiveBtn.label = '+$5';
			disposables.add(fiveBtn.onDidClick(() => this.advanceState()));
			for (const amount of ['+$10', '+$20']) {
				const budgetBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
				budgetBtn.label = amount;
				disposables.add(budgetBtn.onDidClick(() => this.advanceState()));
			}
			const otherBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			otherBtn.label = localize('otherBudget', "Other");
			disposables.add(otherBtn.onDidClick(() => this.advanceState()));
		} else {
			const editOverageBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			editOverageBtn.label = localize('editBudget', "Edit Budget");
			disposables.add(editOverageBtn.onDidClick(() => this.advanceState()));
			const upgradeLimitsBtn = disposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
			upgradeLimitsBtn.label = localize('upgrade', "Upgrade");
			disposables.add(upgradeLimitsBtn.onDidClick(() => this.advanceState()));
		}
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
		// Inline Suggestions gauge — non-free plans have no limit
		if (_sku === 'Edu/Free') {
			this.createGauge(content, localize('inlineUsed', "12% Used"), 12, localize('inlineResetBold', "**Inline Suggestions** Resets on May 1st"));
		} else if (_sku === 'Ent/Bus ULB' || _sku === 'Ent/Bus') {
			this.createGauge(content, localize('inlineIncluded', "Included"), 0, localize('inlineNoLimitOrg', "**Inline Suggestions** No limit set by your organization"), true);
		} else {
			this.createGauge(content, localize('inlineIncluded', "Included"), 0, localize('inlineNoLimitSub', "**Inline Suggestions** No limit set by your subscription"), true);
		}

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

		// Model selector
		const modelRow = append(settings, $('div.copilot-prototype-dashboard-dropdown-row'));
		append(modelRow, $('span.copilot-prototype-dashboard-setting-label')).textContent = localize('model', "Model");
		const modelSelect = append(modelRow, $('select.copilot-prototype-dashboard-select'));
		for (const model of ['dd_5minichat_edits_xtab_300_unified', 'gpt-4o-mini', 'claude-3.5-sonnet']) {
			const option = append(modelSelect, $('option'));
			option.textContent = model;
			option.value = model;
		}

		// Eagerness selector (dropdown)
		const eagernessRow = append(settings, $('div.copilot-prototype-dashboard-dropdown-row'));
		append(eagernessRow, $('span.copilot-prototype-dashboard-setting-label')).textContent = localize('eagerness', "Eagerness");
		const eagernessSelect = append(eagernessRow, $('select.copilot-prototype-dashboard-select'));
		for (const opt of ['Auto', 'Low', 'Medium', 'High']) {
			const option = append(eagernessSelect, $('option'));
			option.textContent = opt;
			option.value = opt;
		}

		// Snooze
		const snoozeRow = append(settings, $('div.copilot-prototype-dashboard-snooze'));
		const snoozeBtn = disposables.add(new Button(snoozeRow, { ...defaultButtonStyles, secondary: true }));
		snoozeBtn.label = localize('snooze', "Snooze");
		append(snoozeRow, $('span.copilot-prototype-dashboard-snooze-label')).textContent = localize('hideSuggestions', "Hide suggestions for 5 min");
	}

	private renderEnterpriseCombinedTab(content: HTMLElement, disposables: DisposableStore, _sku: string, _state: string): void {
		// Monthly Limit gauge — state-aware
		if (_state === 'Overage Approached') {
			this.createGauge(content, localize('monthlyUsed90', "90% Used"), 90, localize('monthlyResetBold', "**Monthly Limit** Resets on May 1st"), false, 'warning');
			const warning = append(content, $('div.copilot-prototype-dashboard-warning'));
			const warningIcon = append(warning, $('span.copilot-prototype-dashboard-warning-icon'));
			warningIcon.append(...renderLabelWithIcons('$(warning)'));
			const warningBody = append(warning, $('span.copilot-prototype-dashboard-warning-text'));
			warningBody.appendChild(mainWindow.document.createTextNode(localize('entMonthlyApproachWarning', "Copilot will pause when the limit is reached. Contact your administrator for more information.")));
		} else if (_state === 'Overage Reached') {
			this.createGauge(content, localize('monthlyUsed100', "100% Used"), 100, localize('monthlyResetBold', "**Monthly Limit** Resets on May 1st"), false, 'error');
			const warning = append(content, $('div.copilot-prototype-dashboard-warning'));
			const warningIcon = append(warning, $('span.copilot-prototype-dashboard-warning-icon.error'));
			warningIcon.append(...renderLabelWithIcons('$(error)'));
			const warningBody = append(warning, $('span.copilot-prototype-dashboard-warning-text'));
			warningBody.appendChild(mainWindow.document.createTextNode(localize('entMonthlyReachedWarning', "Copilot is paused until the limit resets. Contact your administrator for more information.")));
		} else if (_state === 'Overage Reset') {
			this.createGauge(content, localize('monthlyUsed0', "0% Used"), 0, localize('monthlyResetBold', "**Monthly Limit** Resets on May 1st"));
		} else {
			this.createGauge(content, localize('monthlyUsed56', "56% Used"), 56, localize('monthlyResetBold', "**Monthly Limit** Resets on May 1st"));
		}

		// Separator
		append(content, $('div.copilot-prototype-dashboard-separator'));

		// Inline Suggestions gauge with settings gear
		const inlineGauge = append(content, $('div.copilot-prototype-dashboard-gauge'));
		const inlineLabelRow = append(inlineGauge, $('div.copilot-prototype-dashboard-gauge-label'));
		const inlineLabel = append(inlineLabelRow, $('span'));
		inlineLabel.textContent = localize('inlineIncluded', "Included");
		const inlineGear = append(inlineLabelRow, $('span.copilot-prototype-dashboard-inline-gear'));
		inlineGear.append(...renderLabelWithIcons('$(settings-gear)'));
		inlineGear.tabIndex = 0;
		inlineGear.title = localize('settings', "Settings");

		// Inline Suggestions progress bar (light blue, full width)
		const inlineBarContainer = append(inlineGauge, $('div.copilot-prototype-dashboard-gauge-bar'));
		const inlineBarFill = append(inlineBarContainer, $('div.copilot-prototype-dashboard-gauge-bar-fill'));
		inlineBarFill.style.width = '100%';

		// Inline Suggestions gauge description
		const inlineDesc = append(inlineGauge, $('div.copilot-prototype-dashboard-gauge-desc'));
		const boldPart = append(inlineDesc, $('strong'));
		boldPart.textContent = localize('inlineSuggestions', "Inline Suggestions.");
		inlineDesc.appendChild(mainWindow.document.createTextNode(' ' + localize('resetsOnMay1st', "Resets on May 1st.")));

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
