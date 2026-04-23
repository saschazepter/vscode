/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { InMemoryStorageService, IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { AgentCustomizationDisableProvider } from '../../../browser/agentSessions/agentHost/agentCustomizationDisableProvider.js';

suite('AgentCustomizationDisableProvider (opt-out)', () => {

	const disposables = new DisposableStore();
	let storageService: IStorageService;

	setup(() => {
		storageService = disposables.add(new InMemoryStorageService());
	});

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	function createProvider(harnessId = 'test-agent'): AgentCustomizationDisableProvider {
		return disposables.add(new AgentCustomizationDisableProvider(harnessId, storageService));
	}

	test('items are enabled by default (nothing disabled)', () => {
		const provider = createProvider();
		const uri = URI.parse('file:///plugin-a');
		assert.strictEqual(provider.isDisabled(uri), false);
	});

	test('setDisabled toggles the disabled flag and round-trips', () => {
		const provider = createProvider();
		const uri = URI.parse('file:///plugin-a');

		provider.setDisabled(uri, true);
		assert.strictEqual(provider.isDisabled(uri), true);

		provider.setDisabled(uri, false);
		assert.strictEqual(provider.isDisabled(uri), false);
	});

	test('onDidChange fires only when the disabled set actually changes', () => {
		const provider = createProvider();
		const uri = URI.parse('file:///plugin-a');
		let count = 0;
		disposables.add(provider.onDidChange(() => count++));

		provider.setDisabled(uri, true);
		provider.setDisabled(uri, true);  // no-op
		provider.setDisabled(uri, false);
		provider.setDisabled(uri, false); // no-op

		assert.strictEqual(count, 2);
	});

	test('disabled set persists across instances of the same harness', () => {
		const uri = URI.parse('file:///plugin-a');

		const first = createProvider('persisted-agent');
		first.setDisabled(uri, true);

		const second = createProvider('persisted-agent');
		assert.strictEqual(second.isDisabled(uri), true);
	});

	test('disabled sets are isolated per harness', () => {
		const uri = URI.parse('file:///plugin-a');
		const a = createProvider('agent-a');
		const b = createProvider('agent-b');

		a.setDisabled(uri, true);

		assert.strictEqual(a.isDisabled(uri), true);
		assert.strictEqual(b.isDisabled(uri), false);
	});
});
