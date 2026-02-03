/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { findHookCommandSelection } from '../../../browser/promptSyntax/hookUtils.js';

suite('hookUtils', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('findHookCommandSelection', () => {

		test('finds command field in first hook entry', () => {
			const content = '{\n\t"sessionStart": [\n\t\t{\n\t\t\t"command": "echo hello"\n\t\t}\n\t]\n}';
			const result = findHookCommandSelection(content, 'sessionStart', 0, 'command');
			assert.deepStrictEqual(result, {
				startLineNumber: 4,
				startColumn: 16,
				endLineNumber: 4,
				endColumn: 26
			});
		});

		test('finds command field in second hook entry', () => {
			const content = '{\n\t"sessionStart": [\n\t\t{\n\t\t\t"command": "first"\n\t\t},\n\t\t{\n\t\t\t"command": "second"\n\t\t}\n\t]\n}';
			const result = findHookCommandSelection(content, 'sessionStart', 1, 'command');
			assert.deepStrictEqual(result, {
				startLineNumber: 7,
				startColumn: 16,
				endLineNumber: 7,
				endColumn: 22
			});
		});

		test('finds bash field for platform-specific hook', () => {
			const content = '{\n\t"preToolUse": [\n\t\t{\n\t\t\t"bash": "bash command",\n\t\t\t"powershell": "powershell command"\n\t\t}\n\t]\n}';
			const result = findHookCommandSelection(content, 'preToolUse', 0, 'bash');
			assert.deepStrictEqual(result, {
				startLineNumber: 4,
				startColumn: 12,
				endLineNumber: 4,
				endColumn: 24
			});
		});

		test('finds powershell field for platform-specific hook', () => {
			const content = '{\n\t"preToolUse": [\n\t\t{\n\t\t\t"bash": "bash command",\n\t\t\t"powershell": "powershell command"\n\t\t}\n\t]\n}';
			const result = findHookCommandSelection(content, 'preToolUse', 0, 'powershell');
			assert.deepStrictEqual(result, {
				startLineNumber: 5,
				startColumn: 18,
				endLineNumber: 5,
				endColumn: 36
			});
		});

		test('returns undefined for non-existent hook type', () => {
			const content = '{\n\t"sessionStart": [\n\t\t{\n\t\t\t"command": "echo hello"\n\t\t}\n\t]\n}';
			const result = findHookCommandSelection(content, 'nonExistent', 0, 'command');
			assert.strictEqual(result, undefined);
		});

		test('returns undefined for out-of-bounds index', () => {
			const content = '{\n\t"sessionStart": [\n\t\t{\n\t\t\t"command": "echo hello"\n\t\t}\n\t]\n}';
			const result = findHookCommandSelection(content, 'sessionStart', 5, 'command');
			assert.strictEqual(result, undefined);
		});

		test('returns undefined for non-existent field', () => {
			const content = '{\n\t"sessionStart": [\n\t\t{\n\t\t\t"command": "echo hello"\n\t\t}\n\t]\n}';
			const result = findHookCommandSelection(content, 'sessionStart', 0, 'bash');
			assert.strictEqual(result, undefined);
		});

		test('returns undefined for invalid JSON', () => {
			const content = '{ invalid json }';
			const result = findHookCommandSelection(content, 'sessionStart', 0, 'command');
			assert.strictEqual(result, undefined);
		});

		test('returns undefined for empty content', () => {
			const result = findHookCommandSelection('', 'sessionStart', 0, 'command');
			assert.strictEqual(result, undefined);
		});

		test('handles command with special characters', () => {
			const content = '{\n\t"sessionStart": [\n\t\t{\n\t\t\t"command": "echo \\"quoted\\""\n\t\t}\n\t]\n}';
			const result = findHookCommandSelection(content, 'sessionStart', 0, 'command');
			assert.deepStrictEqual(result, {
				startLineNumber: 4,
				startColumn: 16,
				endLineNumber: 4,
				endColumn: 32
			});
		});

		test('works with different hook types', () => {
			const content = '{\n\t"userPromptSubmitted": [\n\t\t{\n\t\t\t"command": "validate"\n\t\t}\n\t],\n\t"postToolUse": [\n\t\t{\n\t\t\t"command": "cleanup"\n\t\t}\n\t]\n}';
			const result1 = findHookCommandSelection(content, 'userPromptSubmitted', 0, 'command');
			assert.deepStrictEqual(result1, {
				startLineNumber: 4,
				startColumn: 16,
				endLineNumber: 4,
				endColumn: 24
			});

			const result2 = findHookCommandSelection(content, 'postToolUse', 0, 'command');
			assert.deepStrictEqual(result2, {
				startLineNumber: 9,
				startColumn: 16,
				endLineNumber: 9,
				endColumn: 23
			});
		});

		test('handles hooks with additional properties', () => {
			const content = '{\n\t"sessionStart": [\n\t\t{\n\t\t\t"command": "my-command",\n\t\t\t"cwd": "/some/path",\n\t\t\t"timeoutSec": 30\n\t\t}\n\t]\n}';
			const result = findHookCommandSelection(content, 'sessionStart', 0, 'command');
			assert.deepStrictEqual(result, {
				startLineNumber: 4,
				startColumn: 16,
				endLineNumber: 4,
				endColumn: 26
			});
		});
	});
});
