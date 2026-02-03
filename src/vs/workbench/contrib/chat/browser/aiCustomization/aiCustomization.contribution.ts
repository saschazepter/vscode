/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainerLocation } from '../../../../common/views.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { AgentsViewItemMenuId, AI_CUSTOMIZATION_AGENTS_VIEW_ID, AI_CUSTOMIZATION_CATEGORY, AI_CUSTOMIZATION_INSTRUCTIONS_VIEW_ID, AI_CUSTOMIZATION_PROMPTS_VIEW_ID, AI_CUSTOMIZATION_SKILLS_VIEW_ID, AI_CUSTOMIZATION_STORAGE_ID, AI_CUSTOMIZATION_VIEWLET_ID, InstructionsViewItemMenuId, PromptsViewItemMenuId, SkillsViewItemMenuId } from './aiCustomization.js';
import { aiCustomizationViewIcon } from './aiCustomizationIcons.js';
import { CustomAgentsViewPane, InstructionsViewPane, PromptsViewPane, SkillsViewPane } from './aiCustomizationViews.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { PromptFilePickers } from '../promptSyntax/pickers/promptFilePickers.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { URI } from '../../../../../base/common/uri.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';

//#region View Container Registration

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

export const AI_CUSTOMIZATION_VIEW_CONTAINER = viewContainersRegistry.registerViewContainer(
	{
		id: AI_CUSTOMIZATION_VIEWLET_ID,
		title: localize2('aiCustomization', "AI Customization"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AI_CUSTOMIZATION_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: false }]),
		icon: aiCustomizationViewIcon,
		order: 10,
		hideIfEmpty: false,
		storageId: AI_CUSTOMIZATION_STORAGE_ID,
		alwaysUseContainerInfo: true,
		openCommandActionDescriptor: {
			id: AI_CUSTOMIZATION_VIEWLET_ID,
			mnemonicTitle: localize({ key: 'miViewAICustomization', comment: ['&& denotes a mnemonic'] }, "AI &&Customization"),
			keybindings: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI },
			order: 10,
		},
	},
	ViewContainerLocation.Sidebar
);

//#endregion

//#region Views Registration

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

// Custom Agents View
const customAgentsViewDescriptor: IViewDescriptor = {
	id: AI_CUSTOMIZATION_AGENTS_VIEW_ID,
	name: localize2('customAgents', "Custom Agents"),
	ctorDescriptor: new SyncDescriptor(CustomAgentsViewPane),
	containerIcon: aiCustomizationViewIcon,
	canToggleVisibility: true,
	canMoveView: true,
	order: 1,
	when: ChatContextKeys.enabled,
};

// Skills View
const skillsViewDescriptor: IViewDescriptor = {
	id: AI_CUSTOMIZATION_SKILLS_VIEW_ID,
	name: localize2('skills', "Skills"),
	ctorDescriptor: new SyncDescriptor(SkillsViewPane),
	containerIcon: aiCustomizationViewIcon,
	canToggleVisibility: true,
	canMoveView: true,
	order: 2,
	when: ChatContextKeys.enabled,
};

// Instructions View
const instructionsViewDescriptor: IViewDescriptor = {
	id: AI_CUSTOMIZATION_INSTRUCTIONS_VIEW_ID,
	name: localize2('instructions', "Instructions"),
	ctorDescriptor: new SyncDescriptor(InstructionsViewPane),
	containerIcon: aiCustomizationViewIcon,
	canToggleVisibility: true,
	canMoveView: true,
	order: 3,
	when: ChatContextKeys.enabled,
};

// Prompts View
const promptsViewDescriptor: IViewDescriptor = {
	id: AI_CUSTOMIZATION_PROMPTS_VIEW_ID,
	name: localize2('prompts', "Prompts"),
	ctorDescriptor: new SyncDescriptor(PromptsViewPane),
	containerIcon: aiCustomizationViewIcon,
	canToggleVisibility: true,
	canMoveView: true,
	order: 4,
	when: ChatContextKeys.enabled,
};

viewsRegistry.registerViews([
	customAgentsViewDescriptor,
	skillsViewDescriptor,
	instructionsViewDescriptor,
	promptsViewDescriptor,
], AI_CUSTOMIZATION_VIEW_CONTAINER);

//#endregion

//#region Welcome Content

