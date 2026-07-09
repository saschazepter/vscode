/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { PromptFileSource, PromptsType } from '../../../common/promptSyntax/promptTypes.js';
import { PromptsStorage, type IPromptPath } from '../../../common/promptSyntax/service/promptsService.js';
import { ICustomizationSourceFolder } from '../../../common/customizationHarnessService.js';
import { getPromptMigrationInfo, migratePromptFileToSkill, pickSkillSourceFolder } from '../../../browser/aiCustomization/promptMigration.js';

suite('promptMigration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('counts workspace and user prompt files', () => {
		const promptFiles: IPromptPath[] = [
			{ uri: URI.file('/workspace/.github/prompts/review.prompt.md'), storage: PromptsStorage.local, type: PromptsType.prompt, source: PromptFileSource.GitHubWorkspace },
			{ uri: URI.file('/workspace/.github/prompts/test.prompt.md'), storage: PromptsStorage.local, type: PromptsType.prompt, source: PromptFileSource.GitHubWorkspace },
			{ uri: URI.file('/home/test/.vscode/prompts/release.prompt.md'), storage: PromptsStorage.user, type: PromptsType.prompt, source: PromptFileSource.UserData },
		];

		assert.deepStrictEqual(getPromptMigrationInfo(promptFiles), {
			totalPromptCount: 3,
			workspacePromptCount: 2,
			userPromptCount: 1,
		});
		assert.strictEqual(getPromptMigrationInfo([]), undefined);
	});

	test('picks the matching storage from provider source folders', () => {
		const promptFile: IPromptPath = {
			uri: URI.file('/workspace/.github/prompts/review.prompt.md'),
			storage: PromptsStorage.local,
			type: PromptsType.prompt,
			source: PromptFileSource.GitHubWorkspace,
		};
		const skillRoots: ICustomizationSourceFolder[] = [
			{ uri: URI.file('/workspace/.github/skills'), label: '.github/skills', source: PromptsStorage.local },
			{ uri: URI.file('/home/test/.copilot/skills'), label: '~/.copilot/skills', source: PromptsStorage.user },
		];

		assert.strictEqual(
			pickSkillSourceFolder(promptFile, skillRoots)?.uri.toString(),
			URI.file('/workspace/.github/skills').toString(),
		);
		assert.strictEqual(pickSkillSourceFolder({ ...promptFile, storage: PromptsStorage.user }, skillRoots)?.uri.toString(), URI.file('/home/test/.copilot/skills').toString());
	});

	test('migrates prompt headers into a skill file', () => {
		const promptFile: IPromptPath = {
			uri: URI.file('/workspace/.github/prompts/review.prompt.md'),
			name: 'Review Prompt',
			description: 'Review the active change',
			storage: PromptsStorage.local,
			type: PromptsType.prompt,
			source: PromptFileSource.GitHubWorkspace,
		};
		const content = [
			'---',
			'name: "Review Prompt"',
			'description: "Review the active change"',
			'argument-hint: "[diff]"',
			'tools: [read_file, edit_file]',
			'mode: code',
			'---',
			'## Steps',
			'',
			'- Review the diff',
		].join('\n');

		const migrated = migratePromptFileToSkill(promptFile, content);

		assert.strictEqual(migrated.skillName, 'review-prompt');
		assert.deepStrictEqual(migrated.unsupportedHeaderKeys, ['tools', 'mode']);
		assert.ok(migrated.content.includes('name: "review-prompt"'));
		assert.ok(migrated.content.includes('description: "Review the active change"'));
		assert.ok(migrated.content.includes('disable-model-invocation: true'));
		assert.ok(migrated.content.includes('argument-hint: "[diff]"'));
		assert.ok(!migrated.content.includes('tools: [read_file, edit_file]'));
		assert.ok(migrated.content.includes('## Steps'));
	});
});
