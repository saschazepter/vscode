/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AICustomizationManagementSection } from '../../common/aiCustomizationWorkspaceService.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';

/**
 * Maps a customization management section ID to its prompt type.
 */
export function sectionToPromptType(section: AICustomizationManagementSection): PromptsType {
	switch (section) {
		case AICustomizationManagementSection.Agents:
			return PromptsType.agent;
		case AICustomizationManagementSection.Skills:
			return PromptsType.skill;
		case AICustomizationManagementSection.Instructions:
			return PromptsType.instructions;
		case AICustomizationManagementSection.Hooks:
			return PromptsType.hook;
		case AICustomizationManagementSection.Prompts:
		default:
			return PromptsType.prompt;
	}
}
