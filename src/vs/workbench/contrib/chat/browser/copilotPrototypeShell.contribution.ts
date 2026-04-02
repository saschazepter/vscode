/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/copilotPrototypeShell.css';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Event } from '../../../../base/common/event.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { ViewContainerLocation, IViewDescriptorService } from '../../../common/views.js';
import { IStatusbarEntry, IStatusbarService, ShowTooltipCommand, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ChatViewId } from './chat.js';
import { MANAGE_CHAT_COMMAND_ID } from '../common/constants.js';

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

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this._register(statusbarService.addEntry(this.getEntryProps(), CopilotPrototypeShellCoinStatusBarContribution.STATUS_BAR_ENTRY_ID, StatusbarAlignment.LEFT, {
			location: { id: 'status.prototype.coin', priority: 1000 },
			alignment: StatusbarAlignment.LEFT,
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

	private renderTooltip(token: CancellationToken): HTMLElement {
		const disposables = new DisposableStore();
		disposables.add(token.onCancellationRequested(() => disposables.dispose()));

		const container = mainWindow.document.createElement('div');
		container.className = 'copilot-prototype-coin-widget';

		const title = mainWindow.document.createElement('div');
		title.className = 'copilot-prototype-coin-widget-title';
		title.textContent = localize('copilotPrototypeShellCoinWidgetTitle', "Prototype Coin");

		const description = mainWindow.document.createElement('div');
		description.className = 'copilot-prototype-coin-widget-description';
		description.textContent = localize('copilotPrototypeShellCoinWidgetDescription', "A simple prototype widget entry for the custom shell.");

		const actions = mainWindow.document.createElement('div');
		actions.className = 'copilot-prototype-coin-widget-actions';

		const manageButton = disposables.add(new Button(actions, {
			...defaultButtonStyles,
			secondary: true,
		}));
		manageButton.label = localize('copilotPrototypeShellCoinWidgetManage', "Manage");
		disposables.add(manageButton.onDidClick(() => {
			void this.commandService.executeCommand(MANAGE_CHAT_COMMAND_ID);
		}));

		container.append(title, description, actions);
		return container;
	}
}

registerWorkbenchContribution2(CopilotPrototypeShellContribution.ID, CopilotPrototypeShellContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(CopilotPrototypeShellCoinStatusBarContribution.ID, CopilotPrototypeShellCoinStatusBarContribution, WorkbenchPhase.AfterRestored);
