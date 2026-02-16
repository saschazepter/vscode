/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { ActionListItemKind, IActionListItem, IActionListOptions } from '../../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetDropdownAction } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { TelemetryTrustedValue } from '../../../../../../platform/telemetry/common/telemetryUtils.js';
import { MANAGE_CHAT_COMMAND_ID } from '../../../common/constants.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../common/languageModels.js';
import { IModelPickerDelegate } from './modelPickerActionItem.js';

/**
 * Section identifiers for collapsible groups in the model picker.
 */
const ModelPickerSection = {
	Other: 'other',
} as const;

type ChatModelChangeClassification = {
	owner: 'lramos15';
	comment: 'Reporting when the model picker is switched';
	fromModel?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The previous chat model' };
	toModel: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The new chat model' };
};

type ChatModelChangeEvent = {
	fromModel: string | TelemetryTrustedValue<string> | undefined;
	toModel: string | TelemetryTrustedValue<string>;
};

function createModelItem(
	action: IActionWidgetDropdownAction & { section?: string },
): IActionListItem<IActionWidgetDropdownAction> {
	return {
		item: action,
		kind: ActionListItemKind.Action,
		label: action.label,
		description: action.description,
		group: { title: '', icon: action.icon ?? ThemeIcon.fromId(action.checked ? Codicon.check.id : Codicon.blank.id) },
		hideIcon: false,
		section: action.section,
	};
}

function createModelAction(
	model: ILanguageModelChatMetadataAndIdentifier,
	delegate: IModelPickerDelegate,
	telemetryService: ITelemetryService,
	languageModelsService: ILanguageModelsService,
	section?: string,
): IActionWidgetDropdownAction & { section?: string } {
	return {
		id: model.identifier,
		enabled: true,
		icon: model.metadata.statusIcon,
		checked: model.identifier === delegate.currentModel.get()?.identifier,
		class: undefined,
		description: model.metadata.multiplier ?? model.metadata.detail,
		tooltip: model.metadata.name,
		label: model.metadata.name,
		section,
		run: () => {
			const previousModel = delegate.currentModel.get();
			telemetryService.publicLog2<ChatModelChangeEvent, ChatModelChangeClassification>('chat.modelChange', {
				fromModel: previousModel?.metadata.vendor === 'copilot' ? new TelemetryTrustedValue(previousModel.identifier) : 'unknown',
				toModel: model.metadata.vendor === 'copilot' ? new TelemetryTrustedValue(model.identifier) : 'unknown'
			});
			delegate.setModel(model);
		}
	};
}

/**
 * Builds the grouped items for the model picker dropdown.
 *
 * Layout:
 * 1. Auto (always first)
 * 2. Recently used + curated models (merged, sorted alphabetically, no header)
 * 3. Other Models (collapsible toggle, sorted alphabetically)
 *    - Last item is "Manage Models..."
 */
