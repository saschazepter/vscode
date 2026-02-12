/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptsService } from '../../workbench/contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import { PromptFilesLocator } from '../../workbench/contrib/chat/common/promptSyntax/utils/promptFilesLocator.js';
import { AgenticPromptFilesLocator } from './agenticPromptFilesLocator.js';

export class AgenticPromptsService extends PromptsService {
	protected override createPromptFilesLocator(): PromptFilesLocator {
		return this.instantiationService.createInstance(AgenticPromptFilesLocator);
	}
}
