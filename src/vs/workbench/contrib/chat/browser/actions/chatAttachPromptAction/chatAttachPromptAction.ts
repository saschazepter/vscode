/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CHAT_CATEGORY } from '../chatActions.js';
import { localize2 } from '../../../../../../nls.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ACTION_ID_NEW_CHAT } from '../chatClearActions.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { assertDefined } from '../../../../../../base/common/types.js';
import { TEXT_FILE_EDITOR_ID } from '../../../../files/common/files.js';
import { IPromptsService } from '../../../common/promptSyntax/service/types.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../../../platform/label/common/label.js';
import { PromptsConfig } from '../../../../../../platform/prompts/common/config.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../../../editor/browser/editorExtensions.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ChatContextKeyExprs, ChatContextKeys } from '../../../common/chatContextKeys.js';
import { ContextKeyExpr } from '../../../../../../platform/contextkey/common/contextkey.js';
import { ActiveEditorContext, ResourceContextKey } from '../../../../../common/contextkeys.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { Action2, MenuId, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { attachPrompts, IAttachPromptOptions } from './dialogs/askToSelectPrompt/utils/attachPrompts.js';
import { ISelectPromptOptions, askToSelectPrompt } from './dialogs/askToSelectPrompt/askToSelectPrompt.js';


/**
 * TODO: @legomushroom - list
 * - use a base class instead of the `runPrompt` function
 * - "new chat" command should remove attached prompts
 */

/**
 * Action ID for the `Attach Prompt` action.
 */
export const ATTACH_PROMPT_ACTION_ID = 'workbench.action.chat.attach.prompt';

/**
 * Options for the {@link AttachPromptAction} action.
 */
export interface IChatAttachPromptActionOptions extends Pick<
	ISelectPromptOptions, 'resource' | 'widget'
> {
	/**
	 * TODO: @legomushroom
	 */
	skipSelectionDialog?: boolean;
}

/**
 * Action to attach a prompt to a chat widget input.
 */
class AttachPromptAction extends Action2 {
	constructor() {
		super({
			id: ATTACH_PROMPT_ACTION_ID,
			title: localize2('workbench.action.chat.attach.prompt.label', "Use Prompt"),
			f1: false,
			precondition: ContextKeyExpr.and(PromptsConfig.enabledCtx, ChatContextKeys.enabled),
			category: CHAT_CATEGORY,
		});
	}

	public override async run(
		accessor: ServicesAccessor,
		options: IChatAttachPromptActionOptions,
	): Promise<void> {
		const fileService = accessor.get(IFileService);
		const labelService = accessor.get(ILabelService);
		const viewsService = accessor.get(IViewsService);
		const openerService = accessor.get(IOpenerService);
		const dialogService = accessor.get(IDialogService);
		const promptsService = accessor.get(IPromptsService);
		const quickInputService = accessor.get(IQuickInputService);

		const { skipSelectionDialog, resource } = options;

		if (!skipSelectionDialog) {
			// find all prompt files in the user workspace
			const promptFiles = await promptsService.listPromptFiles();

			// ask user to select a file from the list
			return await askToSelectPrompt({
				...options,
				promptFiles,
				fileService,
				viewsService,
				labelService,
				dialogService,
				openerService,
				quickInputService,
			});
		}

		assertDefined(
			resource,
			'Resource must be defined when skipping prompt selection dialog.',
		);

		/**
		 * TODO: @legomushroom - get a real `alt` value
		 */
		const alt = false;
		const attachOptions: IAttachPromptOptions = {
			widget: options.widget,
			viewsService,
		};

		const widget = await attachPrompts(
			[{ value: resource }],
			attachOptions,
			alt,
		);

		widget.focusInput();
	}
}

/**
 * TODO: @legomushroom
 */
export interface IRunPromptOptions {
	resource: URI;
	inNewChat: boolean;
}

/**
 * TODO: @legomushroom
 */
