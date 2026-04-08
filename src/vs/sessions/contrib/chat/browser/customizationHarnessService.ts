/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	CustomizationHarness,
	CustomizationHarnessServiceBase,
	createCliHarnessDescriptor,
	createPromptsServiceItemProvider,
	getCliUserRoots,
} from '../../../../workbench/contrib/chat/common/customizationHarnessService.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IPromptsService } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { BUILTIN_STORAGE } from '../common/builtinPromptsStorage.js';

/**
 * Sessions-window override of the customization harness service.
 *
 * Only the CLI harness is registered because sessions always run via
 * the Copilot CLI. With a single harness the toggle bar is hidden.
 *
 * A built-in itemProvider wraps IPromptsService so that the management
 * editor can display items without needing an extension-contributed provider.
 */
export class SessionsCustomizationHarnessService extends CustomizationHarnessServiceBase {
	constructor(
		@IPathService pathService: IPathService,
		@IPromptsService promptsService: IPromptsService,
	) {
		const userHome = pathService.userHome({ preferLocal: true });
		const extras = [BUILTIN_STORAGE];
		const { itemProvider, disposable } = createPromptsServiceItemProvider(promptsService);

		super(
			[{ ...createCliHarnessDescriptor(getCliUserRoots(userHome), extras), itemProvider }],
			CustomizationHarness.CLI,
		);

		this._register(disposable);
	}
}
