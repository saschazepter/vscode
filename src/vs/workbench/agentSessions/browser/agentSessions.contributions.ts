/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../base/common/codicons.js';
import { localize2 } from '../../../nls.js';
import { SyncDescriptor } from '../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../platform/theme/common/iconRegistry.js';
import { IViewContainersRegistry, IViewDescriptor, ViewContainerLocation, IViewsRegistry, Extensions as ViewContainerExtensions, LayoutVisibility } from '../../common/views.js';
import { registerChatBranchActions } from './actions/chatBranchSessionAction.js';
import { CHANGES_VIEW_CONTAINER_ID, CHANGES_VIEW_ID, ChangesViewPane, ChangesViewPaneContainer } from './views/changesView.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../common/contributions.js';
import { RunScriptContribution } from '../../contrib/chat/browser/agentSessions/runScriptContribution.js';
import { AgentSessionsTitleBarContribution } from './agentSessionTitleBarWidget.js';
import './aiCustomizationTreeView/aiCustomizationTreeView.contribution.js';
import './aiCustomizationEditor/aiCustomizationEditor.contribution.js';
import './aiCustomizationManagement/aiCustomizationManagement.contribution.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { ChatContextKeys } from '../../contrib/chat/common/actions/chatContextKeys.js';
import { AgentSessionsViewId } from '../../contrib/chat/browser/agentSessions/agentSessions.js';
import { agentSessionsViewContainer, agentSessionsViewIcon, AGENT_SESSIONS_VIEW_TITLE } from '../../contrib/chat/browser/agentSessions/agentSessions.contribution.js';
import { AgentSessionsViewPane } from './views/agentSessionsViewPane.js';

// --- Changes

const changesViewIcon = registerIcon('changes-view-icon', Codicon.gitCompare, localize2('changesViewIcon', 'View icon for the Changes view.').value);

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

const changesViewContainer = viewContainersRegistry.registerViewContainer({
	id: CHANGES_VIEW_CONTAINER_ID,
	title: localize2('changes', 'Changes'),
	ctorDescriptor: new SyncDescriptor(ChangesViewPaneContainer),
	icon: changesViewIcon,
	order: 10,
	hideIfEmpty: true,
	layoutVisibility: LayoutVisibility.AgentSessions
}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: true, isDefault: true });

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

viewsRegistry.registerViews([{
	id: CHANGES_VIEW_ID,
	name: localize2('changes', 'Changes'),
	containerIcon: changesViewIcon,
	ctorDescriptor: new SyncDescriptor(ChangesViewPane),
	canToggleVisibility: true,
	canMoveView: true,
	weight: 100,
	order: 1,
	layoutVisibility: LayoutVisibility.AgentSessions
}], changesViewContainer);

// --- Agent Sessions View Pane Registration

const agentSessionsViewDescriptor: IViewDescriptor = {
	id: AgentSessionsViewId,
	containerIcon: agentSessionsViewIcon,
	containerTitle: AGENT_SESSIONS_VIEW_TITLE.value,
	singleViewPaneContainerTitle: AGENT_SESSIONS_VIEW_TITLE.value,
	name: AGENT_SESSIONS_VIEW_TITLE,
	canToggleVisibility: false,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: AgentSessionsViewId,
		title: AGENT_SESSIONS_VIEW_TITLE
	},
	ctorDescriptor: new SyncDescriptor(AgentSessionsViewPane),
	when: ContextKeyExpr.and(
		ChatContextKeys.Setup.hidden.negate(),
		ChatContextKeys.Setup.disabled.negate(),
		ChatContextKeys.agentSessionsViewerDedicated
	),
	layoutVisibility: LayoutVisibility.Both
};
Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([agentSessionsViewDescriptor], agentSessionsViewContainer);

export function registerAgentWorkbenchContributions() {
	registerChatBranchActions();

	// Workbench contributions
	registerWorkbenchContribution2(RunScriptContribution.ID, RunScriptContribution, WorkbenchPhase.AfterRestored);
	registerWorkbenchContribution2(AgentSessionsTitleBarContribution.ID, AgentSessionsTitleBarContribution, WorkbenchPhase.AfterRestored);
}