const runPrompt = async (
	accessor: ServicesAccessor,
	options: IRunPromptOptions,
): Promise<void> => {
	const commandService = accessor.get(ICommandService);
	const { resource, inNewChat } = options;

	if (inNewChat) {
		await commandService
			.executeCommand(ACTION_ID_NEW_CHAT);
	}


	const attachOptions: IChatAttachPromptActionOptions = {
		resource,
		skipSelectionDialog: true,
		// TODO: @lego - add widget type option here
	};

	return await commandService
		.executeCommand(ATTACH_PROMPT_ACTION_ID, attachOptions);
};

/**
 * TODO: @legomushroom
 */
const EDITOR_ACTIONS_CONDITION = ContextKeyExpr.and(
	ContextKeyExpr.and(PromptsConfig.enabledCtx, ChatContextKeys.enabled),
	ChatContextKeyExprs.unifiedChatEnabled,
	ResourceContextKey.HasResource,
	ContextKeyExpr.regex(
		ResourceContextKey.Filename.key,
		/\.prompt\.md$/, // TODO: @lego - add custom instructions file
	),
	ActiveEditorContext.isEqualTo(TEXT_FILE_EDITOR_ID),
);

/**
 * Action ID for the `Run Current Prompt` action.
 */
export const RUN_CURRENT_PROMPT_ACTION_ID = 'workbench.action.chat.run.prompt.current';

/**
 * TODO: @legomushroom
 */
class RunCurrentPromptAction extends Action2 {
	constructor() {
		super({
			id: RUN_CURRENT_PROMPT_ACTION_ID,
			title: localize2('workbench.action.chat.run.prompt.current.label', "Run Prompt"),
			f1: false,
			precondition: ContextKeyExpr.and(PromptsConfig.enabledCtx, ChatContextKeys.enabled),
			category: CHAT_CATEGORY,
			icon: Codicon.play,
			menu: [
				{
					id: MenuId.EditorTitleRun,
					group: 'navigation',
					order: 0,
					alt: {
						id: RUN_CURRENT_PROMPT_IN_NEW_CHAT_ACTION_ID,
						title: RUN_IN_NEW_CHAT_ACTION_TITLE,
						icon: RUN_IN_NEW_CHAT_ACTION_ICON,
					},
					when: EDITOR_ACTIONS_CONDITION,
				},
			],
		});
	}

	public override async run(
		accessor: ServicesAccessor,
		resource: URI,
	): Promise<void> {
		return await runPrompt(
			accessor,
			{
				resource,
				inNewChat: false,
			},
		);
	}
}

/**
 * Action ID for the `Run Current Prompt In New Chat` action.
 */
export const RUN_CURRENT_PROMPT_IN_NEW_CHAT_ACTION_ID = 'workbench.action.chat.run-in-new-chat.prompt.current';

const RUN_IN_NEW_CHAT_ACTION_TITLE = localize2(
	'workbench.action.chat.run-in-new-chat.prompt.current.label',
	"Run Prompt In New Chat",
);

/**
 * TODO: @legomushroom
 */
const RUN_IN_NEW_CHAT_ACTION_ICON = Codicon.playCircle;

/**
 * TODO: @legomushroom
 */
class RunCurrentPromptInNewChatAction extends Action2 {
	constructor() {
		super({
			id: RUN_CURRENT_PROMPT_IN_NEW_CHAT_ACTION_ID,
			title: RUN_IN_NEW_CHAT_ACTION_TITLE,
			f1: false,
			precondition: ContextKeyExpr.and(PromptsConfig.enabledCtx, ChatContextKeys.enabled),
			category: CHAT_CATEGORY,
			icon: RUN_IN_NEW_CHAT_ACTION_ICON,
			menu: [
				{
					id: MenuId.EditorTitleRun,
					group: 'navigation',
					order: 1,
					when: EDITOR_ACTIONS_CONDITION,
				},
			],
		});
	}

	public override async run(
		accessor: ServicesAccessor,
		resource: URI,
	): Promise<void> {
		return await runPrompt(
			accessor,
			{
				resource,
				inNewChat: true,
			},
		);
	}
}

/**
 * TODO: @legomushroom
 */
export const registerReusablePromptActions = () => {
	registerAction2(AttachPromptAction);
	registerAction2(RunCurrentPromptAction);
	registerAction2(RunCurrentPromptInNewChatAction);
};
