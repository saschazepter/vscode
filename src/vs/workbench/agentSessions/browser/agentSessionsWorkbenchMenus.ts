/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MenuId } from '../../../platform/actions/common/actions.js';

/**
 * Menu IDs for the Agent Sessions workbench layout.
 */
export const AgentSessionsWorkbenchMenus = {
	CommandCenter: new MenuId('AgentSessionsCommandCenter'),
	CommandCenterCenter: new MenuId('AgentSessionsCommandCenterCenter'),
	TitleBarContext: new MenuId('AgentSessionsTitleBarContext'),
	TitleBarControlMenu: new MenuId('AgentSessionsTitleBarControlMenu'),
	TitleBarLeft: new MenuId('AgentSessionsTitleBarLeft'),
	TitleBarCenter: new MenuId('AgentSessionsTitleBarCenter'),
	TitleBarRight: new MenuId('AgentSessionsTitleBarRight'),
	AgentSessionsOpenSubMenu: new MenuId('AgentSessionsOpenSubMenu'),
	FloatingToolbar: new MenuId('AgentSessionsFloatingToolbar'),
	FloatingToolbarRight: new MenuId('AgentSessionsFloatingToolbarRight'),
	AuxiliaryBarTitleLeft: new MenuId('AgentSessionsAuxiliaryBarTitleLeft')
} as const;
