/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentSessionsViewPane.css';
import { $, append } from '../../../../../../base/browser/dom.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../../common/views.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { localize } from '../../../../../../nls.js';
import { AgentSessionsControl } from '../agentSessionsControl.js';
import { AgentSessionsFilter, AgentSessionsGrouping } from '../agentSessionsFilter.js';
import { MenuId } from '../../../../../../platform/actions/common/actions.js';
import { HoverPosition } from '../../../../../../base/browser/ui/hover/hoverWidget.js';
import { IWorkbenchLayoutService } from '../../../../../services/layout/browser/layoutService.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ACTION_ID_NEW_CHAT } from '../../actions/chatActions.js';

export class AgentSessionsViewPane extends ViewPane {

	private viewPaneContainer: HTMLElement | undefined;
	private newSessionButtonContainer: HTMLElement | undefined;
	private sessionsControlContainer: HTMLElement | undefined;
	private sessionsControl: AgentSessionsControl | undefined;

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
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);

		this.viewPaneContainer = parent;
		this.viewPaneContainer.classList.add('agent-sessions-viewpane');

		this.createControls(parent);
	}

	private createControls(parent: HTMLElement): void {
		const sessionsContainer = append(parent, $('.agent-sessions-container'));

		// Sessions Filter (actions go to view title bar via menu registration)
		const sessionsFilter = this._register(this.instantiationService.createInstance(AgentSessionsFilter, {
			filterMenuId: MenuId.AgentSessionsViewFilterSubMenu,
			groupResults: () => AgentSessionsGrouping.Date
		}));

		// New Session Button
		const newSessionButtonContainer = this.newSessionButtonContainer = append(sessionsContainer, $('.agent-sessions-new-button-container'));
		const newSessionButton = this._register(new Button(newSessionButtonContainer, { ...defaultButtonStyles, secondary: true }));
		newSessionButton.label = localize('newSession', "New Session");
		this._register(newSessionButton.onDidClick(() => this.commandService.executeCommand(ACTION_ID_NEW_CHAT)));

		// Sessions Control
		this.sessionsControlContainer = append(sessionsContainer, $('.agent-sessions-control-container'));
		const sessionsControl = this.sessionsControl = this._register(this.instantiationService.createInstance(AgentSessionsControl, this.sessionsControlContainer, {
			source: 'agentSessionsViewPane',
			filter: sessionsFilter,
			overrideStyles: this.getLocationBasedColors().listOverrideStyles,
			getHoverPosition: () => this.getSessionHoverPosition(),
			trackActiveEditorSession: () => true,
		}));
		this._register(this.onDidChangeBodyVisibility(visible => sessionsControl.setVisible(visible)));
	}

	private getSessionHoverPosition(): HoverPosition {
		const viewLocation = this.viewDescriptorService.getViewLocationById(this.id);
		const sideBarPosition = this.layoutService.getSideBarPosition();

		return {
			[ViewContainerLocation.Sidebar]: sideBarPosition === 0 ? HoverPosition.RIGHT : HoverPosition.LEFT,
			[ViewContainerLocation.AuxiliaryBar]: sideBarPosition === 0 ? HoverPosition.LEFT : HoverPosition.RIGHT,
			[ViewContainerLocation.ChatBar]: HoverPosition.RIGHT,
			[ViewContainerLocation.Panel]: HoverPosition.ABOVE
		}[viewLocation ?? ViewContainerLocation.AuxiliaryBar];
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		if (!this.sessionsControl || !this.newSessionButtonContainer) {
			return;
		}

		const buttonHeight = this.newSessionButtonContainer.offsetHeight;
		const availableSessionsHeight = height - buttonHeight;
		this.sessionsControl.layout(availableSessionsHeight, width);
	}

	override focus(): void {
		super.focus();

		this.sessionsControl?.focus();
	}

	refresh(): void {
		this.sessionsControl?.refresh();
	}

	openFind(): void {
		this.sessionsControl?.openFind();
	}
}
