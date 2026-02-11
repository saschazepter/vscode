/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { copilotCliAssetName } from '../../common/copilotCliService.js';

suite('copilotCliAssetName', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('windows x64 produces .exe suffix', () => {
		assert.strictEqual(copilotCliAssetName('win32', 'x64'), 'copilot-windows-amd64.exe');
	});

	test('windows arm64 produces .exe suffix', () => {
		assert.strictEqual(copilotCliAssetName('win32', 'arm64'), 'copilot-windows-arm64.exe');
	});

	test('macOS x64 has no file extension', () => {
		assert.strictEqual(copilotCliAssetName('darwin', 'x64'), 'copilot-darwin-amd64');
	});

	test('macOS arm64 (Apple Silicon)', () => {
		assert.strictEqual(copilotCliAssetName('darwin', 'arm64'), 'copilot-darwin-arm64');
	});

	test('linux x64 has no file extension', () => {
		assert.strictEqual(copilotCliAssetName('linux', 'x64'), 'copilot-linux-amd64');
	});

	test('linux arm64', () => {
		assert.strictEqual(copilotCliAssetName('linux', 'arm64'), 'copilot-linux-arm64');
	});

	test('unknown platform defaults to linux', () => {
		assert.strictEqual(copilotCliAssetName('freebsd', 'x64'), 'copilot-linux-amd64');
	});

	test('unknown arch defaults to amd64', () => {
		assert.strictEqual(copilotCliAssetName('linux', 'ia32'), 'copilot-linux-amd64');
	});
});
