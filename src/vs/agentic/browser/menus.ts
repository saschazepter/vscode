/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MenuId } from '../../platform/actions/common/actions.js';

/**
 * Menu IDs for the Agent Sessions workbench layout.
 */
export const Menus = {
	CommandCenter: new MenuId('AgenticWorkbenchCommandCenter'),
	CommandCenterCenter: new MenuId('AgenticWorkbenchCommandCenterCenter'),
	TitleBarContext: new MenuId('AgenticWorkbenchTitleBarContext'),
	TitleBarControlMenu: new MenuId('AgenticWorkbenchTitleBarControlMenu'),
	TitleBarLeft: new MenuId('AgenticWorkbenchTitleBarLeft'),
	TitleBarCenter: new MenuId('AgenticWorkbenchTitleBarCenter'),
	TitleBarRight: new MenuId('AgenticWorkbenchTitleBarRight'),
	OpenSubMenu: new MenuId('AgenticWorkbenchOpenSubMenu'),
	FloatingToolbar: new MenuId('AgenticWorkbenchFloatingToolbar'),
	FloatingToolbarRight: new MenuId('AgenticWorkbenchFloatingToolbarRight'),
	AuxiliaryBarTitleLeft: new MenuId('AgenticWorkbenchAuxiliaryBarTitleLeft')
} as const;