viewsRegistry.registerViewWelcomeContent(AI_CUSTOMIZATION_AGENTS_VIEW_ID, {
	content: localize('noAgents', "No custom agents found.\n[Create Agent](command:workbench.command.new.agent)"),
	when: ContextKeyExpr.deserialize('default'),
});

viewsRegistry.registerViewWelcomeContent(AI_CUSTOMIZATION_SKILLS_VIEW_ID, {
	content: localize('noSkills', "No skills found.\n[Create Skill](command:workbench.command.new.skill)"),
	when: ContextKeyExpr.deserialize('default'),
});

viewsRegistry.registerViewWelcomeContent(AI_CUSTOMIZATION_INSTRUCTIONS_VIEW_ID, {
	content: localize('noInstructions', "No instruction files found.\n[Create Instructions](command:workbench.command.new.instructions)"),
	when: ContextKeyExpr.deserialize('default'),
});

viewsRegistry.registerViewWelcomeContent(AI_CUSTOMIZATION_PROMPTS_VIEW_ID, {
	content: localize('noPrompts', "No prompt files found.\n[Create Prompt](command:workbench.command.new.prompt)"),
	when: ContextKeyExpr.deserialize('default'),
});

//#endregion

//#region View Title Menu Actions

// Add "New" button to each view's title bar
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: { id: 'workbench.command.new.agent', title: localize('newAgent', "New Agent"), icon: Codicon.add },
	when: ContextKeyExpr.equals('view', AI_CUSTOMIZATION_AGENTS_VIEW_ID),
	group: 'navigation',
	order: 1,
});

MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: { id: 'workbench.command.new.skill', title: localize('newSkill', "New Skill"), icon: Codicon.add },
	when: ContextKeyExpr.equals('view', AI_CUSTOMIZATION_SKILLS_VIEW_ID),
	group: 'navigation',
	order: 1,
});

MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: { id: 'workbench.command.new.instructions', title: localize('newInstructions', "New Instructions"), icon: Codicon.add },
	when: ContextKeyExpr.equals('view', AI_CUSTOMIZATION_INSTRUCTIONS_VIEW_ID),
	group: 'navigation',
	order: 1,
});

MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	command: { id: 'workbench.command.new.prompt', title: localize('newPrompt', "New Prompt"), icon: Codicon.add },
	when: ContextKeyExpr.equals('view', AI_CUSTOMIZATION_PROMPTS_VIEW_ID),
	group: 'navigation',
	order: 1,
});

//#endregion

//#region Context Menu Actions

// Open file action (shared across all views)
const OPEN_AI_CUSTOMIZATION_FILE_ID = 'aiCustomization.openFile';
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_AI_CUSTOMIZATION_FILE_ID,
			title: localize2('open', "Open"),
			icon: Codicon.goToFile,
		});
	}
	async run(accessor: ServicesAccessor, uri: URI): Promise<void> {
		const editorService = accessor.get(IEditorService);
		await editorService.openEditor({ resource: uri });
	}
});

// Run prompt action
const RUN_PROMPT_FROM_VIEW_ID = 'aiCustomization.runPrompt';
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: RUN_PROMPT_FROM_VIEW_ID,
			title: localize2('runPrompt', "Run Prompt"),
			icon: Codicon.play,
		});
	}
	async run(accessor: ServicesAccessor, uri: URI): Promise<void> {
		const commandService = accessor.get(ICommandService);
		await commandService.executeCommand('workbench.action.chat.run.prompt.current', uri);
	}
});

// Register context menu items for Agents
MenuRegistry.appendMenuItem(AgentsViewItemMenuId, {
	command: { id: OPEN_AI_CUSTOMIZATION_FILE_ID, title: localize('open', "Open") },
	group: '1_open',
	order: 1,
});

// Register context menu items for Skills
MenuRegistry.appendMenuItem(SkillsViewItemMenuId, {
	command: { id: OPEN_AI_CUSTOMIZATION_FILE_ID, title: localize('open', "Open") },
	group: '1_open',
	order: 1,
});

// Register context menu items for Instructions
MenuRegistry.appendMenuItem(InstructionsViewItemMenuId, {
	command: { id: OPEN_AI_CUSTOMIZATION_FILE_ID, title: localize('open', "Open") },
	group: '1_open',
	order: 1,
});

