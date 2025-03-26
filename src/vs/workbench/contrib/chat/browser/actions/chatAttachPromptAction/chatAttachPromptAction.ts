/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CHAT_CATEGORY } from '../chatActions.js';
import { localize2 } from '../../../../../../nls.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ChatContextKeys } from '../../../common/chatContextKeys.js';
import { assertDefined } from '../../../../../../base/common/types.js';
import { IPromptsService } from '../../../common/promptSyntax/service/types.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../../../platform/label/common/label.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../../../editor/browser/editorExtensions.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { Action2, MenuId, registerAction2 } from '../../../../../../platform/actions/common/actions.js';
import { attachPrompts, IAttachPromptOptions } from './dialogs/askToSelectPrompt/utils/attachPrompts.js';
import { ISelectPromptOptions, askToSelectPrompt } from './dialogs/askToSelectPrompt/askToSelectPrompt.js';
import { ActiveEditorContext, ResourceContextKey } from '../../../../../common/contextkeys.js';
import { ContextKeyExpr } from '../../../../../../platform/contextkey/common/contextkey.js';
import { TEXT_FILE_EDITOR_ID } from '../../../../files/common/files.js';

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
			precondition: ChatContextKeys.enabled, // TODO: @legomushroom - remove?
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
const runPrompt = async (
	accessor: ServicesAccessor,
	resource: URI,
): Promise<void> => {
	const commandService = accessor.get(ICommandService);

	const options: IChatAttachPromptActionOptions = {
		resource,
		skipSelectionDialog: true,
		// TODO: @lego - add widget type option here
	};

	return await commandService
		.executeCommand(ATTACH_PROMPT_ACTION_ID, options);
};

/**
 * TODO: @legomushroom
 */
// TODO: @lego - condition on the `promptFiles` enablement
const EDITOR_ACTIONS_CONDITION = ContextKeyExpr.and(
	ContextKeyExpr.regex(
		ResourceContextKey.Filename.key,
		/\.prompt\.md$/, // TODO: @lego - add custom instructions file
	),
	ResourceContextKey.HasResource,
	ActiveEditorContext.isEqualTo(TEXT_FILE_EDITOR_ID)
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
			precondition: ChatContextKeys.enabled, // TODO: @legomushroom - remove?
			category: CHAT_CATEGORY,
			icon: Codicon.play,
			menu: [
				{
					id: MenuId.EditorTitleRun,
					group: 'navigation',
					order: 0,
					alt: {
						id: RUN_CURRENT_PROMPT_IN_EDITS_ACTION_ID,
						title: localize2('workbench.action.chat.run-in-edits.prompt.current', "Run Prompt In Edits"),
						icon: Codicon.playCircle,
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
		return await runPrompt(accessor, resource);
	}
}

/**
 * Action ID for the `Run Current Prompt In Edits` action.
 */
export const RUN_CURRENT_PROMPT_IN_EDITS_ACTION_ID = 'workbench.action.chat.run-in-edits.prompt.current';

/**
 * TODO: @legomushroom
 */
class RunCurrentPromptInEditsAction extends Action2 {
	constructor() {
		super({
			id: RUN_CURRENT_PROMPT_IN_EDITS_ACTION_ID,
			title: localize2('workbench.action.chat.run-in-edits.prompt.current.label', "Run Prompt In Edits"),
			f1: false,
			precondition: ChatContextKeys.enabled, // TODO: @legomushroom - remove?
			category: CHAT_CATEGORY,
			icon: Codicon.playCircle,
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
		return await runPrompt(accessor, resource);
	}
}

/**
 * Action ID for the `Run Current Prompt In Agent` action.
 */
export const RUN_CURRENT_PROMPT_IN_AGENT_ACTION_ID = 'workbench.action.chat.run-in-agent.prompt.current';

/**
 * TODO: @legomushroom
 */
class RunCurrentPromptInAgentAction extends Action2 {
	constructor() {
		super({
			id: RUN_CURRENT_PROMPT_IN_AGENT_ACTION_ID,
			title: localize2('workbench.action.chat.run-in-agent.prompt.current.label', "Run Prompt In Agent"),
			f1: false,
			precondition: ChatContextKeys.enabled, // TODO: @legomushroom - remove?
			category: CHAT_CATEGORY,
			icon: Codicon.playCircle,
			menu: [
				{
					id: MenuId.EditorTitleRun,
					group: 'navigation',
					order: 2,
					when: EDITOR_ACTIONS_CONDITION, // TODO: @lego - condition on the `unified` chat view setting
				},
			],
		});
	}

	public override async run(
		accessor: ServicesAccessor,
		resource: URI,
	): Promise<void> {
		return await runPrompt(accessor, resource);
	}
}

/**
 * TODO: @legomushroom
 */
export const registerReusablePromptActions = () => {
	registerAction2(AttachPromptAction);
	registerAction2(RunCurrentPromptAction);
	registerAction2(RunCurrentPromptInEditsAction);
	registerAction2(RunCurrentPromptInAgentAction);
};
