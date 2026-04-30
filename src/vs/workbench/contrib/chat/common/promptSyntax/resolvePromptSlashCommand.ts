/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { OffsetRange } from '../../../../../editor/common/core/ranges/offsetRange.js';
import { IChatRequestVariableEntry, PromptFileVariableKind, toPromptFileVariableEntry } from '../attachments/chatVariableEntries.js';
import { ICustomizationHarnessService } from '../customizationHarnessService.js';
import { slashReg } from '../requestParser/chatRequestParser.js';
import { ILanguageModelToolsService } from '../tools/languageModelToolsService.js';

/**
 * Returns the variable entry for a slash command if the prompt starts with a
 * slash command that can be resolved to a prompt file.
 */
export async function resolvePromptSlashCommandToVariableEntry(prompt: string, sessionType: string, customizationHarnessService: ICustomizationHarnessService, toolsService: ILanguageModelToolsService, token: CancellationToken): Promise<IChatRequestVariableEntry | undefined> {
	const slashMatch = prompt.match(slashReg);
	if (!slashMatch) {
		return undefined;
	}

	const slashCommand = await customizationHarnessService.resolvePromptSlashCommand(slashMatch[1], sessionType, token);
	if (!slashCommand) {
		return undefined;
	}

	const parseResult = slashCommand.parsedPromptFile;
	const refs = parseResult.body?.variableReferences.map(({ name, offset, fullLength }) => ({ name, range: new OffsetRange(offset, offset + fullLength) })) ?? [];
	const toolReferences = toolsService.toToolReferences(refs);
	return toPromptFileVariableEntry(parseResult.uri, PromptFileVariableKind.PromptFile, undefined, true, toolReferences);
}
