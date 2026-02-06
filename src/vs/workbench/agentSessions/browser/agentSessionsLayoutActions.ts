/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { alert } from '../../../base/browser/ui/aria/aria.js';
import { Codicon } from '../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../nls.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { registerIcon } from '../../../platform/theme/common/iconRegistry.js';
import { AuxiliaryBarVisibleContext, PanelMaximizedContext, SideBarVisibleContext } from '../../common/contextkeys.js';
import { IWorkbenchLayoutService, Parts } from '../../services/layout/browser/layoutService.js';

// Register Icons
const panelLeftIcon = registerIcon('agent-panel-left', Codicon.layoutSidebarLeft, localize('panelLeft', "Represents a side bar in the left position"));
const panelLeftOffIcon = registerIcon('agent-panel-left-off', Codicon.layoutSidebarLeftOff, localize('panelLeftOff', "Represents a side bar in the left position that is hidden"));
const panelRightIcon = registerIcon('agent-panel-right', Codicon.layoutSidebarRight, localize('panelRight', "Represents a secondary side bar in the right position"));
const panelRightOffIcon = registerIcon('agent-panel-right-off', Codicon.layoutSidebarRightOff, localize('panelRightOff', "Represents a secondary side bar in the right position that is hidden"));
const panelCloseIcon = registerIcon('agent-panel-close', Codicon.close, localize('agentPanelCloseIcon', "Icon to close the panel."));
const panelMaximizeIcon = registerIcon('agent-panel-maximize', Codicon.screenFull, localize('agentPanelMaximizeIcon', 'Icon to maximize the panel.'));
const panelRestoreIcon = registerIcon('agent-panel-restore', Codicon.screenNormal, localize('agentPanelRestoreIcon', 'Icon to restore the panel size.'));

class ToggleSidebarVisibilityAction extends Action2 {

	static readonly ID = 'workbench.action.agentToggleSidebarVisibility';
	static readonly LABEL = localize('compositePart.hideSideBarLabel', "Hide Primary Side Bar");

	constructor() {
		super({
			id: ToggleSidebarVisibilityAction.ID,
			title: localize2('toggleSidebar', 'Toggle Primary Side Bar Visibility'),
			icon: panelLeftOffIcon,
			toggled: {
				condition: SideBarVisibleContext,
				icon: panelLeftIcon,
				title: localize('primary sidebar', "Primary Side Bar"),
				mnemonicTitle: localize({ key: 'primary sidebar mnemonic', comment: ['&& denotes a mnemonic'] }, "&&Primary Side Bar"),
			},
			metadata: {
				description: localize('openAndCloseSidebar', 'Open/Show and Close/Hide Sidebar'),
			},
			category: Categories.View,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyB
			},
			menu: [
				{
					id: MenuId.TitleBarLeft,
					group: 'navigation',
					order: 0
				}
			]
		});
	}

	run(accessor: ServicesAccessor): void {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const isCurrentlyVisible = layoutService.isVisible(Parts.SIDEBAR_PART);

		layoutService.setPartHidden(isCurrentlyVisible, Parts.SIDEBAR_PART);

		// Announce visibility change to screen readers
		const alertMessage = isCurrentlyVisible
			? localize('sidebarHidden', "Primary Side Bar hidden")
			: localize('sidebarVisible', "Primary Side Bar shown");
		alert(alertMessage);
	}
}

class ToggleSecondarySidebarVisibilityAction extends Action2 {

	static readonly ID = 'workbench.action.agentToggleSecondarySidebarVisibility';
	static readonly LABEL = localize('compositePart.hideSecondarySideBarLabel', "Hide Secondary Side Bar");

	constructor() {
		super({
			id: ToggleSecondarySidebarVisibilityAction.ID,
			title: localize2('toggleSecondarySidebar', 'Toggle Secondary Side Bar Visibility'),
			icon: panelRightOffIcon,
			toggled: {
				condition: AuxiliaryBarVisibleContext,
				icon: panelRightIcon,
				title: localize('secondary sidebar', "Secondary Side Bar"),
				mnemonicTitle: localize({ key: 'secondary sidebar mnemonic', comment: ['&& denotes a mnemonic'] }, "&&Secondary Side Bar"),
			},
			metadata: {
				description: localize('openAndCloseSecondarySidebar', 'Open/Show and Close/Hide Secondary Side Bar'),
			},
			category: Categories.View,
			f1: true,
			menu: [
				{
					id: MenuId.TitleBar,
					group: 'navigation',
					order: 10
				}
			]
		});
	}

	run(accessor: ServicesAccessor): void {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const isCurrentlyVisible = layoutService.isVisible(Parts.AUXILIARYBAR_PART);

		layoutService.setPartHidden(isCurrentlyVisible, Parts.AUXILIARYBAR_PART);

		// Announce visibility change to screen readers
		const alertMessage = isCurrentlyVisible
			? localize('secondarySidebarHidden', "Secondary Side Bar hidden")
			: localize('secondarySidebarVisible', "Secondary Side Bar shown");
		alert(alertMessage);
	}
}

class TogglePanelVisibilityAction extends Action2 {

	static readonly ID = 'workbench.action.agentTogglePanelVisibility';

	constructor() {
		super({
			id: TogglePanelVisibilityAction.ID,
			title: localize2('togglePanel', 'Toggle Panel Visibility'),
			category: Categories.View,
			f1: true,
			icon: panelCloseIcon,
			menu: [
				{
					id: MenuId.PanelTitle,
					group: 'navigation',
					order: 2
				}
			]
		});
	}

	run(accessor: ServicesAccessor): void {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		layoutService.setPartHidden(layoutService.isVisible(Parts.PANEL_PART), Parts.PANEL_PART);
	}
}

class TogglePanelMaximizedAction extends Action2 {

	static readonly ID = 'workbench.action.agentTogglePanelMaximized';
	static readonly LABEL = localize('compositePart.maximizePanelLabel', "Maximize Panel");

	constructor() {
		super({
			id: TogglePanelMaximizedAction.ID,
			title: localize2('togglePanelMaximized', 'Toggle Panel Maximized'),
			icon: panelMaximizeIcon,
			toggled: {
				condition: PanelMaximizedContext,
				icon: panelRestoreIcon,
				title: localize('restorePanel', "Restore Panel Size"),
				mnemonicTitle: localize({ key: 'restorePanelMnemonic', comment: ['&& denotes a mnemonic'] }, "&&Restore Panel Size"),
			},
			metadata: {
				description: localize('maximizeAndRestorePanel', 'Maximize and Restore Panel Size'),
			},
			category: Categories.View,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyJ
			},
			menu: [
				{
					id: MenuId.PanelTitle,
					group: 'navigation',
					order: 1
				}
			]
		});
	}

	run(accessor: ServicesAccessor): void {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const isCurrentlyVisible = layoutService.isVisible(Parts.PANEL_PART);

		layoutService.toggleMaximizedPanel();

		// Announce visibility change to screen readers
		const alertMessage = isCurrentlyVisible
			? localize('panelHidden', "Panel maximized")
			: localize('panelVisible', "Panel minimized");
		alert(alertMessage);
	}
}

export function registerAgentSessionsLayoutActions() {
	registerAction2(ToggleSidebarVisibilityAction);
	registerAction2(ToggleSecondarySidebarVisibilityAction);
	registerAction2(TogglePanelVisibilityAction);
	registerAction2(TogglePanelMaximizedAction);
}
