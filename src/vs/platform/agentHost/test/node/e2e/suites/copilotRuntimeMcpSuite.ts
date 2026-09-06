/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { retry } from '../../../../../../base/common/async.js';
import { join } from '../../../../../../base/common/path.js';
import { URI } from '../../../../../../base/common/uri.js';
import type { SubscribeResult } from '../../../../common/state/protocol/commands.js';
import { CustomizationEnablementKind, McpServerStatus } from '../../../../common/state/protocol/state.js';
import { ActionType } from '../../../../common/state/sessionActions.js';
import { buildDefaultChatUri, customizationId, CustomizationType, type ClientPluginCustomization, type McpServerCustomization, type PluginCustomization, type SessionState } from '../../../../common/state/sessionState.js';
import { getActionEnvelope, isActionNotification } from '../../serverIntegrationTestHelpers.js';
import { createRealSession, driveTurnToCompletion, textFromContent } from '../harness/agentHostE2ETestHarness.js';
import type { IAgentHostE2ETestContext } from './e2eTestContext.js';

const nodeRequire = createRequire(import.meta.url);

export function defineCopilotRuntimeMcpTests(context: IAgentHostE2ETestContext): void {
	if (context.tier !== 'parity' || context.config.provider !== 'copilotcli') {
		return;
	}

	async function createPluginSession() {
		const root = mkdtempSync(join(tmpdir(), 'ahp-runtime-mcp-'));
		const workspace = join(root, 'workspace');
		const plugin = join(root, 'plugin');
		context.tempDirs.push(root);
		mkdirSync(workspace);
		mkdirSync(plugin);
		execFileSync('git', ['init', '--quiet', workspace]);
		mkdirSync(join(plugin, '.plugin'));
		mkdirSync(join(plugin, 'skills', 'runtime-reference'), { recursive: true });
		writeFileSync(join(plugin, '.plugin', 'plugin.json'), JSON.stringify({ name: 'runtime-mcp' }));
		writeFileSync(join(plugin, 'reference.txt'), 'HOST_PLUGIN_REFERENCE_OK');
		writeFileSync(join(plugin, 'skills', 'runtime-reference', 'SKILL.md'), [
			'---',
			'name: runtime-reference',
			'description: Read the plugin reference',
			'---',
			'Read the plugin reference using view. Derive its absolute path by replacing the exact suffix "/skills/runtime-reference" of this skill base directory with "/reference.txt". Preserve every other directory component, including the numeric version directory. Reply with the exact file contents.',
		].join('\n'));

		const calls = join(workspace, 'mcp-calls.jsonl');
		writeFileSync(calls, '');
		const script = join(plugin, 'probe.cjs');
		writeFileSync(script, [
			`const { appendFileSync } = require("fs");`,
			`const { Server } = require(${JSON.stringify(nodeRequire.resolve('@modelcontextprotocol/sdk/server/index.js'))});`,
			`const { StdioServerTransport } = require(${JSON.stringify(nodeRequire.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});`,
			`const { CallToolRequestSchema, ListToolsRequestSchema } = require(${JSON.stringify(nodeRequire.resolve('@modelcontextprotocol/sdk/types.js'))});`,
			'const server = new Server({ name: "runtime-probe", version: "1.0.0" }, { capabilities: { tools: {} } });',
			'server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{',
			'  name: "runtime_probe", description: "Returns MCP_PROBE followed by the tag",',
			'  inputSchema: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] },',
			'  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }',
			'}] }));',
			'server.setRequestHandler(CallToolRequestSchema, async request => {',
			'  const tag = request.params.arguments.tag;',
			`  appendFileSync(${JSON.stringify(calls)}, JSON.stringify(tag) + "\\n");`,
			'  return { content: [{ type: "text", text: `MCP_PROBE:${tag}` }] };',
			'});',
			'server.connect(new StdioServerTransport());',
		].join('\n'));
		const serverConfig = { command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' }, tools: ['*'] };
		writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { 'runtime-probe': serverConfig } }));
		const pluginUri = URI.file(plugin).toString();
		const clientId = 'runtime-mcp-client';
		const sessionUri = await createRealSession(context.client, context.config, clientId, context.createdSessions, URI.file(workspace));
		const customization: ClientPluginCustomization = {
			type: CustomizationType.Plugin,
			id: customizationId(pluginUri),
			uri: pluginUri,
			name: 'runtime-mcp',
			nonce: '1',
			enablement: [{ kind: CustomizationEnablementKind.Global, enabled: true }],
		};
		context.client.dispatch({
			channel: sessionUri,
			clientSeq: 1,
			action: { type: ActionType.SessionActiveClientSet, activeClient: { clientId, tools: [], customizations: [customization] } },
		});
		await retry(async () => {
			const state = await pluginState(sessionUri, pluginUri);
			assert.ok(state.children?.some(child => child.type === CustomizationType.McpServer));
		}, 100, 100);
		return { sessionUri, pluginUri, calls };
	}

	async function pluginState(sessionUri: string, pluginUri: string): Promise<PluginCustomization> {
		const result = await context.client.call<SubscribeResult>('subscribe', { channel: sessionUri });
		const plugin = (result.snapshot!.state as SessionState).customizations?.find((item): item is PluginCustomization =>
			item.type === CustomizationType.Plugin && item.uri === pluginUri);
		assert.ok(plugin);
		return plugin;
	}

	async function serverState(sessionUri: string, pluginUri: string): Promise<McpServerCustomization> {
		const plugin = await pluginState(sessionUri, pluginUri);
		const server = plugin.children?.find((child): child is McpServerCustomization => child.type === CustomizationType.McpServer);
		assert.ok(server);
		return server;
	}

	function probeResults(sessionUri: string): string[] {
		return context.client.receivedNotifications(n => isActionNotification(n, 'chat/toolCallComplete')).flatMap(notification => {
			const { channel, action } = getActionEnvelope(notification);
			return channel === buildDefaultChatUri(sessionUri) && action.type === ActionType.ChatToolCallComplete
				? [textFromContent(action.result.content ?? [])].filter(text => text.startsWith('MCP_PROBE:'))
				: [];
		});
	}

	test('runtime MCP: plugin tools remain callable after a built-in subagent', async function () {
		this.timeout(240_000);
		const { sessionUri, calls } = await createPluginSession();
		await driveTurnToCompletion(context.client, sessionUri, 'probe-before-child', 'Call runtime_probe exactly once with tag "before", then reply with its exact result.', 2);
		assert.deepStrictEqual(probeResults(sessionUri), ['MCP_PROBE:before']);
		await driveTurnToCompletion(context.client, sessionUri, 'builtin-child',
			'Call task exactly once with {"name":"probe-child","description":"Reply without tools","agent_type":"general-purpose","mode":"sync","prompt":"Reply exactly CHILD_READY. Do not call tools."}. After it finishes reply exactly PARENT_READY.', 10);
		assert.ok(context.client.receivedNotifications(n => isActionNotification(n, 'chat/toolCallStart')).some(notification => {
			const action = getActionEnvelope(notification).action;
			return action.type === ActionType.ChatToolCallStart && action.toolName === 'task';
		}));
		assert.ok(context.client.receivedNotifications(n => isActionNotification(n, 'chat/toolCallComplete')).some(notification => {
			const action = getActionEnvelope(notification).action;
			return action.type === ActionType.ChatToolCallComplete && textFromContent(action.result.content ?? []).includes('CHILD_READY');
		}));
		await driveTurnToCompletion(context.client, sessionUri, 'probe-after-child', 'Call runtime_probe exactly once with tag "after", then reply with its exact result.', 20);
		assert.deepStrictEqual({ results: probeResults(sessionUri), calls: readFileSync(calls, 'utf8') }, {
			results: ['MCP_PROBE:after'], calls: '"before"\n"after"\n',
		});
	});

	test('runtime MCP: tools execute after their server is stopped and restarted', async function () {
		this.timeout(180_000);
		const { sessionUri, pluginUri, calls } = await createPluginSession();
		await driveTurnToCompletion(context.client, sessionUri, 'probe-before-restart', 'Call runtime_probe exactly once with tag "before", then reply with its exact result.', 2);
		assert.deepStrictEqual(probeResults(sessionUri), ['MCP_PROBE:before']);
		const server = await serverState(sessionUri, pluginUri);
		context.client.dispatch({
			channel: sessionUri,
			clientSeq: 10,
			action: { type: ActionType.SessionMcpServerStopRequested, id: server.id },
		});
		await retry(async () => assert.strictEqual((await serverState(sessionUri, pluginUri)).state.kind, McpServerStatus.Stopped), 100, 100);
		context.client.dispatch({
			channel: sessionUri,
			clientSeq: 11,
			action: { type: ActionType.SessionMcpServerStartRequested, id: server.id },
		});
		await retry(async () => assert.strictEqual((await serverState(sessionUri, pluginUri)).state.kind, McpServerStatus.Ready), 100, 100);
		await driveTurnToCompletion(context.client, sessionUri, 'probe-after-restart', 'Call runtime_probe exactly once with tag "after", then reply with its exact result.', 20);
		assert.deepStrictEqual({ results: probeResults(sessionUri), calls: readFileSync(calls, 'utf8') }, {
			results: ['MCP_PROBE:after'], calls: '"before"\n"after"\n',
		});
	});

	test('runtime MCP: host plugin supporting files are readable without approval', async function () {
		this.timeout(180_000);
		const { sessionUri } = await createPluginSession();
		const result = await driveTurnToCompletion(context.client, sessionUri, 'plugin-reference',
			'Invoke the runtime-reference skill exactly once, follow its instructions to read the plugin reference file, then reply with its exact contents.', 2);
		assert.deepStrictEqual({ confirmation: result.sawPendingConfirmation, response: result.responseText.trim() }, {
			confirmation: false, response: 'HOST_PLUGIN_REFERENCE_OK',
		});
		assert.ok(context.client.receivedNotifications(n => isActionNotification(n, 'chat/toolCallComplete')).some(notification => {
			const action = getActionEnvelope(notification).action;
			return action.type === ActionType.ChatToolCallComplete && textFromContent(action.result.content ?? []) === 'HOST_PLUGIN_REFERENCE_OK';
		}));
	});
}
