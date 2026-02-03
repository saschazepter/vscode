/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { HookType, normalizeHookTypeId, normalizeHookCommand } from '../../../common/promptSyntax/hookSchema.js';

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

	suite('normalizeHookCommand', () => {

		suite('command property', () => {
			test('normalizes basic command', () => {
				const result = normalizeHookCommand({
					type: 'command',
					command: 'echo hello'
				});
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'echo hello'
				});
			});

			test('normalizes command with all optional properties', () => {
				const result = normalizeHookCommand({
					type: 'command',
					command: './scripts/validate.sh',
					cwd: '/workspace',
					env: { NODE_ENV: 'test' },
					timeoutSec: 60
				});
				assert.deepStrictEqual(result, {
					type: 'command',
					command: './scripts/validate.sh',
					cwd: '/workspace',
					env: { NODE_ENV: 'test' },
					timeoutSec: 60
				});
			});

			test('empty command returns undefined', () => {
				const result = normalizeHookCommand({
					type: 'command',
					command: ''
				});
				assert.strictEqual(result, undefined);
			});
		});

		suite('bash shorthand', () => {
			test('normalizes bash to command', () => {
				const result = normalizeHookCommand({
					type: 'command',
					bash: 'echo "hello world"'
				});
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'bash -c "echo \\"hello world\\""'
				});
			});

			test('bash with cwd and env', () => {
				const result = normalizeHookCommand({
					type: 'command',
					bash: './test.sh',
					cwd: '/home/user',
					env: { DEBUG: '1' }
				});
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'bash -c "./test.sh"',
					cwd: '/home/user',
					env: { DEBUG: '1' }
				});
			});

			test('empty bash returns undefined', () => {
				const result = normalizeHookCommand({
					type: 'command',
					bash: ''
				});
				assert.strictEqual(result, undefined);
			});
		});

		suite('powershell shorthand', () => {
			test('normalizes powershell to command', () => {
				const result = normalizeHookCommand({
					type: 'command',
					powershell: 'Write-Host "hello"'
				});
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'powershell -Command "Write-Host \\"hello\\""'
				});
			});

			test('powershell with timeoutSec', () => {
				const result = normalizeHookCommand({
					type: 'command',
					powershell: 'Get-Process',
					timeoutSec: 30
				});
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'powershell -Command "Get-Process"',
					timeoutSec: 30
				});
			});

			test('empty powershell returns undefined', () => {
				const result = normalizeHookCommand({
					type: 'command',
					powershell: ''
				});
				assert.strictEqual(result, undefined);
			});
		});

		suite('priority when multiple specified', () => {
			test('command takes precedence over bash', () => {
				const result = normalizeHookCommand({
					type: 'command',
					command: 'direct-command',
					bash: 'bash-script.sh'
				});
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'direct-command'
				});
			});

			test('command takes precedence over powershell', () => {
				const result = normalizeHookCommand({
					type: 'command',
					command: 'direct-command',
					powershell: 'ps-script.ps1'
				});
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'direct-command'
				});
			});

			test('bash takes precedence over powershell when no command', () => {
				const result = normalizeHookCommand({
					type: 'command',
					bash: 'bash-script.sh',
					powershell: 'ps-script.ps1'
				});
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'bash -c "bash-script.sh"'
				});
			});
		});

		suite('invalid inputs', () => {
			test('wrong type returns undefined', () => {
				const result = normalizeHookCommand({
					type: 'script',
					command: 'echo hello'
				});
				assert.strictEqual(result, undefined);
			});

			test('missing type returns undefined', () => {
				const result = normalizeHookCommand({
					command: 'echo hello'
				});
				assert.strictEqual(result, undefined);
			});

			test('no command/bash/powershell returns undefined', () => {
				const result = normalizeHookCommand({
					type: 'command',
					cwd: '/workspace'
				});
				assert.strictEqual(result, undefined);
			});

			test('ignores non-string cwd', () => {
				const result = normalizeHookCommand({
					type: 'command',
					command: 'echo hello',
					cwd: 123
				});
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'echo hello'
				});
			});

			test('ignores non-object env', () => {
				const result = normalizeHookCommand({
					type: 'command',
					command: 'echo hello',
					env: 'invalid'
				});
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'echo hello'
				});
			});

			test('ignores non-number timeoutSec', () => {
				const result = normalizeHookCommand({
					type: 'command',
					command: 'echo hello',
					timeoutSec: '30'
				});
				assert.deepStrictEqual(result, {
					type: 'command',
					command: 'echo hello'
				});
			});
		});
	});
});
