/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { getChatUpgradePlanURI } from '../../../../services/chat/common/chatEntitlementService.js';

suite('chatEntitlementService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('adds a stable return_to deep link for upgrade flows', () => {
		const productService = {
			quality: 'stable',
			urlProtocol: 'vscode',
			defaultChatAgent: {
				upgradePlanUrl: 'https://github.com/github-copilot/signup/copilot_individual?utm_source=vscode',
				chatExtensionId: 'GitHub.copilot-chat'
			}
		} as IProductService;

		const upgradePlanUri = getChatUpgradePlanURI(productService);

		assert.ok(upgradePlanUri);
		const upgradeQuery = new URLSearchParams(upgradePlanUri.query);
		assert.strictEqual(upgradeQuery.get('utm_source'), 'vscode');
		const returnTo = upgradeQuery.get('return_to');
		assert.ok(returnTo);

		assert.strictEqual(returnTo, 'https://vscode.dev/redirect?url=vscode://github.copilot-chat');
		const returnToUrl = new URL(returnTo);
		assert.strictEqual(returnToUrl.searchParams.get('url'), 'vscode://github.copilot-chat');
	});

	test('adds an insiders return_to deep link for upgrade flows', () => {
		const productService = {
			quality: 'insider',
			urlProtocol: 'vscode-insiders',
			defaultChatAgent: {
				upgradePlanUrl: 'https://github.com/github-copilot/signup/copilot_individual?utm_source=vscode',
				chatExtensionId: 'GitHub.copilot-chat'
			}
		} as IProductService;

		const upgradePlanUri = getChatUpgradePlanURI(productService);

		assert.ok(upgradePlanUri);
		const upgradeQuery = new URLSearchParams(upgradePlanUri.query);
		assert.strictEqual(upgradeQuery.get('utm_source'), 'vscode');
		const returnTo = upgradeQuery.get('return_to');
		assert.ok(returnTo);

		assert.strictEqual(returnTo, 'https://insiders.vscode.dev/redirect?url=vscode-insiders://github.copilot-chat');
		const returnToUrl = new URL(returnTo);
		assert.strictEqual(returnToUrl.searchParams.get('url'), 'vscode-insiders://github.copilot-chat');
	});

	test('falls back to the configured upgrade url when no chat extension id exists', () => {
		const productService = {
			quality: 'stable',
			urlProtocol: 'vscode',
			defaultChatAgent: {
				upgradePlanUrl: 'https://github.com/github-copilot/signup/copilot_individual?utm_source=vscode'
			}
		} as IProductService;

		const upgradePlanUri = getChatUpgradePlanURI(productService);

		assert.ok(upgradePlanUri);
		assert.strictEqual(upgradePlanUri.toString(true), 'https://github.com/github-copilot/signup/copilot_individual?utm_source=vscode');
	});
});