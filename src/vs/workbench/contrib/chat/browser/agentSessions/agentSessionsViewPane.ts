/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentSessionsViewPane.css';
import { $, append } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { localize } from '../../../../../nls.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../common/views.js';
import { ACTION_ID_NEW_CHAT } from '../actions/chatActions.js';
import { IAgentSession } from './agentSessionsModel.js';
import { AgentSessionsControl } from './agentSessionsControl.js';
import { AgentSessionsFilter, AgentSessionsGrouping } from './agentSessionsFilter.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { IWorkbenchLayoutService, Position } from '../../../../services/layout/browser/layoutService.js';

export const AgentSessionsViewId = 'workbench.panel.chat.view.agentSessions';

export class AgentSessionsViewPane extends ViewPane {

	static readonly ID = AgentSessionsViewId;

	private sessionsControl: AgentSessionsControl | undefined;
	private sessionsControlContainer: HTMLElement | undefined;
	private newSessionButtonContainer: HTMLElement | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);

		const container = parent.appendChild($('.agent-sessions-viewpane'));

		// New Session Button
		const newSessionButtonContainer = this.newSessionButtonContainer = append(container, $('.agent-sessions-new-button-container'));
		const newSessionButton = this._register(new Button(newSessionButtonContainer, { ...defaultButtonStyles, secondary: true }));
		newSessionButton.label = localize('newSession', "New Session");
		this._register(newSessionButton.onDidClick(() => this.commandService.executeCommand(ACTION_ID_NEW_CHAT)));

		// Sessions Filter
		const sessionsFilter = this._register(this.instantiationService.createInstance(AgentSessionsFilter, {
			filterMenuId: MenuId.AgentSessionsViewerFilterSubMenu,
			groupResults: () => AgentSessionsGrouping.Date
		}));

		// Sessions Control
		this.sessionsControlContainer = append(container, $('.agent-sessions-control-container'));
		this.sessionsControl = this._register(this.instantiationService.createInstance(AgentSessionsControl, this.sessionsControlContainer, {
			source: 'agentSessionsViewPane',
			filter: sessionsFilter,
			overrideStyles: this.getLocationBasedColors().listOverrideStyles,
			getHoverPosition: () => this.getSessionHoverPosition(),
			trackActiveEditorSession: () => true,
		}));
		this._register(this.onDidChangeBodyVisibility(visible => this.sessionsControl!.setVisible(visible)));
	}

	private getSessionHoverPosition(): HoverPosition {
		const viewLocation = this.viewDescriptorService.getViewLocationById(this.id);
		const sideBarPosition = this.layoutService.getSideBarPosition();

		if (viewLocation === ViewContainerLocation.Sidebar && sideBarPosition === Position.RIGHT) {
			return HoverPosition.LEFT;
		}

		return HoverPosition.RIGHT;
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		const controlHeight = height - (this.newSessionButtonContainer?.offsetHeight ?? 0);
		if (this.sessionsControl && this.sessionsControlContainer) {
			this.sessionsControlContainer.style.height = `${controlHeight}px`;
			this.sessionsControl.layout(controlHeight, width);
		}
	}

	getFocusedSessions(): IAgentSession[] {
		return this.sessionsControl?.getFocus() ?? [];
	}

	focusSessions(): boolean {
		this.sessionsControl?.focus();
		return true;
	}

	override shouldShowWelcome(): boolean {
		return false;
	}
}