export function buildModelPickerItems(
	delegate: IModelPickerDelegate,
	languageModelsService: ILanguageModelsService,
	telemetryService: ITelemetryService,
	commandService: ICommandService,
): IActionListItem<IActionWidgetDropdownAction>[] {
	const items: IActionListItem<IActionWidgetDropdownAction>[] = [];
	const currentModelId = delegate.currentModel.get()?.identifier;

	// Collect all available models
	const allModels = delegate.getModels();
	const allModelsMap = new Map<string, ILanguageModelChatMetadataAndIdentifier>();
	for (const model of allModels) {
		allModelsMap.set(model.identifier, model);
	}

	// Build a secondary lookup by metadata.id for flexible matching
	const modelsByMetadataId = new Map<string, ILanguageModelChatMetadataAndIdentifier>();
	for (const model of allModels) {
		modelsByMetadataId.set(model.metadata.id, model);
	}

	// Track which model IDs have been placed in the promoted group
	const placed = new Set<string>();

	// --- 1. Auto ---
	const isAutoSelected = !currentModelId || !allModelsMap.has(currentModelId);
	const defaultModel = allModels.find(m => Object.values(m.metadata.isDefaultForLocation).some(v => v));
	const autoDescription = defaultModel?.metadata.multiplier ?? defaultModel?.metadata.detail;
	items.push(createModelItem({
		id: 'auto',
		enabled: true,
		checked: isAutoSelected,
		class: undefined,
		tooltip: localize('chat.modelPicker.auto', "Auto"),
		label: localize('chat.modelPicker.auto', "Auto"),
		description: autoDescription,
		run: () => {
			if (defaultModel) {
				delegate.setModel(defaultModel);
			}
		}
	}));

	// --- 2. Promoted models (recently used + curated, merged & sorted alphabetically) ---
	const promotedModels: ILanguageModelChatMetadataAndIdentifier[] = [];

	// Add recently used
	const recentIds = languageModelsService.getRecentlyUsedModelIds(7);
	for (const id of recentIds) {
		const model = allModelsMap.get(id);
		if (model && !placed.has(model.identifier)) {
			promotedModels.push(model);
			placed.add(model.identifier);
		}
	}

	// Add curated (deduplicated against recently used)
	const curatedIds = languageModelsService.getCuratedModelIds();
	for (const id of curatedIds) {
		const model = allModelsMap.get(id) ?? modelsByMetadataId.get(id);
		if (model && !placed.has(model.identifier)) {
			promotedModels.push(model);
			placed.add(model.identifier);
		}
	}

	// Sort alphabetically for a stable list
	promotedModels.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));

	if (promotedModels.length > 0) {
		items.push({
			kind: ActionListItemKind.Separator,
		});
		for (const model of promotedModels) {
			const action = createModelAction(model, delegate, telemetryService, languageModelsService);
			items.push(createModelItem(action));
		}
	}

	// --- 3. Other Models (collapsible) ---
	const otherModels: ILanguageModelChatMetadataAndIdentifier[] = [];
	for (const model of allModels) {
		if (!placed.has(model.identifier)) {
			// Skip the default model - it's already represented by the top-level "Auto" entry
			const isDefault = Object.values(model.metadata.isDefaultForLocation).some(v => v);
			if (isDefault) {
				continue;
			}
			otherModels.push(model);
		}
	}

	if (otherModels.length > 0) {
		items.push({
			kind: ActionListItemKind.Separator,
		});
		items.push({
			item: {
				id: 'otherModels',
				enabled: true,
				checked: false,
				class: undefined,
				tooltip: localize('chat.modelPicker.otherModels', "Other Models"),
				label: localize('chat.modelPicker.otherModels', "Other Models"),
				run: () => { /* toggle handled by isSectionToggle */ }
			},
			kind: ActionListItemKind.Action,
			label: localize('chat.modelPicker.otherModels', "Other Models"),
			group: { title: '', icon: Codicon.chevronDown },
			hideIcon: false,
			section: ModelPickerSection.Other,
			isSectionToggle: true,
		});
		for (const model of otherModels) {
			const action = createModelAction(model, delegate, telemetryService, languageModelsService, ModelPickerSection.Other);
			items.push(createModelItem(action));
		}

		// "Manage Models..." entry inside Other Models section, styled as a link
		items.push({
			item: {
				id: 'manageModels',
				enabled: true,
				checked: false,
				class: 'manage-models-action',
				tooltip: localize('chat.manageModels.tooltip', "Manage Language Models"),
				label: localize('chat.manageModels', "Manage Models..."),
				icon: Codicon.settingsGear,
				run: () => {
					commandService.executeCommand(MANAGE_CHAT_COMMAND_ID);
				}
			},
			kind: ActionListItemKind.Action,
			label: localize('chat.manageModels', "Manage Models..."),
			group: { title: '', icon: Codicon.settingsGear },
			hideIcon: false,
			section: ModelPickerSection.Other,
			className: 'manage-models-link',
		});
	}

	return items;
}

/**
 * Returns the ActionList options for the model picker (filter + collapsed sections).
 */
export function getModelPickerListOptions(): IActionListOptions {
	return {
		showFilter: true,
		collapsedByDefault: new Set([ModelPickerSection.Other]),
		minWidth: 300,
	};
}