// Register context menu items for Prompts
MenuRegistry.appendMenuItem(PromptsViewItemMenuId, {
	command: { id: OPEN_AI_CUSTOMIZATION_FILE_ID, title: localize('open', "Open") },
	group: '1_open',
	order: 1,
});

MenuRegistry.appendMenuItem(PromptsViewItemMenuId, {
	command: { id: RUN_PROMPT_FROM_VIEW_ID, title: localize('runPrompt', "Run Prompt"), icon: Codicon.play },
	group: '2_run',
	order: 1,
});

//#endregion

//#region Actions

// Open AI Customization View
class OpenAICustomizationViewAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.openAICustomizationView',
			title: localize2('openAICustomizationView', "Open AI Customization View"),
			category: AI_CUSTOMIZATION_CATEGORY,
			f1: true,
			keybinding: {
				weight: 200, // KeybindingWeight.WorkbenchContrib
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI,
			},
			precondition: ChatContextKeys.enabled,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		await viewsService.openViewContainer(AI_CUSTOMIZATION_VIEWLET_ID);
	}
}

// New Agent Action
class NewAgentAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.aiCustomization.newAgent',
			title: localize2('newCustomAgent', "New Custom Agent..."),
			category: AI_CUSTOMIZATION_CATEGORY,
			icon: Codicon.add,
			f1: true,
			precondition: ChatContextKeys.enabled,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const openerService = accessor.get(IOpenerService);
		const instantiationService = accessor.get(IInstantiationService);

		const pickers = instantiationService.createInstance(PromptFilePickers);
		const result = await pickers.selectPromptFile({
			placeholder: localize('selectAgent', 'Select agent to open or create new'),
			type: PromptsType.agent,
			optionEdit: true,
		});

		if (result !== undefined) {
			await openerService.open(result.promptFile);
		}
	}
}

// New Skill Action
class NewSkillAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.aiCustomization.newSkill',
			title: localize2('newSkillAction', "New Skill..."),
			category: AI_CUSTOMIZATION_CATEGORY,
			icon: Codicon.add,
			f1: true,
			precondition: ChatContextKeys.enabled,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const openerService = accessor.get(IOpenerService);
		const instantiationService = accessor.get(IInstantiationService);

		const pickers = instantiationService.createInstance(PromptFilePickers);
		const result = await pickers.selectPromptFile({
			placeholder: localize('selectSkill', 'Select skill to open or create new'),
			type: PromptsType.skill,
			optionEdit: true,
		});

		if (result !== undefined) {
			await openerService.open(result.promptFile);
		}
	}
}

// New Instructions Action
class NewInstructionsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.aiCustomization.newInstructions',
			title: localize2('newInstructionsAction', "New Instructions..."),
			category: AI_CUSTOMIZATION_CATEGORY,
			icon: Codicon.add,
			f1: true,
			precondition: ChatContextKeys.enabled,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const openerService = accessor.get(IOpenerService);
		const instantiationService = accessor.get(IInstantiationService);

		const pickers = instantiationService.createInstance(PromptFilePickers);
		const result = await pickers.selectPromptFile({
			placeholder: localize('selectInstructions', 'Select instructions to open or create new'),
			type: PromptsType.instructions,
			optionEdit: true,
		});

		if (result !== undefined) {
			await openerService.open(result.promptFile);
		}
	}
}

// New Prompt Action
class NewPromptAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.aiCustomization.newPrompt',
			title: localize2('newPromptAction', "New Prompt..."),
			category: AI_CUSTOMIZATION_CATEGORY,
			icon: Codicon.add,
			f1: true,
			precondition: ChatContextKeys.enabled,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const openerService = accessor.get(IOpenerService);
		const instantiationService = accessor.get(IInstantiationService);

		const pickers = instantiationService.createInstance(PromptFilePickers);
		const result = await pickers.selectPromptFile({
			placeholder: localize('selectPrompt', 'Select prompt to open or create new'),
			type: PromptsType.prompt,
			optionEdit: true,
		});

		if (result !== undefined) {
			await openerService.open(result.promptFile);
		}
	}
}

// Register all actions
registerAction2(OpenAICustomizationViewAction);
registerAction2(NewAgentAction);
registerAction2(NewSkillAction);
registerAction2(NewInstructionsAction);
registerAction2(NewPromptAction);

//#endregion
