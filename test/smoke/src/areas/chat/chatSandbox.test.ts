/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Application, Chat, Logger } from '../../../../automation';
import { dumpFailureDiagnostics, getCopilotSmokeTestEnv, getMockLlmServerPath, installAllHandlers, MockLlmServer, preseedChatExtensionEnablement } from '../../utils';

const WARMUP_SCENARIO_ID = 'smoke-chat-sandbox-warmup';
const WARMUP_REPLY = 'MOCKED_CHAT_SANDBOX_WARMUP';
const EXECUTION_SCENARIO_ID = 'smoke-chat-sandbox-execution';
const FILESYSTEM_SCENARIO_ID = 'smoke-chat-sandbox-filesystem';
const OUTSIDE_READ_SCENARIO_ID = 'smoke-chat-sandbox-outside-read';
const TMPDIR_SCENARIO_ID = 'smoke-chat-sandbox-tmpdir';
const NETWORK_DENY_SCENARIO_ID = 'smoke-chat-sandbox-network-deny';

function quoteShellArgument(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function terminalScenario(command: string) {
	return {
		type: 'multi-turn',
		turns: [
			{
				kind: 'tool-calls',
				toolCalls: [
					{
						toolNamePattern: /run.?in.?terminal|execute.?command/i,
						arguments: {
							command,
							explanation: 'Verify chat terminal sandbox isolation',
							goal: 'Run the chat sandbox smoke probe',
							mode: 'sync',
							timeout: 30_000,
						},
					},
				],
			},
			{ kind: 'echo-last-message' },
		],
	};
}

async function warmUpChat(chat: Chat, logger: Logger): Promise<void> {
	const deadline = Date.now() + 180_000;
	let attempt = 0;
	let lastError: unknown;

	while (Date.now() < deadline) {
		attempt++;
		try {
			await chat.sendMessage(`warm up [scenario:${WARMUP_SCENARIO_ID}]`);
			await chat.waitForResponseText(WARMUP_REPLY, 25_000);
			logger.log(`[Chat Sandbox] warm-up succeeded on attempt ${attempt}`);
			return;
		} catch (error) {
			lastError = error;
			logger.log(`[Chat Sandbox] warm-up attempt ${attempt} not ready yet; retrying`);
		}
	}

	throw new Error(`Chat did not become ready for the sandbox probe. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function runTerminalScenario(app: Application, mockServer: MockLlmServer, logger: Logger, scenarioId: string, resultMarker: string): Promise<string> {
	const requestsBefore = mockServer.requestCount();
	await app.workbench.chat.sendMessage(`Run the terminal sandbox probe [scenario:${scenarioId}]`);
	const responseText = await app.workbench.chat.waitForResponseText(new RegExp(`"output":[\\s\\S]*${resultMarker}`), 120_000);
	logger.log(`[Chat Sandbox/${scenarioId}] probe response: ${responseText}`);
	assert.ok(mockServer.requestCount() > requestsBefore, `expected the mock LLM server to receive scenario ${scenarioId}`);
	return responseText;
}

export function setup(logger: Logger): void {
	if (process.platform !== 'darwin' && process.platform !== 'linux') {
		return;
	}

	describe(`Chat Sandbox (${process.platform})`, function () {
		this.timeout(5 * 60 * 1000);
		this.retries(0);

		let mockServer: MockLlmServer;
		let networkServer: http.Server | undefined;
		let networkRequestCount = 0;
		let outsideDirectory: string;
		let outsideFile: string;
		let workspaceFileName: string;
		let token: string;
		let executionMarker: string;
		let filesystemMarker: string;
		let outsideReadMarker: string;
		let tmpdirMarker: string;
		let networkDenyMarker: string;

		before(async function () {
			const { startServer, ScenarioBuilder, registerScenario } = require(getMockLlmServerPath());

			const uniqueId = `${process.platform}-${process.pid}-${Date.now()}`;
			token = `CHAT_SANDBOX_TOKEN_${uniqueId}`;
			executionMarker = `CHAT_SANDBOX_EXECUTION_${uniqueId}`;
			filesystemMarker = `CHAT_SANDBOX_FILESYSTEM_${uniqueId}`;
			outsideReadMarker = `CHAT_SANDBOX_OUTSIDE_READ_${uniqueId}`;
			tmpdirMarker = `CHAT_SANDBOX_TMPDIR_${uniqueId}`;
			networkDenyMarker = `CHAT_SANDBOX_NETWORK_DENY_${uniqueId}`;
			workspaceFileName = `.chat-sandbox-smoke-${uniqueId}.txt`;
			outsideDirectory = fs.mkdtempSync(path.join(os.homedir(), '.vscode-chat-sandbox-smoke-'));
			outsideFile = path.join(outsideDirectory, 'blocked.txt');

			// Prove the target is writable without the sandbox. The actual probe
			// must then fail solely because chat.agent.sandbox.enabled is on.
			const baselineFile = path.join(outsideDirectory, 'baseline.txt');
			fs.writeFileSync(baselineFile, 'host-write-ok');
			assert.strictEqual(fs.readFileSync(baselineFile, 'utf8'), 'host-write-ok');
			fs.unlinkSync(baselineFile);

			networkServer = http.createServer((_request, response) => {
				networkRequestCount++;
				response.writeHead(200, { 'Content-Type': 'text/plain' });
				response.end('host-network-reachable');
			});
			await new Promise<void>((resolve, reject) => {
				networkServer!.once('error', reject);
				networkServer!.listen(0, '127.0.0.1', resolve);
			});
			const networkAddress = networkServer.address();
			assert.ok(networkAddress && typeof networkAddress !== 'string', 'expected the network probe server to listen on a TCP port');

			const filesystemCommand = [
				`workspace_file=${quoteShellArgument(workspaceFileName)}`,
				`outside_file=${quoteShellArgument(outsideFile)}`,
				`token=${quoteShellArgument(token)}`,
				'if printf \'%s\' "$token" > "$workspace_file"; then workspace_status=ALLOWED; else workspace_status=BLOCKED; fi',
				'if { printf \'%s\' "$token" > "$outside_file"; } 2>/dev/null; then outside_status=ALLOWED; else outside_status=BLOCKED; fi',
				`printf '%s workspace=%s outside=%s\\n' ${quoteShellArgument(filesystemMarker)} "$workspace_status" "$outside_status"`,
			].join('\n');
			const outsideReadCommand = [
				'if test -r /etc/shells && head -n 1 /etc/shells >/dev/null; then read_status=ALLOWED; else read_status=BLOCKED; fi',
				`printf '%s read=%s\\n' ${quoteShellArgument(outsideReadMarker)} "$read_status"`,
			].join('\n');
			const tmpdirCommand = [
				`tmp_file="$TMPDIR/${tmpdirMarker}.txt"`,
				`if printf '%s' ${quoteShellArgument(token)} > "$tmp_file" && test "$(cat "$tmp_file")" = ${quoteShellArgument(token)}; then tmpdir_status=WRITABLE; else tmpdir_status=BLOCKED; fi`,
				'rm -f "$tmp_file"',
				`printf '%s tmpdir=%s\\n' ${quoteShellArgument(tmpdirMarker)} "$tmpdir_status"`,
			].join('\n');
			const networkDenyCommand = [
				`probe_url=${quoteShellArgument(`http://127.0.0.1:${networkAddress.port}/chat-sandbox-network-probe`)}`,
				'if curl --silent --show-error --connect-timeout 3 --max-time 5 --noproxy \'*\' "$probe_url" >/dev/null 2>&1; then network_status=ALLOWED; else network_status=BLOCKED; fi',
				`printf '%s network=%s\\n' ${quoteShellArgument(networkDenyMarker)} "$network_status"`,
			].join('\n');

			registerScenario('text-only', new ScenarioBuilder().emit('OK').build());
			registerScenario(WARMUP_SCENARIO_ID, new ScenarioBuilder().emit(WARMUP_REPLY).build());
			registerScenario(EXECUTION_SCENARIO_ID, terminalScenario(`printf '%s\\n' ${quoteShellArgument(executionMarker)}`));
			registerScenario(FILESYSTEM_SCENARIO_ID, terminalScenario(filesystemCommand));
			registerScenario(OUTSIDE_READ_SCENARIO_ID, terminalScenario(outsideReadCommand));
			registerScenario(TMPDIR_SCENARIO_ID, terminalScenario(tmpdirCommand));
			registerScenario(NETWORK_DENY_SCENARIO_ID, terminalScenario(networkDenyCommand));

			mockServer = await startServer(0, { logger: (message: string) => logger.log(`[mock-llm] ${message}`), verbose: true });
			logger.log(`[Chat Sandbox] mock LLM server started at ${mockServer.url}; platform=${process.platform}`);
		});

		installAllHandlers(logger, opts => ({
			...opts,
			extraEnv: {
				...(opts.extraEnv ?? {}),
				...getCopilotSmokeTestEnv(mockServer),
			},
		}), app => preseedChatExtensionEnablement(app.userDataPath));

		before(async function () {
			const app = this.app as Application;
			await app.workbench.settingsEditor.addUserSettings([
				['github.copilot.advanced.debug.overrideProxyUrl', JSON.stringify(mockServer.url)],
				['github.copilot.advanced.debug.overrideCapiUrl', JSON.stringify(mockServer.url)],
				['github.copilot.advanced.debug.overrideAuthType', '"token"'],
				['chat.allowAnonymousAccess', 'true'],
				['github.copilot.chat.githubMcpServer.enabled', 'false'],
				['chat.mcp.discovery.enabled', 'false'],
				['chat.mcp.enabled', 'false'],
				['chat.disableAIFeatures', 'false'],
				['chat.agent.sandbox.enabled', '"on"'],
				// Pin the default-deny behavior and prevent a failed probe from being
				// retried with relaxed network access or outside the sandbox.
				['chat.agent.sandbox.allowNetwork', 'false'],
				['chat.agent.sandbox.retryWithAllowNetworkRequests', 'false'],
				['chat.agent.sandbox.allowUnsandboxedCommands', 'false'],
			]);
		});

		before(async function () {
			const app = this.app as Application;
			await app.workbench.quickaccess.runCommand('workbench.action.chat.open');
			await app.workbench.chat.waitForChatView();
			await warmUpChat(app.workbench.chat, logger);
		});

		after(async function () {
			const app = this.app as Application | undefined;
			if (app && workspaceFileName) {
				fs.rmSync(path.join(app.workspacePathOrFolder, workspaceFileName), { force: true });
			}
			if (outsideDirectory) {
				fs.rmSync(outsideDirectory, { recursive: true, force: true });
			}
			if (networkServer) {
				await new Promise<void>((resolve, reject) => networkServer!.close(error => error ? reject(error) : resolve()));
			}
			await mockServer?.close();
		});

		it('runs terminal commands inside the sandbox', async function () {
			const app = this.app as Application;

			try {
				const responseText = await runTerminalScenario(app, mockServer, logger, EXECUTION_SCENARIO_ID, executionMarker);
				assert.ok(responseText.includes(executionMarker), `expected terminal output to contain ${executionMarker}:\n${responseText}`);
			} catch (error) {
				logger.log(`[Chat Sandbox/execution] FAILURE: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
				await dumpFailureDiagnostics(app, logger, `Chat Sandbox (${process.platform}) execution`);
				throw error;
			}
		});

		it('allows workspace writes and blocks writes outside the workspace', async function () {
			const app = this.app as Application;
			const workspaceFile = path.join(app.workspacePathOrFolder, workspaceFileName);

			try {
				const responseText = await runTerminalScenario(app, mockServer, logger, FILESYSTEM_SCENARIO_ID, filesystemMarker);

				assert.strictEqual(
					fs.readFileSync(workspaceFile, 'utf8'),
					token,
					`expected chat.agent.sandbox.enabled to allow workspace writes on ${process.platform}`
				);
				assert.strictEqual(
					fs.existsSync(outsideFile),
					false,
					`expected chat.agent.sandbox.enabled to block writes outside the workspace on ${process.platform}`
				);
				assert.ok(responseText.includes(`${filesystemMarker} workspace=ALLOWED outside=BLOCKED`), `unexpected sandbox probe result:\n${responseText}`);
			} catch (error) {
				logger.log(`[Chat Sandbox] FAILURE: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
				await dumpFailureDiagnostics(app, logger, `Chat Sandbox (${process.platform})`);
				throw error;
			}
		});

		it('allows reads outside the workspace by default', async function () {
			const app = this.app as Application;

			try {
				const responseText = await runTerminalScenario(app, mockServer, logger, OUTSIDE_READ_SCENARIO_ID, outsideReadMarker);
				assert.ok(responseText.includes(`${outsideReadMarker} read=ALLOWED`), `unexpected outside-read probe result:\n${responseText}`);
			} catch (error) {
				logger.log(`[Chat Sandbox/outside-read] FAILURE: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
				await dumpFailureDiagnostics(app, logger, `Chat Sandbox (${process.platform}) outside read`);
				throw error;
			}
		});

		it('provides a writable sandbox temporary directory', async function () {
			const app = this.app as Application;

			try {
				const responseText = await runTerminalScenario(app, mockServer, logger, TMPDIR_SCENARIO_ID, tmpdirMarker);
				assert.ok(responseText.includes(`${tmpdirMarker} tmpdir=WRITABLE`), `unexpected TMPDIR probe result:\n${responseText}`);
			} catch (error) {
				logger.log(`[Chat Sandbox/tmpdir] FAILURE: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
				await dumpFailureDiagnostics(app, logger, `Chat Sandbox (${process.platform}) TMPDIR`);
				throw error;
			}
		});

		it('denies network access by default', async function () {
			const app = this.app as Application;
			const requestsBefore = networkRequestCount;

			try {
				const responseText = await runTerminalScenario(app, mockServer, logger, NETWORK_DENY_SCENARIO_ID, networkDenyMarker);
				assert.ok(responseText.includes(`${networkDenyMarker} network=BLOCKED`), `unexpected network probe result:\n${responseText}`);
				assert.strictEqual(
					networkRequestCount,
					requestsBefore,
					`expected chat.agent.sandbox.enabled to prevent the network probe from reaching the host server on ${process.platform}`
				);
			} catch (error) {
				logger.log(`[Chat Sandbox/network-deny] FAILURE: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
				await dumpFailureDiagnostics(app, logger, `Chat Sandbox (${process.platform}) network deny`);
				throw error;
			}
		});
	});
}
