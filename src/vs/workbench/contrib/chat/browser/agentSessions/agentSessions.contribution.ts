/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './experiments/agentSessionsExperiments.contribution.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions as QuickAccessExtensions, IQuickAccessRegistry } from '../../../../../platform/quickinput/common/quickAccess.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IAgentSessionsService, AgentSessionsService } from './agentSessionsService.js';
import { LocalAgentsSessionsProvider } from './localAgentSessionsProvider.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ISubmenuItem, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ArchiveAgentSessionAction, ArchiveAgentSessionSectionAction, UnarchiveAgentSessionAction, OpenAgentSessionInEditorGroupAction, OpenAgentSessionInNewEditorGroupAction, OpenAgentSessionInNewWindowAction, ShowAgentSessionsSidebar, HideAgentSessionsSidebar, ToggleAgentSessionsSidebar, RefreshAgentSessionsViewerAction, FindAgentSessionInViewerAction, MarkAgentSessionUnreadAction, MarkAgentSessionReadAction, FocusAgentSessionsAction, SetAgentSessionsOrientationStackedAction, SetAgentSessionsOrientationSideBySideAction, PickAgentSessionAction, ArchiveAllAgentSessionsAction, MarkAllAgentSessionsReadAction, RenameAgentSessionAction, DeleteAgentSessionAction, DeleteAllLocalSessionsAction, MarkAgentSessionSectionReadAction, ToggleShowAgentSessionsAction, UnarchiveAgentSessionSectionAction } from './agentSessionsActions.js';
import { AgentSessionsQuickAccessProvider, AGENT_SESSIONS_QUICK_ACCESS_PREFIX } from './agentSessionsQuickAccess.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ChatSessionsPartVisibleContext, IsAuxiliaryWindowContext } from '../../../../common/contextkeys.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';

//#region Actions and Menus

registerAction2(FocusAgentSessionsAction);
registerAction2(PickAgentSessionAction);
registerAction2(ArchiveAllAgentSessionsAction);
registerAction2(MarkAllAgentSessionsReadAction);
registerAction2(ArchiveAgentSessionSectionAction);
registerAction2(UnarchiveAgentSessionSectionAction);
registerAction2(MarkAgentSessionSectionReadAction);
registerAction2(ArchiveAgentSessionAction);
registerAction2(UnarchiveAgentSessionAction);
registerAction2(RenameAgentSessionAction);
registerAction2(DeleteAgentSessionAction);
registerAction2(DeleteAllLocalSessionsAction);
registerAction2(MarkAgentSessionUnreadAction);
registerAction2(MarkAgentSessionReadAction);
registerAction2(OpenAgentSessionInNewWindowAction);
registerAction2(OpenAgentSessionInEditorGroupAction);
registerAction2(OpenAgentSessionInNewEditorGroupAction);
registerAction2(RefreshAgentSessionsViewerAction);
registerAction2(FindAgentSessionInViewerAction);
registerAction2(ShowAgentSessionsSidebar);
registerAction2(HideAgentSessionsSidebar);
registerAction2(ToggleAgentSessionsSidebar);
registerAction2(ToggleShowAgentSessionsAction);
registerAction2(SetAgentSessionsOrientationStackedAction);
registerAction2(SetAgentSessionsOrientationSideBySideAction);

// --- Agent Sessions Toolbar

MenuRegistry.appendMenuItem(MenuId.AgentSessionsToolbar, {
	submenu: MenuId.AgentSessionsViewerFilterSubMenu,
	title: localize2('filterAgentSessions', "Filter Agent Sessions"),
	group: 'navigation',
	order: 3,
	icon: Codicon.treeFilterOnTypeOn,
} satisfies ISubmenuItem);

// --- Layout Control Menu: Toggle Agent Sessions (replaces auxiliary bar toggle on the left)

const chatSessionsLeftIcon = registerIcon('chatsessions-left-layout-icon', Codicon.layoutSidebarLeft, localize('toggleChatSessionsIconLeft', 'Icon to toggle the agent sessions list in its left position.'));
const chatSessionsLeftOffIcon = registerIcon('chatsessions-left-off-layout-icon', Codicon.layoutSidebarLeftOff, localize('toggleChatSessionsIconLeftOff', 'Icon to toggle the agent sessions list off in its left position.'));

MenuRegistry.appendMenuItem(MenuId.LayoutControlMenu, {
	group: '2_pane_toggles',
	command: {
		id: ToggleAgentSessionsSidebar.ID,
		title: localize('toggleAgentSessionsList', "Toggle Agent Sessions"),
		toggled: { condition: ChatSessionsPartVisibleContext, icon: chatSessionsLeftIcon },
		icon: chatSessionsLeftOffIcon,
	},
	when: ContextKeyExpr.and(
		IsAuxiliaryWindowContext.negate(),
		ChatContextKeys.enabled,
		ContextKeyExpr.or(
			ContextKeyExpr.equals('config.workbench.layoutControl.type', 'toggles'),
			ContextKeyExpr.equals('config.workbench.layoutControl.type', 'both')),
		ContextKeyExpr.equals('config.workbench.sideBar.location', 'right')
	),
	order: 0
});

//#endregion

//#region Quick Access

Registry.as<IQuickAccessRegistry>(QuickAccessExtensions.Quickaccess).registerQuickAccessProvider({
	ctor: AgentSessionsQuickAccessProvider,
	prefix: AGENT_SESSIONS_QUICK_ACCESS_PREFIX,
	contextKey: 'inAgentSessionsPicker',
	when: ChatContextKeys.enabled,
	placeholder: localize('agentSessionsQuickAccessPlaceholder', "Search agent sessions by name"),
	helpEntries: [{
		description: localize('agentSessionsQuickAccessHelp', "Show All Agent Sessions"),
		commandId: 'workbench.action.chat.history',
	}]
});

//#endregion

//#region Workbench Contributions

registerWorkbenchContribution2(LocalAgentsSessionsProvider.ID, LocalAgentsSessionsProvider, WorkbenchPhase.AfterRestored);

registerSingleton(IAgentSessionsService, AgentSessionsService, InstantiationType.Delayed);

//#endregion
