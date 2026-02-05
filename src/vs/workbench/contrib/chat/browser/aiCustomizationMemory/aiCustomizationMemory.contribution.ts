/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { registerAction2, Action2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { MemorySuggestionMode } from '../../common/chatMemory/chatMemory.js';
import { IChatMemoryService } from '../../common/chatMemory/chatMemoryService.js';
import { IChatMemoryExtractionService } from '../../common/chatMemory/chatMemoryExtractionService.js';
import { IChatMemorySuggestionService } from '../../common/chatMemory/chatMemorySuggestionService.js';
import { ChatMemoryServiceImpl } from './chatMemoryServiceImpl.js';
import { ChatMemoryExtractionServiceImpl } from './chatMemoryExtractionServiceImpl.js';
import { ChatMemorySuggestionServiceImpl } from './chatMemorySuggestionServiceImpl.js';
import { registerChatMemoryConfiguration, getSuggestionMode } from './chatMemoryConfiguration.js';
import { ChatMemoryCommandIds } from './aiCustomizationMemory.js';
import { AICustomizationManagementEditorInput } from '../aiCustomizationManagement/aiCustomizationManagementEditorInput.js';
import { AICustomizationManagementEditor } from '../aiCustomizationManagement/aiCustomizationManagementEditor.js';
import { AICustomizationManagementSection } from '../aiCustomizationManagement/aiCustomizationManagement.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';

// Register services
registerSingleton(IChatMemoryService, ChatMemoryServiceImpl, InstantiationType.Delayed);
registerSingleton(IChatMemoryExtractionService, ChatMemoryExtractionServiceImpl, InstantiationType.Delayed);
registerSingleton(IChatMemorySuggestionService, ChatMemorySuggestionServiceImpl, InstantiationType.Delayed);

// Register configuration
registerChatMemoryConfiguration();

// Register commands
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ChatMemoryCommandIds.Reconcile,
			title: localize2('reconcileMemory', "Reconcile Memory Suggestions"),
			f1: true,
			precondition: ChatContextKeys.enabled,
			category: localize2('chat', "Chat"),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const extractionService = accessor.get(IChatMemoryExtractionService);
		const editorService = accessor.get(IEditorService);
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const notificationService = accessor.get(INotificationService);

		const mode = getSuggestionMode(configurationService);

		if (mode === MemorySuggestionMode.Off) {
			notificationService.notify({
				severity: Severity.Info,
				message: localize('memoryDisabledNotification', "Memory is disabled. Enable it in settings to use this feature."),
			});
			return;
		}

		// Run extraction if in manual mode
		if (mode === MemorySuggestionMode.Manual) {
			notificationService.notify({
				severity: Severity.Info,
				message: localize('extractingMemories', "Analyzing chat history for memories..."),
			});

			const result = await extractionService.extractNow();

			if (result.facts.length > 0) {
				notificationService.notify({
					severity: Severity.Info,
					message: localize('extractedFacts', "Found {0} new facts from chat history.", result.facts.length),
				});
			}
		}

		// Open the Memory section in the management editor
		const input = AICustomizationManagementEditorInput.getOrCreate();
		const editor = await editorService.openEditor(input, { pinned: true }, editorGroupsService.activeGroup);

		if (editor instanceof AICustomizationManagementEditor) {
			editor.selectSectionById(AICustomizationManagementSection.Memory);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ChatMemoryCommandIds.OpenMemorySection,
			title: localize2('openMemorySection', "Open Memory"),
			f1: false,
			precondition: ChatContextKeys.enabled,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const editorGroupsService = accessor.get(IEditorGroupsService);

		const input = AICustomizationManagementEditorInput.getOrCreate();
		const editor = await editorService.openEditor(input, { pinned: true }, editorGroupsService.activeGroup);

		if (editor instanceof AICustomizationManagementEditor) {
			editor.selectSectionById(AICustomizationManagementSection.Memory);
		}
	}
});
