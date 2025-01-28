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

// Command Palette

const category = nls.localize2('chatCategory', "Chat");
appendToCommandPalette({
	id: RUN_PROMPT_COMMAND_ID,
	title: RUN_PROMPT_LABEL,
	category,
});

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
