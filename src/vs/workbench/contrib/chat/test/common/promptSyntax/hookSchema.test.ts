/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { HookType, normalizeHookTypeId, resolveHookCommand } from '../../../common/promptSyntax/hookSchema.js';
import { URI } from '../../../../../../base/common/uri.js';

suite('HookSchema', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('normalizeHookTypeId', () => {

		suite('GitHub Copilot canonical hook types', () => {
			// @see https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-hooks#types-of-hooks

			test('sessionStart', () => {
				assert.strictEqual(normalizeHookTypeId('sessionStart'), HookType.SessionStart);
			});

			test('userPromptSubmitted', () => {
				assert.strictEqual(normalizeHookTypeId('userPromptSubmitted'), HookType.UserPromptSubmitted);
			});

			test('preToolUse', () => {
				assert.strictEqual(normalizeHookTypeId('preToolUse'), HookType.PreToolUse);
			});

			test('postToolUse', () => {
				assert.strictEqual(normalizeHookTypeId('postToolUse'), HookType.PostToolUse);
			});

			test('postToolUseFailure', () => {
				assert.strictEqual(normalizeHookTypeId('postToolUseFailure'), HookType.PostToolUseFailure);
			});

			test('subagentStart', () => {
				assert.strictEqual(normalizeHookTypeId('subagentStart'), HookType.SubagentStart);
			});

			test('subagentStop', () => {
				assert.strictEqual(normalizeHookTypeId('subagentStop'), HookType.SubagentStop);
			});

			test('stop', () => {
				assert.strictEqual(normalizeHookTypeId('stop'), HookType.Stop);
			});
		});

		suite('Claude Code hook types (PascalCase)', () => {
			// @see https://code.claude.com/docs/en/hooks#hook-lifecycle

			test('SessionStart -> sessionStart', () => {
				assert.strictEqual(normalizeHookTypeId('SessionStart'), HookType.SessionStart);
			});

			test('UserPromptSubmit -> userPromptSubmitted', () => {
				assert.strictEqual(normalizeHookTypeId('UserPromptSubmit'), HookType.UserPromptSubmitted);
			});

			test('PreToolUse -> preToolUse', () => {
				assert.strictEqual(normalizeHookTypeId('PreToolUse'), HookType.PreToolUse);
			});

			test('PostToolUse -> postToolUse', () => {
				assert.strictEqual(normalizeHookTypeId('PostToolUse'), HookType.PostToolUse);
			});

			test('PostToolUseFailure -> postToolUseFailure', () => {
				assert.strictEqual(normalizeHookTypeId('PostToolUseFailure'), HookType.PostToolUseFailure);
			});

			test('SubagentStart -> subagentStart', () => {
				assert.strictEqual(normalizeHookTypeId('SubagentStart'), HookType.SubagentStart);
			});

			test('SubagentStop -> subagentStop', () => {
				assert.strictEqual(normalizeHookTypeId('SubagentStop'), HookType.SubagentStop);
			});

			test('Stop -> stop', () => {
				assert.strictEqual(normalizeHookTypeId('Stop'), HookType.Stop);
			});
		});

		suite('Cursor hook types', () => {
			// @see https://cursor.com/docs/agent/hooks#agent-and-tab-support

			test('beforePromptSubmit -> userPromptSubmitted', () => {
				assert.strictEqual(normalizeHookTypeId('beforePromptSubmit'), HookType.UserPromptSubmitted);
			});
		});

		suite('unknown hook types', () => {
			test('unknown type returns undefined', () => {
				assert.strictEqual(normalizeHookTypeId('unknownHook'), undefined);
			});

			test('empty string returns undefined', () => {
				assert.strictEqual(normalizeHookTypeId(''), undefined);
			});

			test('typo returns undefined', () => {
				assert.strictEqual(normalizeHookTypeId('sessionstart'), undefined);
				assert.strictEqual(normalizeHookTypeId('SESSIONSTART'), undefined);
			});
		});
	});

	suite('resolveHookCommand', () => {
		const workspaceRoot = URI.file('/workspace');
		const userHome = '/home/user';

		suite('command property', () => {
			test('resolves basic command', () => {
				const result = resolveHookCommand({
					type: 'command',
					command: 'echo hello'
				}, workspaceRoot, userHome);
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'echo hello',
					cwd: workspaceRoot
				});
			});

			test('resolves command with all optional properties', () => {
				const result = resolveHookCommand({
					type: 'command',
					command: './scripts/validate.sh',
					cwd: 'src',
					env: { NODE_ENV: 'test' },
					timeoutSec: 60
				}, workspaceRoot, userHome);
				assert.deepStrictEqual(result, {
					type: 'command',
					command: './scripts/validate.sh',
					cwd: URI.file('/workspace/src'),
					env: { NODE_ENV: 'test' },
					timeoutSec: 60
				});
			});

			test('empty command returns undefined', () => {
				const result = resolveHookCommand({
					type: 'command',
					command: ''
				}, workspaceRoot, userHome);
				assert.strictEqual(result, undefined);
			});
		});

		suite('bash shorthand', () => {
			test('resolves bash to command', () => {
				const result = resolveHookCommand({
					type: 'command',
					bash: 'echo "hello world"'
				}, workspaceRoot, userHome);
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'bash -c "echo \\"hello world\\""',
					cwd: workspaceRoot
				});
			});

			test('bash with cwd and env', () => {
				const result = resolveHookCommand({
					type: 'command',
					bash: './test.sh',
					cwd: 'scripts',
					env: { DEBUG: '1' }
				}, workspaceRoot, userHome);
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'bash -c "./test.sh"',
					cwd: URI.file('/workspace/scripts'),
					env: { DEBUG: '1' }
				});
			});

			test('empty bash returns undefined', () => {
				const result = resolveHookCommand({
					type: 'command',
					bash: ''
				}, workspaceRoot, userHome);
				assert.strictEqual(result, undefined);
			});
		});

		suite('powershell shorthand', () => {
			test('resolves powershell to command', () => {
				const result = resolveHookCommand({
					type: 'command',
					powershell: 'Write-Host "hello"'
				}, workspaceRoot, userHome);
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'powershell -Command "Write-Host \\"hello\\""',
					cwd: workspaceRoot
				});
			});

			test('powershell with timeoutSec', () => {
				const result = resolveHookCommand({
					type: 'command',
					powershell: 'Get-Process',
					timeoutSec: 30
				}, workspaceRoot, userHome);
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'powershell -Command "Get-Process"',
					cwd: workspaceRoot,
					timeoutSec: 30
				});
			});

			test('empty powershell returns undefined', () => {
				const result = resolveHookCommand({
					type: 'command',
					powershell: ''
				}, workspaceRoot, userHome);
				assert.strictEqual(result, undefined);
			});
		});

		suite('priority when multiple specified', () => {
			test('command takes precedence over bash', () => {
				const result = resolveHookCommand({
					type: 'command',
					command: 'direct-command',
					bash: 'bash-script.sh'
				}, workspaceRoot, userHome);
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'direct-command',
					cwd: workspaceRoot
				});
			});

			test('command takes precedence over powershell', () => {
				const result = resolveHookCommand({
					type: 'command',
					command: 'direct-command',
					powershell: 'ps-script.ps1'
				}, workspaceRoot, userHome);
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'direct-command',
					cwd: workspaceRoot
				});
			});

			test('bash takes precedence over powershell when no command', () => {
				const result = resolveHookCommand({
					type: 'command',
					bash: 'bash-script.sh',
					powershell: 'ps-script.ps1'
				}, workspaceRoot, userHome);
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'bash -c "bash-script.sh"',
					cwd: workspaceRoot
				});
			});
		});

		suite('cwd resolution', () => {
			test('cwd is not resolved when no workspace root', () => {
				const result = resolveHookCommand({
					type: 'command',
					command: 'echo hello',
					cwd: 'src'
				}, undefined, userHome);
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'echo hello'
				});
			});

			test('cwd is resolved relative to workspace root', () => {
				const result = resolveHookCommand({
					type: 'command',
					command: 'echo hello',
					cwd: 'nested/path'
				}, workspaceRoot, userHome);
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'echo hello',
					cwd: URI.file('/workspace/nested/path')
				});
			});
		});

		suite('invalid inputs', () => {
			test('wrong type returns undefined', () => {
				const result = resolveHookCommand({
					type: 'script',
					command: 'echo hello'
				}, workspaceRoot, userHome);
				assert.strictEqual(result, undefined);
			});

			test('missing type returns undefined', () => {
				const result = resolveHookCommand({
					command: 'echo hello'
				}, workspaceRoot, userHome);
				assert.strictEqual(result, undefined);
			});

			test('no command/bash/powershell returns undefined', () => {
				const result = resolveHookCommand({
					type: 'command',
					cwd: '/workspace'
				}, workspaceRoot, userHome);
				assert.strictEqual(result, undefined);
			});

			test('ignores non-string cwd', () => {
				const result = resolveHookCommand({
					type: 'command',
					command: 'echo hello',
					cwd: 123
				}, workspaceRoot, userHome);
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'echo hello',
					cwd: workspaceRoot
				});
			});

			test('ignores non-object env', () => {
				const result = resolveHookCommand({
					type: 'command',
					command: 'echo hello',
					env: 'invalid'
				}, workspaceRoot, userHome);
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'echo hello',
					cwd: workspaceRoot
				});
			});

			test('ignores non-number timeoutSec', () => {
				const result = resolveHookCommand({
					type: 'command',
					command: 'echo hello',
					timeoutSec: '30'
				}, workspaceRoot, userHome);
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'echo hello',
					cwd: workspaceRoot
				});
			});
		});
	});
});
