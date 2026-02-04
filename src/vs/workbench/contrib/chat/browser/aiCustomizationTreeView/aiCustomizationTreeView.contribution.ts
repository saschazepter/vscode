/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { localize, localize2, ILocalizedString } from '../../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { ViewAction } from '../../../../browser/parts/views/viewPane.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, LayoutVisibility, ViewContainerLocation } from '../../../../common/views.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { AICustomizationItemMenuId, AICustomizationNewMenuId, AI_CUSTOMIZATION_CATEGORY, AI_CUSTOMIZATION_STORAGE_ID, AI_CUSTOMIZATION_VIEW_ID, AI_CUSTOMIZATION_VIEWLET_ID } from './aiCustomizationTreeView.js';
import { aiCustomizationViewIcon } from './aiCustomizationTreeViewIcons.js';
import { AICustomizationIsEmptyContextKey, AICustomizationItemTypeContextKey, AICustomizationViewPane } from './aiCustomizationTreeViewViews.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { PromptFilePickers } from '../promptSyntax/pickers/promptFilePickers.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { URI } from '../../../../../base/common/uri.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { AI_CUSTOMIZATION_EDITOR_ID } from '../aiCustomizationEditor/aiCustomizationEditor.js';
import { AICustomizationOverviewView, AI_CUSTOMIZATION_OVERVIEW_VIEW_ID } from '../aiCustomizationManagement/aiCustomizationOverviewView.js';

//#region Utilities

/**
 * Type for context passed to actions from tree context menus.
 * Handles both direct URI arguments and serialized context objects.
 */
type URIContext = { uri: URI | string;[key: string]: unknown } | URI | string;

/**
 * Extracts a URI from various context formats.
 * Context can be a URI, string, or an object with uri property.
 */
function extractURI(context: URIContext): URI {
	if (URI.isUri(context)) {
		return context;
	}
	if (typeof context === 'string') {
		return URI.parse(context);
	}
	if (URI.isUri(context.uri)) {
		return context.uri;
	}
	return URI.parse(context.uri as string);
}

//#endregion

//#region View Container Registration

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

export const AI_CUSTOMIZATION_VIEW_CONTAINER = viewContainersRegistry.registerViewContainer(
	{
		id: AI_CUSTOMIZATION_VIEWLET_ID,
		title: localize2('aiCustomization', "AI Customization"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AI_CUSTOMIZATION_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
		icon: aiCustomizationViewIcon,
		order: 10,
		hideIfEmpty: false,
		storageId: AI_CUSTOMIZATION_STORAGE_ID,
		alwaysUseContainerInfo: true,
		layoutVisibility: LayoutVisibility.Both,
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

// Unified AI Customization View (Tree)
const aiCustomizationViewDescriptor: IViewDescriptor = {
	id: AI_CUSTOMIZATION_VIEW_ID,
	name: localize2('aiCustomizationTree', "Tree"),
	ctorDescriptor: new SyncDescriptor(AICustomizationViewPane),
	containerIcon: aiCustomizationViewIcon,
	canToggleVisibility: true,
	canMoveView: true,
	order: 2,
	when: ChatContextKeys.enabled,
	hideByDefault: true,
};

// Overview View (compact snapshot with deep-links)
const aiCustomizationOverviewViewDescriptor: IViewDescriptor = {
	id: AI_CUSTOMIZATION_OVERVIEW_VIEW_ID,
	name: localize2('aiCustomizationOverview', "Overview"),
	ctorDescriptor: new SyncDescriptor(AICustomizationOverviewView),
	containerIcon: aiCustomizationViewIcon,
	canToggleVisibility: true,
	canMoveView: true,
	order: 1,
	collapsed: false,
	weight: 20,
	layoutVisibility: LayoutVisibility.Both,
};

viewsRegistry.registerViews([aiCustomizationOverviewViewDescriptor, aiCustomizationViewDescriptor], AI_CUSTOMIZATION_VIEW_CONTAINER);

//#endregion

//#region Welcome Content

viewsRegistry.registerViewWelcomeContent(AI_CUSTOMIZATION_VIEW_ID, {
	content: localize('noCustomizations', "No AI customizations found.\n[Create Agent](command:workbench.action.aiCustomization.newAgent)\n[Create Skill](command:workbench.action.aiCustomization.newSkill)\n[Create Instructions](command:workbench.action.aiCustomization.newInstructions)\n[Create Prompt](command:workbench.action.aiCustomization.newPrompt)"),
	when: AICustomizationIsEmptyContextKey,
});

//#endregion

//#region View Title Menu Actions

// Add dropdown menu for creating new items
MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	submenu: AICustomizationNewMenuId,
	title: localize('new', "New..."),
	icon: Codicon.add,
	when: ContextKeyExpr.equals('view', AI_CUSTOMIZATION_VIEW_ID),
	group: 'navigation',
	order: 1,
});

// Register the submenu
MenuRegistry.appendMenuItem(AICustomizationNewMenuId, {
	command: { id: 'workbench.action.aiCustomization.newAgent', title: localize('newAgent', "New Agent") },
	group: '1_create',
	order: 1,
});

MenuRegistry.appendMenuItem(AICustomizationNewMenuId, {
	command: { id: 'workbench.action.aiCustomization.newSkill', title: localize('newSkill', "New Skill") },
	group: '1_create',
	order: 2,
});

MenuRegistry.appendMenuItem(AICustomizationNewMenuId, {
	command: { id: 'workbench.action.aiCustomization.newInstructions', title: localize('newInstructions', "New Instructions") },
	group: '1_create',
	order: 3,
});

MenuRegistry.appendMenuItem(AICustomizationNewMenuId, {
	command: { id: 'workbench.action.aiCustomization.newPrompt', title: localize('newPrompt', "New Prompt") },
	group: '1_create',
	order: 4,
});

// Refresh action
registerAction2(class extends ViewAction<AICustomizationViewPane> {
	constructor() {
		super({
			id: 'aiCustomization.refresh',
			viewId: AI_CUSTOMIZATION_VIEW_ID,
			title: localize('refresh', "Refresh"),
			f1: false,
			icon: Codicon.refresh,
			menu: {
				id: MenuId.ViewTitle,
				order: 10,
				group: 'navigation',
				when: ContextKeyExpr.equals('view', AI_CUSTOMIZATION_VIEW_ID)
			}
		});
	}

	runInView(_accessor: ServicesAccessor, view: AICustomizationViewPane) {
		view.refresh();
	}
});

// Collapse All action
registerAction2(class extends ViewAction<AICustomizationViewPane> {
	constructor() {
		super({
			id: 'aiCustomization.collapseAll',
			viewId: AI_CUSTOMIZATION_VIEW_ID,
			title: localize('collapseAll', "Collapse All"),
			f1: false,
			icon: Codicon.collapseAll,
			menu: {
				id: MenuId.ViewTitle,
				order: 20,
				group: 'navigation',
				when: ContextKeyExpr.equals('view', AI_CUSTOMIZATION_VIEW_ID)
			}
		});
	}

	runInView(_accessor: ServicesAccessor, view: AICustomizationViewPane) {
		view.collapseAll();
	}
});

//#endregion

//#region Context Menu Actions

// Open file action (in AI Customization Editor)
const OPEN_AI_CUSTOMIZATION_FILE_ID = 'aiCustomization.openFile';
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_AI_CUSTOMIZATION_FILE_ID,
			title: localize2('open', "Open"),
			icon: Codicon.goToFile,
		});
	}
	async run(accessor: ServicesAccessor, context: URIContext): Promise<void> {
		const editorService = accessor.get(IEditorService);
		await editorService.openEditor({
			resource: extractURI(context),
			options: { override: AI_CUSTOMIZATION_EDITOR_ID }
		});
	}
});

