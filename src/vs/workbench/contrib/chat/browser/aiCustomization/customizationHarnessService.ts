/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import {
	CustomizationHarness,
	CustomizationHarnessServiceBase,
	ICustomizationHarnessService,
	IExternalCustomizationItemProvider,
	createVSCodeHarnessDescriptor,
} from '../../common/customizationHarnessService.js';
import { PromptsStorage } from '../../common/promptSyntax/service/promptsService.js';
import { BUILTIN_STORAGE } from '../../common/aiCustomizationWorkspaceService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { PromptsServiceCustomizationProvider } from './promptsServiceCustomizationProvider.js';

/**
 * Core implementation of the customization harness service.
 *
 * Only the Local harness is registered statically. All other harnesses
 * (e.g. Copilot CLI) are contributed by extensions via the provider API.
 *
 * A {@link PromptsServiceCustomizationProvider} wraps IPromptsService
 * so the management editor uses the same provider-based code path for
 * Local items as it does for extension-contributed harnesses.
 *
 * The provider is created lazily via IInstantiationService to avoid
 * cyclic dependencies between ICustomizationHarnessService and
 * IPromptsService (which depends on the extension host).
 */
class CustomizationHarnessService extends CustomizationHarnessServiceBase {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		const localExtras = [PromptsStorage.extension, BUILTIN_STORAGE];
		const descriptor = createVSCodeHarnessDescriptor(localExtras);

		// Lazy provider: created on first call to avoid cyclic DI resolution.
		let provider: PromptsServiceCustomizationProvider | undefined;
		const lazyItemProvider: IExternalCustomizationItemProvider = {
			get onDidChange() {
				provider ??= instantiationService.createInstance(PromptsServiceCustomizationProvider, descriptor);
				return provider.onDidChange;
			},
			provideChatSessionCustomizations(token) {
				provider ??= instantiationService.createInstance(PromptsServiceCustomizationProvider, descriptor);
				return provider.provideChatSessionCustomizations(token);
			},
		};

		super(
			[{ ...descriptor, itemProvider: lazyItemProvider }],
			CustomizationHarness.VSCode,
		);
	}
}

registerSingleton(ICustomizationHarnessService, CustomizationHarnessService, InstantiationType.Delayed);

