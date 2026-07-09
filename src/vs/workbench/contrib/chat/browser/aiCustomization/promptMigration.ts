/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { splitLinesIncludeSeparators } from '../../../../../base/common/strings.js';
import { URI } from '../../../../../base/common/uri.js';
import { SKILL_FILENAME, VALID_SKILL_NAME_REGEX, getCleanPromptName } from '../../common/promptSyntax/config/promptFileLocations.js';
import { ParsedPromptFile, PromptFileParser, PromptHeaderAttributes } from '../../common/promptSyntax/promptFileParser.js';
import { IPromptPath, PromptsStorage } from '../../common/promptSyntax/service/promptsService.js';
import { ICustomizationSourceFolder } from '../../common/customizationHarnessService.js';

export interface IPromptMigrationInfo {
	readonly totalPromptCount: number;
	readonly workspacePromptCount: number;
	readonly userPromptCount: number;
}

export interface IMigratedPromptFile {
	readonly skillName: string;
	readonly content: string;
	readonly unsupportedHeaderKeys: readonly string[];
}

const retainedPromptHeaderKeys = new Set([
	PromptHeaderAttributes.name,
	PromptHeaderAttributes.description,
	PromptHeaderAttributes.argumentHint,
]);

export function getPromptMigrationInfo(promptFiles: readonly IPromptPath[]): IPromptMigrationInfo | undefined {
	const workspacePromptCount = promptFiles.filter(file => file.storage === PromptsStorage.local).length;
	const userPromptCount = promptFiles.filter(file => file.storage === PromptsStorage.user).length;
	const totalPromptCount = workspacePromptCount + userPromptCount;
	if (totalPromptCount === 0) {
		return undefined;
	}

	return {
		totalPromptCount,
		workspacePromptCount,
		userPromptCount,
	};
}

export function pickSkillSourceFolder(
	promptFile: IPromptPath,
	skillSourceFolders: readonly ICustomizationSourceFolder[],
): ICustomizationSourceFolder | undefined {
	return skillSourceFolders.find(folder => folder.source === promptFile.storage);
}

export function migratePromptFileToSkill(promptFile: IPromptPath, content: string, skillNameOverride?: string): IMigratedPromptFile {
	const parser = new PromptFileParser();
	const parsed = parser.parse(promptFile.uri, content);
	const friendlyName = promptFile.name?.trim() || parsed.header?.name?.trim() || getCleanPromptName(promptFile.uri);
	const skillName = skillNameOverride ?? sanitizeSkillName(friendlyName);
	const description = promptFile.description?.trim() || parsed.header?.description?.trim() || friendlyName;
	const argumentHint = parsed.header?.argumentHint?.trim();
	const body = getPromptBody(parsed, content);
	const unsupportedHeaderKeys = parsed.header?.attributes
		.filter(attribute => !retainedPromptHeaderKeys.has(attribute.key))
		.map(attribute => attribute.key) ?? [];

	const headerLines = [
		'---',
		`name: ${JSON.stringify(skillName)}`,
		`description: ${JSON.stringify(description)}`,
		'disable-model-invocation: true',
	];

	if (argumentHint) {
		headerLines.push(`argument-hint: ${JSON.stringify(argumentHint)}`);
	}

	headerLines.push('---', '');

	return {
		skillName,
		content: `${headerLines.join('\n')}${body}`,
		unsupportedHeaderKeys,
	};
}

function getPromptBody(parsed: ParsedPromptFile, content: string): string {
	const linesWithEol = splitLinesIncludeSeparators(content);
	if (!parsed.body) {
		return '';
	}

	return linesWithEol.slice(parsed.body.range.startLineNumber - 1).join('').replace(/^\r?\n/, '');
}

export function createSkillFileUri(skillSourceFolder: URI, skillName: string): URI {
	return URI.joinPath(skillSourceFolder, skillName, SKILL_FILENAME);
}

function sanitizeSkillName(name: string): string {
	const strippedName = name
		.replace(/<[^>]+>/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-+/g, '-');

	const trimmedName = trimSkillName(strippedName, 0);
	if (trimmedName && VALID_SKILL_NAME_REGEX.test(trimmedName)) {
		return trimmedName;
	}

	return 'migrated-skill';
}

function trimSkillName(skillName: string, suffixLength: number): string {
	const maxBaseLength = Math.max(1, 64 - suffixLength);
	return skillName.slice(0, maxBaseLength).replace(/-+$/g, '');
}
