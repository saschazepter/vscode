/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	CustomizationHarness,
	CustomizationHarnessServiceBase,
	IExternalCustomizationItemProvider,
	createCliHarnessDescriptor,
	getCliUserRoots,
} from '../../../../workbench/contrib/chat/common/customizationHarnessService.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { PromptsServiceCustomizationProvider } from '../../../../workbench/contrib/chat/browser/aiCustomization/promptsServiceCustomizationProvider.js';
import { BUILTIN_STORAGE } from '../common/builtinPromptsStorage.js';

/**
 * Sessions-window override of the customization harness service.
 *
 * Only the CLI harness is registered because sessions always run via
 * the Copilot CLI. With a single harness the toggle bar is hidden.
 *
 * A {@link PromptsServiceCustomizationProvider} wraps IPromptsService
 * so that the management editor can display items without needing an
 * extension-contributed provider.
 *
 * The provider is created lazily via IInstantiationService to avoid
 * cyclic dependencies.
 */
export class SessionsCustomizationHarnessService extends CustomizationHarnessServiceBase {
	constructor(
		@IPathService pathService: IPathService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		const userHome = pathService.userHome({ preferLocal: true });
		const extras = [BUILTIN_STORAGE];
		const descriptor = createCliHarnessDescriptor(getCliUserRoots(userHome), extras);

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
			CustomizationHarness.CLI,
		);
	}
}