// Open as text action (in standard text editor)
const OPEN_AI_CUSTOMIZATION_AS_TEXT_ID = 'aiCustomization.openAsText';
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_AI_CUSTOMIZATION_AS_TEXT_ID,
			title: localize2('openAsText', "Open as Text"),
			icon: Codicon.file,
		});
	}
	async run(accessor: ServicesAccessor, context: URIContext): Promise<void> {
		const editorService = accessor.get(IEditorService);
		await editorService.openEditor({
			resource: extractURI(context),
			options: { override: 'default' }
		});
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
	async run(accessor: ServicesAccessor, context: URIContext): Promise<void> {
		const commandService = accessor.get(ICommandService);
		await commandService.executeCommand('workbench.action.chat.run.prompt.current', extractURI(context));
	}
});

// Register context menu items
MenuRegistry.appendMenuItem(AICustomizationItemMenuId, {
	command: { id: OPEN_AI_CUSTOMIZATION_FILE_ID, title: localize('open', "Open") },
	group: '1_open',
	order: 1,
});

MenuRegistry.appendMenuItem(AICustomizationItemMenuId, {
	command: { id: OPEN_AI_CUSTOMIZATION_AS_TEXT_ID, title: localize('openAsText', "Open as Text") },
	group: '1_open',
	order: 2,
});

MenuRegistry.appendMenuItem(AICustomizationItemMenuId, {
	command: { id: RUN_PROMPT_FROM_VIEW_ID, title: localize('runPrompt', "Run Prompt"), icon: Codicon.play },
	group: '2_run',
	order: 1,
	when: ContextKeyExpr.equals(AICustomizationItemTypeContextKey.key, PromptsType.prompt),
});

//#endregion

//#region Actions

// Open AI Customization View
registerAction2(class extends Action2 {
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
});

/**
 * Factory function to create and register "New [Type]" actions for AI customization files.
 * Reduces code duplication across the four prompt type actions.
 */
function registerNewPromptAction(
	id: string,
	title: ILocalizedString,
	placeholder: string,
	type: PromptsType,
): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id,
				title,
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
				placeholder,
				type,
				optionEdit: true,
			});

			if (result !== undefined) {
				await openerService.open(result.promptFile);
			}
		}
	});
}

// Register all New actions using the factory
registerNewPromptAction(
	'workbench.action.aiCustomization.newAgent',
	localize2('newCustomAgent', 'New Custom Agent...'),
	localize('selectAgent', 'Select agent to open or create new'),
	PromptsType.agent,
);

registerNewPromptAction(
	'workbench.action.aiCustomization.newSkill',
	localize2('newSkillAction', 'New Skill...'),
	localize('selectSkill', 'Select skill to open or create new'),
	PromptsType.skill,
);

registerNewPromptAction(
	'workbench.action.aiCustomization.newInstructions',
	localize2('newInstructionsAction', 'New Instructions...'),
	localize('selectInstructions', 'Select instructions to open or create new'),
	PromptsType.instructions,
);

registerNewPromptAction(
	'workbench.action.aiCustomization.newPrompt',
	localize2('newPromptAction', 'New Prompt...'),
	localize('selectPrompt', 'Select prompt to open or create new'),
	PromptsType.prompt,
);

//#endregion
