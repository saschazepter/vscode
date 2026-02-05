/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IEditorPaneRegistry, EditorPaneDescriptor } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { CHAT_CATEGORY } from '../actions/chatActions.js';
import { AICustomizationManagementEditor } from './aiCustomizationManagementEditor.js';
import { AICustomizationManagementEditorInput } from './aiCustomizationManagementEditorInput.js';
import { McpManagementEditor } from './mcpManagementEditor.js';
import { McpManagementEditorInput } from './mcpManagementEditorInput.js';
import {
	AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID,
	AI_CUSTOMIZATION_MANAGEMENT_EDITOR_INPUT_ID,
	AICustomizationManagementCommands,
} from './aiCustomizationManagement.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';

//#region Editor Registration

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AICustomizationManagementEditor,
		AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID,
		localize('aiCustomizationManagementEditor', "AI Customizations Editor")
	),
	[
		// Note: Using the class directly since we use a singleton pattern
		new SyncDescriptor(AICustomizationManagementEditorInput as unknown as { new(): AICustomizationManagementEditorInput })
	]
);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		McpManagementEditor,
		McpManagementEditor.ID,
		localize('mcpManagement', "MCP Servers")
	),
	[
		new SyncDescriptor(McpManagementEditorInput)
	]
);

//#endregion

//#region Editor Serializer

class AICustomizationManagementEditorInputSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof AICustomizationManagementEditorInput;
	}

	serialize(input: AICustomizationManagementEditorInput): string {
		return '';
	}

	deserialize(instantiationService: IInstantiationService): AICustomizationManagementEditorInput {
		return AICustomizationManagementEditorInput.getOrCreate();
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	AI_CUSTOMIZATION_MANAGEMENT_EDITOR_INPUT_ID,
	AICustomizationManagementEditorInputSerializer
);

class McpManagementEditorInputSerializer implements IEditorSerializer {

	canSerialize(input: McpManagementEditorInput): boolean {
		return true;
	}

	serialize(input: McpManagementEditorInput): string {
		return '';
	}

	deserialize(instantiationService: IInstantiationService): McpManagementEditorInput {
		return instantiationService.createInstance(McpManagementEditorInput);
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	McpManagementEditorInput.ID,
	McpManagementEditorInputSerializer
);

//#endregion

//#region Actions

class AICustomizationManagementActionsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.aiCustomizationManagementActions';

	constructor() {
		super();
		this.registerActions();
	}

	private registerActions(): void {
		// Open AI Customizations Editor
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: AICustomizationManagementCommands.OpenEditor,
					title: localize2('openAICustomizations', "Open AI Customizations"),
					category: CHAT_CATEGORY,
					precondition: ChatContextKeys.enabled,
					f1: true,
				});
			}

			async run(accessor: ServicesAccessor): Promise<void> {
				const editorGroupsService = accessor.get(IEditorGroupsService);
				const input = AICustomizationManagementEditorInput.getOrCreate();
				await editorGroupsService.activeGroup.openEditor(input, { pinned: true });
			}
		}));
	}
}

registerWorkbenchContribution2(
	AICustomizationManagementActionsContribution.ID,
	AICustomizationManagementActionsContribution,
	WorkbenchPhase.AfterRestored
);

//#endregion
