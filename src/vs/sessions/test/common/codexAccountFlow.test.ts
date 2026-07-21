/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { activateOpenAIAccount } from '../../common/codexAccountFlow.js';

suite('CodexAccountFlow', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reuses an existing signed-in OpenAI account without starting login', async () => {
		const calls: string[] = [];
		await activateOpenAIAccount(
			async () => { calls.push('source'); },
			async () => { calls.push('read'); return { usageSource: 'openai', status: 'signedIn', authType: 'chatgpt' }; },
			async () => { calls.push('login'); },
		);
		assert.deepStrictEqual(calls, ['source', 'read']);
	});

	test('starts login only after a signed-out account is confirmed', async () => {
		const calls: string[] = [];
		await activateOpenAIAccount(
			async () => { calls.push('source'); },
			async () => { calls.push('read'); return { usageSource: 'openai', status: 'signedOut' }; },
			async () => { calls.push('login'); },
		);
		assert.deepStrictEqual(calls, ['source', 'read', 'login']);
	});

	test('does not duplicate a login already in progress', async () => {
		let loginStarted = false;
		await activateOpenAIAccount(
			async () => undefined,
			async () => ({ usageSource: 'openai', status: 'signingIn' }),
			async () => { loginStarted = true; },
		);
		assert.strictEqual(loginStarted, false);
	});

	test('surfaces account read errors instead of starting login', async () => {
		let loginStarted = false;
		await assert.rejects(() => activateOpenAIAccount(
			async () => undefined,
			async () => ({ usageSource: 'openai', status: 'error', error: 'account unavailable' }),
			async () => { loginStarted = true; },
		), /account unavailable/);
		assert.strictEqual(loginStarted, false);
	});
});
