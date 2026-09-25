/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { enterpriseUriSetting, enterpriseUrisSetting, getEnterpriseUriKey, getEnterpriseUris } from '../common/enterpriseConfiguration';

suite('GitHub Enterprise configuration', () => {
	function configuration(legacy?: string, plural?: unknown, scope: 'globalValue' | 'workspaceValue' | 'workspaceFolderValue' = 'globalValue'): vscode.WorkspaceConfiguration {
		const get = sinon.stub();
		get.withArgs(enterpriseUriSetting).returns(legacy);
		get.withArgs(enterpriseUrisSetting).returns(plural === undefined ? [] : plural);
		const inspect = sinon.stub();
		inspect.withArgs(enterpriseUrisSetting).returns({ key: enterpriseUrisSetting, defaultValue: [], [scope]: plural });
		return { get, inspect, has: sinon.stub(), update: sinon.stub() };
	}

	for (const { name, legacy, plural, expected } of [
		{ name: 'no configuration', legacy: undefined, plural: undefined, expected: [] },
		{ name: 'schema default does not shadow legacy', legacy: 'https://legacy.example', plural: undefined, expected: ['https://legacy.example'] },
		{ name: 'plural only', legacy: undefined, plural: ['https://a.example', 'https://b.example'], expected: ['https://a.example', 'https://b.example'] },
		{ name: 'plural takes precedence', legacy: 'https://legacy.example', plural: ['https://a.example'], expected: ['https://a.example'] },
		{ name: 'explicit empty disables legacy', legacy: 'https://legacy.example', plural: [], expected: [] },
		{ name: 'invalid legacy is ignored when plural is configured', legacy: 'not a URL', plural: ['https://a.example'], expected: ['https://a.example'] },
	]) {
		test(name, () => {
			assert.deepStrictEqual(getEnterpriseUris(configuration(legacy, plural)).map(uri => uri.toString()), expected.map(value => vscode.Uri.parse(value).toString()));
		});
	}

	for (const scope of ['globalValue', 'workspaceValue', 'workspaceFolderValue'] as const) {
		test(`explicit empty at ${scope} disables legacy`, () => {
			assert.deepStrictEqual(getEnterpriseUris(configuration('https://legacy.example', [], scope)), []);
		});
	}

	for (const plural of [null, 'https://a.example', [42], ['not a URL'], ['https://github.com'], ['https://a.example?query'], ['https://a.example#fragment'], ['https://user:password@a.example'], ['file:///a'], ['https://a.example/../b'], ['https://a.example/a//b']]) {
		test(`invalid plural ${JSON.stringify(plural)} never falls back to legacy`, () => {
			assert.throws(() => getEnterpriseUris(configuration('https://legacy.example', plural)), /GitHub Enterprise/);
		});
	}

	test('canonical identity preserves path case, ports and HTTP support', () => {
		const values = ['https://GHE.EXAMPLE:8443/Team%20One/', 'https://ghe.example:8443/Team%20One', 'http://ghe.example/Team', 'https://ghe.example/team'];
		assert.deepStrictEqual(getEnterpriseUris(configuration(undefined, values)).map(getEnterpriseUriKey), [
			'https://ghe.example:8443/Team%20One',
			'https://ghe.example:8443/Team%20One',
			'http://ghe.example/Team',
			'https://ghe.example/team'
		]);
	});
});
