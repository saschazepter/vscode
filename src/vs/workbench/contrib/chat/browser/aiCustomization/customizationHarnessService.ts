/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import {
	CustomizationHarness,
	CustomizationHarnessServiceBase,
	ICustomizationHarnessService,
	createPromptsServiceItemProvider,
	createVSCodeHarnessDescriptor,
} from '../../common/customizationHarnessService.js';
import { IPromptsService, PromptsStorage } from '../../common/promptSyntax/service/promptsService.js';
import { BUILTIN_STORAGE } from '../../common/aiCustomizationWorkspaceService.js';

/**
 * Core implementation of the customization harness service.
 *
 * Only the Local harness is registered statically. All other harnesses
 * (e.g. Copilot CLI) are contributed by extensions via the provider API.
 *
 * A built-in itemProvider wraps IPromptsService so that the management
 * editor can display items without needing an extension-contributed provider.
 */
class CustomizationHarnessService extends CustomizationHarnessServiceBase {
	constructor(
		@IPromptsService promptsService: IPromptsService,
	) {
		const localExtras = [PromptsStorage.extension, BUILTIN_STORAGE];
		const { itemProvider, disposable } = createPromptsServiceItemProvider(promptsService);

		super(
			[{ ...createVSCodeHarnessDescriptor(localExtras), itemProvider }],
			CustomizationHarness.VSCode,
		);

		this._register(disposable);
	}
}

registerSingleton(ICustomizationHarnessService, CustomizationHarnessService, InstantiationType.Delayed);

