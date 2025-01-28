/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../../../nls.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ChatAgentLocation } from '../../../common/chatAgents.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { ResourceContextKey } from '../../../../../common/contextkeys.js';
import { KeyMod, KeyCode } from '../../../../../../base/common/keyCodes.js';
import { IListService } from '../../../../../../platform/list/browser/listService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { EditorContextKeys } from '../../../../../../editor/common/editorContextKeys.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../../../platform/contextkey/common/contextkey.js';
import { MenuId, MenuRegistry } from '../../../../../../platform/actions/common/actions.js';
import { getMultiSelectedResources, IExplorerService } from '../../../../files/browser/files.js';
import { ServicesAccessor } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { IChatRunPromptActionOptions, RUN_PROMPT_ACTION_ID } from '../../actions/chatContextActions.js';
import { appendEditorTitleContextMenuItem, appendToCommandPalette } from '../../../../files/browser/fileActions.contribution.js';
import { PROMP_SNIPPET_FILE_EXTENSION } from '../../../common/promptSyntax/contentProviders/promptContentsProviderBase.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../../../platform/keybinding/common/keybindingsRegistry.js';

export const RUN_PROMPT_COMMAND_ID = 'runPrompt';
const RUN_PROMPT_LABEL = nls.localize2('runPrompt', "Run Prompt");
const RUN_PROMPT_WHEN_CONTEXT = ContextKeyExpr.or(
	ResourceContextKey.Scheme.isEqualTo(Schemas.file),
	ResourceContextKey.Extension.isEqualTo(PROMP_SNIPPET_FILE_EXTENSION),
);

const handleRunPromptResource = async (accessor: ServicesAccessor, resource: URI) => {
	const commandService = accessor.get(ICommandService);

	const resources = getMultiSelectedResources(resource, accessor.get(IListService), accessor.get(IEditorService), accessor.get(IEditorGroupsService), accessor.get(IExplorerService));

	const options: IChatRunPromptActionOptions = {
		resources,
		location: ChatAgentLocation.Panel,
	};

	await commandService.executeCommand(RUN_PROMPT_ACTION_ID, options);
};

KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: RUN_PROMPT_COMMAND_ID,
	weight: KeybindingWeight.WorkbenchContrib,
	when: EditorContextKeys.focus.toNegated(),
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyR,
	// TODO: @legomushroom - add windows support keybinding
	// win: {
	// 	primary: KeyMod.Shift | KeyMod.Alt | KeyCode.KeyR
	// },
	handler: async (accessor: ServicesAccessor, resource?: URI) => {
		if (resource) {
			return await handleRunPromptResource(accessor, resource);
		}

		const commandService = accessor.get(ICommandService);
		const options: IChatRunPromptActionOptions = {
			location: ChatAgentLocation.Panel,
		};

		await commandService.executeCommand(RUN_PROMPT_ACTION_ID, options);
	}
});

// const REVEAL_ACTIVE_FILE_IN_OS_COMMAND_ID = 'workbench.action.files.revealActiveFileInWindows';

// KeybindingsRegistry.registerCommandAndKeybindingRule({
// 	weight: KeybindingWeight.WorkbenchContrib,
// 	when: undefined,
// 	primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyR),
// 	id: REVEAL_ACTIVE_FILE_IN_OS_COMMAND_ID,
// 	handler: (accessor: ServicesAccessor) => {
// 		const editorService = accessor.get(IEditorService);
// 		const activeInput = editorService.activeEditor;
// 		const resource = EditorResourceAccessor.getOriginalUri(activeInput, { filterByScheme: Schemas.file, supportSideBySide: SideBySideEditor.PRIMARY });
// 		const resources = resource ? [resource] : [];
// 		revealResourcesInOS(resources, accessor.get(INativeHostService), accessor.get(IWorkspaceContextService));
// 	}
// });

appendEditorTitleContextMenuItem(RUN_PROMPT_COMMAND_ID, RUN_PROMPT_LABEL.value, RUN_PROMPT_WHEN_CONTEXT, '2_files', false, 0);

// Menu registration - explorer

MenuRegistry.appendMenuItem(MenuId.ExplorerContext, {
	group: 'navigation',
	order: 20,
	command: {
		id: RUN_PROMPT_COMMAND_ID,
		title: RUN_PROMPT_LABEL.value
	},
	when: RUN_PROMPT_WHEN_CONTEXT
});

// Command Palette

const category = nls.localize2('chatCategory', "Chat");
appendToCommandPalette({
	id: RUN_PROMPT_COMMAND_ID,
	title: RUN_PROMPT_LABEL,
	category: category
});

// // Menu registration - open editors

// const revealInOsCommand = {
// 	id: REVEAL_IN_OS_COMMAND_ID,
// 	title: REVEAL_IN_OS_LABEL.value
// };
// MenuRegistry.appendMenuItem(MenuId.OpenEditorsContext, {
// 	group: 'navigation',
// 	order: 20,
// 	command: revealInOsCommand,
// 	when: REVEAL_IN_OS_WHEN_CONTEXT
// });
// MenuRegistry.appendMenuItem(MenuId.OpenEditorsContextShare, {
// 	title: nls.localize('miShare', "Share"),
// 	submenu: MenuId.MenubarShare,
// 	group: 'share',
// 	order: 3,
// });

// // Menu registration - chat attachments context

// MenuRegistry.appendMenuItem(MenuId.ChatAttachmentsContext, {
// 	group: 'navigation',
// 	order: 20,
// 	command: revealInOsCommand,
// 	when: REVEAL_IN_OS_WHEN_CONTEXT
// });

// // Menu registration - chat inline anchor

// MenuRegistry.appendMenuItem(MenuId.ChatInlineResourceAnchorContext, {
// 	group: 'navigation',
// 	order: 20,
// 	command: revealInOsCommand,
// 	when: REVEAL_IN_OS_WHEN_CONTEXT
// });
