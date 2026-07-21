/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildCodexLaunchConfig, buildCodexResumeParams } from '../../../node/codex/codexLaunchConfig.js';

suite('CodexLaunchConfig', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('copilot config injects proxy credentials and provider overrides', () => {
		const config = buildCodexLaunchConfig('copilot', { PATH: '/bin', OPENAI_API_KEY: 'personal' }, { baseUrl: 'http://127.0.0.1:1234', nonce: 'nonce' }, ['--log-level=debug']);
		assert.deepStrictEqual(config.env, { PATH: '/bin', OPENAI_API_KEY: 'nonce' });
		assert.ok(config.args.includes('model_provider="vscode-proxy"'));
		assert.ok(config.args.includes('features.image_generation=false'));
		assert.strictEqual(config.args.at(-1), '--log-level=debug');
	});

	test('openai config preserves user credentials and omits proxy overrides', () => {
		const config = buildCodexLaunchConfig('openai', { PATH: '/bin', OPENAI_API_KEY: 'personal', CODEX_HOME: '/codex' }, undefined, []);
		assert.deepStrictEqual(config.env, { PATH: '/bin', OPENAI_API_KEY: 'personal', CODEX_HOME: '/codex' });
		assert.deepStrictEqual(config.args, ['app-server', '-c', 'features.tool_call_mcp_elicitation=false']);
	});

	test('resume overrides a thread persisted with a different usage source', () => {
		assert.deepStrictEqual(buildCodexResumeParams('openai', 'thread-a', {}), {
			threadId: 'thread-a',
			modelProvider: 'openai',
		});
		assert.deepStrictEqual(buildCodexResumeParams('copilot', 'thread-b', { GitHub: { url: 'https://api.githubcopilot.com/mcp/' } }), {
			threadId: 'thread-b',
			modelProvider: 'vscode-proxy',
			config: { mcp_servers: { GitHub: { url: 'https://api.githubcopilot.com/mcp/' } } },
		});
	});
});
