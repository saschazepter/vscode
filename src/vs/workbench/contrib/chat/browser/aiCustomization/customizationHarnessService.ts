/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { ResourceSet } from '../../../../../base/common/map.js';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { StorageScope } from '../../../../../platform/storage/common/storage.js';
import {
	CustomizationHarness,
	CustomizationHarnessServiceBase,
	ICustomizationEnablementProvider,
	ICustomizationHarnessService,
	createVSCodeHarnessDescriptor,
} from '../../common/customizationHarnessService.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { IPromptsService, PromptsStorage } from '../../common/promptSyntax/service/promptsService.js';
import { BUILTIN_STORAGE } from '../../common/aiCustomizationWorkspaceService.js';

/**
 * Enablement provider backed by promptsService (StorageService).
 * Used by the VS Code (Local) harness to manage disabled customizations.
 */
function createPromptsServiceEnablementProvider(promptsService: IPromptsService): ICustomizationEnablementProvider {
	return {
		onDidChange: Event.any(
			promptsService.onDidChangeCustomAgents,
			promptsService.onDidChangeSlashCommands,
			promptsService.onDidChangeSkills,
			promptsService.onDidChangeHooks,
			promptsService.onDidChangeInstructions,
		),
		getDisabledPromptFiles(type: PromptsType): ResourceSet {
			return promptsService.getDisabledPromptFiles(type);
		},
		setEnabled(uri: URI, type: PromptsType, enabled: boolean, scope: 'global' | 'workspace'): void {
			const storageScope = scope === 'workspace' ? StorageScope.WORKSPACE : StorageScope.PROFILE;
			const disabled = promptsService.getDisabledPromptFilesForScope(type, storageScope);
			if (enabled) {
				disabled.delete(uri);
			} else {
				disabled.add(uri);
			}
			promptsService.setDisabledPromptFiles(type, disabled, storageScope);

			// When enabling, also remove from the other scope to fully re-enable
			if (enabled) {
				const otherScope = scope === 'workspace' ? StorageScope.PROFILE : StorageScope.WORKSPACE;
				const otherDisabled = promptsService.getDisabledPromptFilesForScope(type, otherScope);
				if (otherDisabled.delete(uri)) {
					promptsService.setDisabledPromptFiles(type, otherDisabled, otherScope);
				}
			}
		},
	};
}

/**
 * Core implementation of the customization harness service.
 *
 * Only the Local harness is registered statically. All other harnesses
 * (e.g. Copilot CLI) are contributed by extensions via the provider API.
 */
class CustomizationHarnessService extends CustomizationHarnessServiceBase {
	constructor(
		@IPromptsService promptsService: IPromptsService,
	) {
		const localExtras = [PromptsStorage.extension, BUILTIN_STORAGE];
		const enablementProvider = createPromptsServiceEnablementProvider(promptsService);
		super(
			[createVSCodeHarnessDescriptor(localExtras, enablementProvider)],
			CustomizationHarness.VSCode,
		);
	}
}

registerSingleton(ICustomizationHarnessService, CustomizationHarnessService, InstantiationType.Delayed);

