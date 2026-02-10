/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { HookType } from '../../../common/promptSyntax/hookSchema.js';
import { parseCopilotHooks, parseHooksFromFile, HookSourceFormat } from '../../../common/promptSyntax/hookCompatibility.js';
import { URI } from '../../../../../../base/common/uri.js';

suite('HookCompatibility', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseCopilotHooks', () => {
		const workspaceRoot = URI.file('/workspace');
		const userHome = '/home/user';

		suite('basic parsing', () => {
			test('parses simple hook with command', () => {
				const json = {
					hooks: {
						PreToolUse: [
							{ type: 'command', command: 'echo "pre-tool"' }
						]
					}
				};

				const result = parseCopilotHooks(json, workspaceRoot, userHome);

				assert.strictEqual(result.disabledAllHooks, false);
				assert.strictEqual(result.hooks.size, 1);
				assert.ok(result.hooks.has(HookType.PreToolUse));
				const entry = result.hooks.get(HookType.PreToolUse)!;
				assert.strictEqual(entry.hooks.length, 1);
				assert.strictEqual(entry.hooks[0].command, 'echo "pre-tool"');
			});
		});

		suite('disableAllHooks', () => {
			test('returns empty hooks and disabledAllHooks=true when disableAllHooks is true', () => {
				const json = {
					disableAllHooks: true,
					hooks: {
						PreToolUse: [
							{ type: 'command', command: 'echo "should be ignored"' }
						]
					}
				};

				const result = parseCopilotHooks(json, workspaceRoot, userHome);

				assert.strictEqual(result.disabledAllHooks, true);
				assert.strictEqual(result.hooks.size, 0);
			});

			test('parses hooks normally when disableAllHooks is false', () => {
				const json = {
					disableAllHooks: false,
					hooks: {
						PreToolUse: [
							{ type: 'command', command: 'echo "should be parsed"' }
						]
					}
				};

				const result = parseCopilotHooks(json, workspaceRoot, userHome);

				assert.strictEqual(result.disabledAllHooks, false);
				assert.strictEqual(result.hooks.size, 1);
			});

			test('parses hooks normally when disableAllHooks is not present', () => {
				const json = {
					hooks: {
						PreToolUse: [
							{ type: 'command', command: 'echo "should be parsed"' }
						]
					}
				};

				const result = parseCopilotHooks(json, workspaceRoot, userHome);

				assert.strictEqual(result.disabledAllHooks, false);
				assert.strictEqual(result.hooks.size, 1);
			});
		});

		suite('invalid inputs', () => {
			test('returns empty result for null json', () => {
				const result = parseCopilotHooks(null, workspaceRoot, userHome);
				assert.strictEqual(result.hooks.size, 0);
				assert.strictEqual(result.disabledAllHooks, false);
			});

			test('returns empty result for undefined json', () => {
				const result = parseCopilotHooks(undefined, workspaceRoot, userHome);
				assert.strictEqual(result.hooks.size, 0);
				assert.strictEqual(result.disabledAllHooks, false);
			});

			test('returns empty result for missing hooks property', () => {
				const result = parseCopilotHooks({}, workspaceRoot, userHome);
				assert.strictEqual(result.hooks.size, 0);
				assert.strictEqual(result.disabledAllHooks, false);
			});
		});
	});

	suite('parseHooksFromFile', () => {
		const workspaceRoot = URI.file('/workspace');
		const userHome = '/home/user';

		test('uses Copilot format for .github/hooks/*.json files', () => {
			const fileUri = URI.file('/workspace/.github/hooks/my-hooks.json');
			const json = {
				disableAllHooks: true,
				hooks: {
					PreToolUse: [
						{ type: 'command', command: 'echo "test"' }
					]
				}
			};

			const result = parseHooksFromFile(fileUri, json, workspaceRoot, userHome);

			assert.strictEqual(result.format, HookSourceFormat.Copilot);
			assert.strictEqual(result.disabledAllHooks, true);
			assert.strictEqual(result.hooks.size, 0);
		});

		test('uses Claude format for .claude/settings.json files', () => {
			const fileUri = URI.file('/workspace/.claude/settings.json');
			const json = {
				disableAllHooks: true,
				hooks: {
					PreToolUse: [
						{ type: 'command', command: 'echo "test"' }
					]
				}
			};

			const result = parseHooksFromFile(fileUri, json, workspaceRoot, userHome);

			assert.strictEqual(result.format, HookSourceFormat.Claude);
			assert.strictEqual(result.disabledAllHooks, true);
			assert.strictEqual(result.hooks.size, 0);
		});

		test('propagates disabledAllHooks from Copilot format', () => {
			const fileUri = URI.file('/workspace/.github/hooks/hooks.json');
			const json = {
				disableAllHooks: true,
				hooks: {
					SessionStart: [
						{ type: 'command', command: 'echo "start"' }
					]
				}
			};

			const result = parseHooksFromFile(fileUri, json, workspaceRoot, userHome);

			assert.strictEqual(result.disabledAllHooks, true);
			assert.strictEqual(result.hooks.size, 0);
		});

		test('propagates disabledAllHooks from Claude format', () => {
			const fileUri = URI.file('/workspace/.claude/settings.local.json');
			const json = {
				disableAllHooks: true,
				hooks: {
					SessionStart: [
						{ type: 'command', command: 'echo "start"' }
					]
				}
			};

			const result = parseHooksFromFile(fileUri, json, workspaceRoot, userHome);

			assert.strictEqual(result.disabledAllHooks, true);
			assert.strictEqual(result.hooks.size, 0);
		});
	});
});
