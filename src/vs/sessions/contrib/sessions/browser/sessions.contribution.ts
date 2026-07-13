/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IViewDescriptor, IViewsRegistry, Extensions as ViewContainerExtensions, WindowEnablement, ViewContainer, IViewContainersRegistry, ViewContainerLocation } from '../../../../workbench/common/views.js';
import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { SessionsTitleBarContribution } from './sessionsTitleBarWidget.js';
import { SessionsTelemetryContribution } from './sessionsTelemetry.contribution.js';
import { NewSessionActionViewItemContribution, SessionConversationsMenuContribution, SessionNewChatActionViewItemContribution } from './sessionsActions.js';
import { SessionsView, SessionsViewId } from './views/sessionsView.js';
import './views/sessionsViewActions.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SESSIONS_LIST_SHOW_EMPTY_DEFAULT_GROUPS_SETTING } from './views/sessionsList.js';

const agentSessionsViewIcon = registerIcon('chat-sessions-icon', Codicon.commentDiscussionSparkle, localize('agentSessionsViewIcon', 'Icon for Agent Sessions View'));
const AGENT_SESSIONS_VIEW_TITLE = localize2('agentSessions.view.label', "Sessions");
const SessionsContainerId = 'agentic.workbench.view.sessionsContainer';

const agentSessionsViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: SessionsContainerId,
	title: AGENT_SESSIONS_VIEW_TITLE,
	icon: agentSessionsViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SessionsContainerId, { mergeViewWithContainerWhenSingleView: true, }]),
	storageId: SessionsContainerId,
	hideIfEmpty: true,
	order: 6,
	openCommandActionDescriptor: {
		id: SessionsContainerId,
		mnemonicTitle: localize({ key: 'miSessions', comment: ['&& denotes a mnemonic'] }, "&&Sessions"),
		keybindings: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyX },
		order: 0
	},
	windowEnablement: WindowEnablement.Sessions
}, ViewContainerLocation.Sidebar, { isDefault: true });

const sessionsViewPaneDescriptor: IViewDescriptor = {
	id: SessionsViewId,
	containerIcon: agentSessionsViewIcon,
	containerTitle: AGENT_SESSIONS_VIEW_TITLE.value,
	singleViewPaneContainerTitle: AGENT_SESSIONS_VIEW_TITLE.value,
	name: AGENT_SESSIONS_VIEW_TITLE,
	canToggleVisibility: true,
	canMoveView: false,
	ctorDescriptor: new SyncDescriptor(SessionsView),
	windowEnablement: WindowEnablement.Sessions
};

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([sessionsViewPaneDescriptor], agentSessionsViewContainer);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'sessions',
	properties: {
		[SESSIONS_LIST_SHOW_EMPTY_DEFAULT_GROUPS_SETTING]: {
			type: 'boolean',
			tags: ['preview'],
			description: localize('sessions.list.showEmptyDefaultGroups', "Controls whether the Chats group is shown in the sessions list even when it is empty."),
			default: true,
			experiment: { mode: 'auto' }
		},
	},
});

registerWorkbenchContribution2(SessionsTitleBarContribution.ID, SessionsTitleBarContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(NewSessionActionViewItemContribution.ID, NewSessionActionViewItemContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(SessionsTelemetryContribution.ID, SessionsTelemetryContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(SessionConversationsMenuContribution.ID, SessionConversationsMenuContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(SessionNewChatActionViewItemContribution.ID, SessionNewChatActionViewItemContribution, WorkbenchPhase.AfterRestored);

//#region Automations Editor Registration

import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../workbench/browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AutomationsEditorPane, AutomationsEditorInput, AUTOMATIONS_EDITOR_ID, AUTOMATIONS_EDITOR_INPUT_ID } from './views/automationsEditor.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AutomationsEditorPane,
		AUTOMATIONS_EDITOR_ID,
		localize('automationsEditor', "Automations")
	),
	[
		new SyncDescriptor(AutomationsEditorInput as unknown as { new(): AutomationsEditorInput })
	]
);

class AutomationsEditorInputSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof AutomationsEditorInput;
	}
	serialize(_input: AutomationsEditorInput): string {
		return '';
	}
	deserialize(_instantiationService: IInstantiationService): AutomationsEditorInput {
		return AutomationsEditorInput.getOrCreate();
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	AUTOMATIONS_EDITOR_INPUT_ID,
	AutomationsEditorInputSerializer
);

//#endregion
