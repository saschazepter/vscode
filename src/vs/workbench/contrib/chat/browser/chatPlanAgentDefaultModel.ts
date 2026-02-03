/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILanguageModelsService, ILanguageModelChatMetadata } from '../common/languageModels.js';
import { ChatConfiguration } from '../common/constants.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { DEFAULT_MODEL_PICKER_CATEGORY } from '../common/widget/input/modelPickerWidget.js';

export class ChatPlanAgentDefaultModel extends Disposable {
	static readonly ID = 'workbench.contrib.chatPlanAgentDefaultModel';
	static readonly configName = ChatConfiguration.PlanAgentDefaultModel;

	static modelIds: string[] = [''];
	static modelLabels: string[] = [localize('defaultModel', 'Auto (Vendor Default)')];
	static modelDescriptions: string[] = [localize('defaultModelDescription', 'Use the vendor\'s default model')];

	constructor(
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(languageModelsService.onDidChangeLanguageModels(() => this._updateModelValues()));
		this._updateModelValues();
	}

	private _updateModelValues(): void {
		try {
			// Clear arrays
			ChatPlanAgentDefaultModel.modelIds.length = 0;
			ChatPlanAgentDefaultModel.modelLabels.length = 0;
			ChatPlanAgentDefaultModel.modelDescriptions.length = 0;

			// Add default/empty option
			ChatPlanAgentDefaultModel.modelIds.push('');
			ChatPlanAgentDefaultModel.modelLabels.push(localize('defaultModel', 'Auto (Vendor Default)'));
			ChatPlanAgentDefaultModel.modelDescriptions.push(localize('defaultModelDescription', 'Use the vendor\'s default model'));

			// Get all available models
			const modelIds = this.languageModelsService.getLanguageModelIds();

			const models: { identifier: string; metadata: ILanguageModelChatMetadata }[] = [];

			// Look up each model's metadata
			for (const modelId of modelIds) {
				try {
					const metadata = this.languageModelsService.lookupLanguageModel(modelId);
					if (metadata) {
						models.push({ identifier: modelId, metadata });
					} else {
						this.logService.warn(`[ChatPlanAgentDefaultModel] No metadata found for model ID: ${modelId}`);
					}
				} catch (e) {
					this.logService.error(`[ChatPlanAgentDefaultModel] Error looking up model ${modelId}:`, e);
				}
			}

			// Filter models that are:
			// 1. User selectable
			// 2. Support tool calling (required for agent mode)
			const supportedModels = models.filter(model => {
				if (!model.metadata?.isUserSelectable) {
					return false;
				}
				// Check if model supports agent mode - needs tool calling capability
				if (!model.metadata.capabilities?.toolCalling) {
					return false;
				}
				return true;
			});

			// Sort by category order, then alphabetically by name within each category
			supportedModels.sort((a, b) => {
				const aCategory = a.metadata.modelPickerCategory ?? DEFAULT_MODEL_PICKER_CATEGORY;
				const bCategory = b.metadata.modelPickerCategory ?? DEFAULT_MODEL_PICKER_CATEGORY;

				// First sort by category order
				if (aCategory.order !== bCategory.order) {
					return aCategory.order - bCategory.order;
				}

				// Then sort by name within the same category
				return a.metadata.name.localeCompare(b.metadata.name);
			});

			// Populate arrays with filtered models
			for (const model of supportedModels) {
				try {
					const qualifiedName = `${model.metadata.name} (${model.metadata.vendor})`;
					ChatPlanAgentDefaultModel.modelIds.push(qualifiedName);
					ChatPlanAgentDefaultModel.modelLabels.push(model.metadata.name);
					ChatPlanAgentDefaultModel.modelDescriptions.push(model.metadata.tooltip ?? model.metadata.detail ?? '');
				} catch (e) {
					this.logService.error(`[ChatPlanAgentDefaultModel] Error adding model ${model.metadata.name}:`, e);
				}
			}
		} catch (e) {
			this.logService.error('[ChatPlanAgentDefaultModel] Error updating model values:', e);
		}
	}
}

registerWorkbenchContribution2(ChatPlanAgentDefaultModel.ID, ChatPlanAgentDefaultModel, WorkbenchPhase.BlockRestore);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...{ id: 'chat', title: localize('chatConfigurationTitle', 'Chat'), order: 30, type: 'object' },
	properties: {
		[ChatPlanAgentDefaultModel.configName]: {
			description: localize('chatPlanAgentDefaultModelDescription', "Select the default language model to use for the Plan agent from the available providers. Model names may include the provider in parentheses, for example 'Claude Haiku 4.5 (copilot)'."),
			type: 'string',
			default: '',
			enum: ChatPlanAgentDefaultModel.modelIds,
			enumItemLabels: ChatPlanAgentDefaultModel.modelLabels,
			markdownEnumDescriptions: ChatPlanAgentDefaultModel.modelDescriptions
		}
	}
});
