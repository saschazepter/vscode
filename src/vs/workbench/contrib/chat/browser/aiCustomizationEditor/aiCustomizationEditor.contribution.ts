/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../services/editor/common/editorResolverService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { AICustomizationEditorInput } from './input/aiCustomizationEditorInput.js';
import { AICustomizationEditorPane } from './pane/aiCustomizationEditorPane.js';
import { AI_CUSTOMIZATION_EDITOR_ID, AI_CUSTOMIZATION_EDITOR_VIEW_TYPE } from './aiCustomizationEditor.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { URI } from '../../../../../base/common/uri.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';

//#region Editor Pane Registration

/**
 * Register the AI Customization Editor Pane with its associated EditorInput.
 */
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AICustomizationEditorPane,
		AI_CUSTOMIZATION_EDITOR_ID,
		localize('aiCustomizationEditor', "AI Customization Editor")
	),
	[
		new SyncDescriptor(AICustomizationEditorInput)
	]
);

//#endregion

//#region Editor Input Serializer

/**
 * Serializer for AICustomizationEditorInput to support workspace restoration.
 */
class AICustomizationEditorInputSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof AICustomizationEditorInput;
	}

	serialize(input: AICustomizationEditorInput): string {
		return JSON.stringify({
			resource: input.resource.toString(),
		});
	}

	deserialize(instantiationService: IInstantiationService, serializedInput: string): AICustomizationEditorInput | undefined {
		try {
			const data = JSON.parse(serializedInput);
			if (data.resource) {
				return instantiationService.createInstance(AICustomizationEditorInput, URI.parse(data.resource));
			}
		} catch {
			// Invalid serialized data
		}
		return undefined;
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	AICustomizationEditorInput.ID,
	AICustomizationEditorInputSerializer
);

//#endregion

//#region Editor Resolver Registration

/**
 * Contribution that registers the AI Customization Editor with the editor resolver service.
 * This allows the editor to open for .prompt.md, .agent.md, .instructions.md, and SKILL.md files.
 * Only registers when AI/chat features are enabled.
 */
class AICustomizationEditorContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.aiCustomizationEditor';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		// Only register editor when chat/AI features are enabled
		const chatEnabled = ChatContextKeys.enabled.bindTo(contextKeyService);

		// Register editor for prompt file types
		const patterns = [
			'**/*.prompt.md',
			'**/*.agent.md',
			'**/*.instructions.md',
			'**/SKILL.md',
		];

		for (const pattern of patterns) {
			this._register(editorResolverService.registerEditor(
				pattern,
				{
					id: AI_CUSTOMIZATION_EDITOR_VIEW_TYPE,
					label: localize('aiCustomizationEditor.label', "AI Customization Editor"),
					detail: localize('aiCustomizationEditor.detail', "Edit AI customization files with a form-based UI"),
					priority: RegisteredEditorPriority.option, // Available as an option, not default
				},
				{
					singlePerResource: true,
					canSupportResource: () => chatEnabled.get() ?? true, // Only available when chat is enabled
				},
				{
					createEditorInput: ({ resource }) => {
						return {
							editor: this.instantiationService.createInstance(AICustomizationEditorInput, resource),
						};
					},
				}
			));
		}
	}
}

registerWorkbenchContribution2(
	AICustomizationEditorContribution.ID,
	AICustomizationEditorContribution,
	WorkbenchPhase.BlockRestore
);

//#endregion
