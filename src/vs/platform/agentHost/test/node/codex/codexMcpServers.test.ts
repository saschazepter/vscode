/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { McpServerStatus } from '../../../common/state/protocol/channels-session/state.js';
import { buildCodexMcpReadResult, codexMcpListToInventory, codexMcpServersFromConfig, codexMcpStatusToEntry, codexMcpToolsChanged, codexToolMapToArray, inventoryToSdkServers, translateCodexMcpStartupState } from '../../../node/codex/codexMcpServers.js';
import type { McpServerStatus as CodexMcpServerStatus } from '../../../node/codex/protocol/generated/v2/McpServerStatus.js';
import type { Tool } from '../../../node/codex/protocol/generated/Tool.js';

suite('codexMcpServers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const tool = (name: string): Tool => ({ name, inputSchema: { type: 'object' } });

	const status = (name: string, tools: Tool[]): CodexMcpServerStatus => ({
		name,
		serverInfo: null,
		tools: Object.fromEntries(tools.map(t => [t.name, t])),
		resources: [{ name: `${name}-res`, uri: `mem://${name}/r` }],
		resourceTemplates: [{ name: `${name}-tpl`, uriTemplate: `mem://${name}/{id}` }],
		authStatus: 'unsupported',
	});

	test('translateCodexMcpStartupState maps every lifecycle state', () => {
		assert.deepStrictEqual([
			translateCodexMcpStartupState('ready', null),
			translateCodexMcpStartupState('starting', null),
			translateCodexMcpStartupState('failed', 'boom'),
			translateCodexMcpStartupState('failed', null),
			translateCodexMcpStartupState('cancelled', null),
		], [
			{ kind: McpServerStatus.Ready },
			{ kind: McpServerStatus.Starting },
			{ kind: McpServerStatus.Error, error: { errorType: 'mcp-server-failed', message: 'boom' } },
			{ kind: McpServerStatus.Error, error: { errorType: 'mcp-server-failed', message: 'MCP server failed to start' } },
			{ kind: McpServerStatus.Stopped },
		]);
	});

	test('codexToolMapToArray flattens and name-sorts, dropping holes', () => {
		const tools = { beta: tool('beta'), alpha: tool('alpha'), gone: undefined };
		assert.deepStrictEqual(codexToolMapToArray(tools).map(t => t.name), ['alpha', 'beta']);
	});

	test('codexMcpListToInventory + inventoryToSdkServers build a Ready snapshot', () => {
		const inventory = codexMcpListToInventory([status('s1', [tool('t1')]), status('s2', [])]);
		assert.deepStrictEqual({
			s1: codexMcpStatusToEntry(status('s1', [tool('t1')])),
			sdk: inventoryToSdkServers(inventory),
		}, {
			s1: {
				state: { kind: McpServerStatus.Ready },
				tools: [tool('t1')],
				resources: [{ name: 's1-res', uri: 'mem://s1/r' }],
				resourceTemplates: [{ name: 's1-tpl', uriTemplate: 'mem://s1/{id}' }],
			},
			sdk: [
				{ name: 's1', state: { kind: McpServerStatus.Ready } },
				{ name: 's2', state: { kind: McpServerStatus.Ready } },
			],
		});
	});

	test('buildCodexMcpReadResult answers read methods from cache and defers the rest', () => {
		const entry = codexMcpStatusToEntry(status('s1', [tool('t1')]));
		assert.deepStrictEqual({
			tools: buildCodexMcpReadResult('tools/list', entry),
			resources: buildCodexMcpReadResult('resources/list', entry),
			templates: buildCodexMcpReadResult('resources/templates/list', entry),
			call: buildCodexMcpReadResult('tools/call', entry),
		}, {
			tools: { handled: true, result: { tools: [tool('t1')] } },
			resources: { handled: true, result: { resources: [{ name: 's1-res', uri: 'mem://s1/r' }] } },
			templates: { handled: true, result: { resourceTemplates: [{ name: 's1-tpl', uriTemplate: 'mem://s1/{id}' }] } },
			call: { handled: false },
		});
	});

	test('codexMcpToolsChanged detects tool-set changes by name', () => {
		const a = codexMcpStatusToEntry(status('s', [tool('t1')]));
		const sameNames = codexMcpStatusToEntry(status('s', [tool('t1')]));
		const added = codexMcpStatusToEntry(status('s', [tool('t1'), tool('t2')]));
		assert.deepStrictEqual([
			codexMcpToolsChanged(a, sameNames),
			codexMcpToolsChanged(a, added),
			codexMcpToolsChanged(undefined, a),
		], [false, true, true]);
	});

	suite('codexMcpServersFromConfig', () => {

		test('maps stdio + http servers, stringifies env, and maps headers to http_headers', () => {
			assert.deepStrictEqual(codexMcpServersFromConfig({
				local: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { KEY: 'val', N: 3, DROP: null }, cwd: '/w' },
				remote: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'token-value' } },
			}), {
				local: { command: 'npx', args: ['-y', 'pkg'], env: { KEY: 'val', N: '3' }, cwd: '/w' },
				remote: { url: 'https://x/mcp', http_headers: { Authorization: 'token-value' } },
			});
		});

		test('omits empty args/env/headers and command-only stdio', () => {
			assert.deepStrictEqual(codexMcpServersFromConfig({
				bare: { type: 'stdio', command: 'run', args: [], env: {} },
				plain: { type: 'http', url: 'https://y' },
			}), {
				bare: { command: 'run' },
				plain: { url: 'https://y' },
			});
		});

		test('keeps server names with dots/spaces (per-thread JSON keys, not `-c` override keys)', () => {
			assert.deepStrictEqual(codexMcpServersFromConfig({
				'dotted.name': { type: 'stdio', command: 'ok' },
				' spaced ': { type: 'http', url: 'https://z' },
			}), {
				'dotted.name': { command: 'ok' },
				' spaced ': { url: 'https://z' },
			});
		});

		test('skips malformed / unsupported entries', () => {
			assert.deepStrictEqual(codexMcpServersFromConfig({
				noCommand: { type: 'stdio' },
				noUrl: { type: 'http' },
				unknownType: { type: 'sse', url: 'https://z' },
				notObject: 42,
				good: { type: 'stdio', command: 'ok' },
			} as Record<string, unknown>), {
				good: { command: 'ok' },
			});
		});

		test('returns empty for undefined / empty config', () => {
			assert.deepStrictEqual([
				codexMcpServersFromConfig(undefined),
				codexMcpServersFromConfig({}),
			], [{}, {}]);
		});
	});
});
