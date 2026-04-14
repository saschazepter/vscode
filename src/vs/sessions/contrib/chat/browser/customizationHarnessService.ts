/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	CustomizationHarness,
	CustomizationHarnessServiceBase,
	createCliHarnessDescriptor,
	getCliUserRoots,
} from '../../../../workbench/contrib/chat/common/customizationHarnessService.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IPromptsService } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { IAICustomizationWorkspaceService } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { PromptsServiceCustomizationItemProvider } from '../../../../workbench/contrib/chat/browser/aiCustomization/promptsServiceCustomizationItemProvider.js';
import { BUILTIN_STORAGE } from '../common/builtinPromptsStorage.js';

/**
 * Sessions-window override of the customization harness service.
 *
 * Only the CLI harness is registered because sessions always run via
 * the Copilot CLI. With a single harness the toggle bar is hidden.
 *
 * The harness's `itemProvider` is wired to a `PromptsServiceCustomizationItemProvider`
 * so that the widget receives items through the unified provider pipeline
 * rather than relying on the implicit fallback in `getItemSource()`.
 */
export class SessionsCustomizationHarnessService extends CustomizationHarnessServiceBase {
	constructor(
		@IPathService pathService: IPathService,
		@IPromptsService promptsService: IPromptsService,
		@IAICustomizationWorkspaceService workspaceService: IAICustomizationWorkspaceService,
		@IProductService productService: IProductService,
	) {
		const userHome = pathService.userHome({ preferLocal: true });
		const extras = [BUILTIN_STORAGE];
		const descriptor = createCliHarnessDescriptor(getCliUserRoots(userHome), extras);

		const itemProvider = new PromptsServiceCustomizationItemProvider(
			() => this.getActiveDescriptor(),
			promptsService,
			workspaceService,
			productService,
		);

		super(
			[{
				...descriptor,
				itemProvider,
			}],
			CustomizationHarness.CLI,
		);
	}
}
