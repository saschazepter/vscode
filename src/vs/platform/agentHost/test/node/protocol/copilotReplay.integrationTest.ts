/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Record/replay agent-host integration tests.
 *
 * These exercise the *entire* agent host end-to-end — real server, real bundled
 * Copilot SDK/CLI subprocess, real JSON-RPC/AHP protocol, real tool plumbing —
 * with only the CAPI model HTTP responses served by {@link CapiReplayProxy}.
 * Unlike {@link copilotRealSdk.integrationTest} they need no GitHub token and
 * are deterministic (no live model), so they are safe to run on every CLI/SDK
 * version bump.
 *
 * Modes (see `capiReplayProxy.ts`):
 *  - default (`auto`): replays the checked-in fixture when present, otherwise
 *    records one by proxying the in-repo mock LLM server. This makes the suite
 *    self-healing — a missing fixture records instead of failing.
 *  - `AGENT_HOST_REPLAY_RECORD=1`: force-record/refresh every fixture.
 *
 * To (re)generate fixtures after changing a test or bumping the CLI/SDK:
 *
 *   AGENT_HOST_REPLAY_RECORD=1 ./scripts/test-integration.sh --run \
 *     src/vs/platform/agentHost/test/node/protocol/copilotReplay.integrationTest.ts
 *
 * then review and commit the JSON under `captures/copilotReplay/`.
 */

import assert from 'assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { createRealSession, driveTurnToCompletion, IRealSdkProviderConfig } from './realSdkTestHelpers.js';
import { CapiReplayMode } from './capiReplayProxy.js';
import { IMockScenario, isActionNotification, IServerHandle, startRealServer, TestProtocolClient } from './testHelpers.js';

const COPILOT_CONFIG: IRealSdkProviderConfig = {
	suiteTitle: 'Protocol WebSocket — Copilot SDK (replay)',
	provider: 'copilotcli',
	scheme: 'copilotcli',
	shellToolName: 'bash',
	subagentToolNames: ['task'],
	exitPlanModeToolName: 'exit_plan_mode',
	enabled: true,
	supportsWorktreeIsolation: true,
	supportsSubagents: true,
	supportsPlanMode: true,
	// Replay/record runs against the mock LLM behind the proxy, so no real token.
	githubToken: 'not-a-real-token',
};

const RECORD = process.env['AGENT_HOST_REPLAY_RECORD'] === '1';
const REPLAY_MODE: CapiReplayMode = RECORD ? 'record' : 'auto';

/**
 * Scenario that scripts a single shell (`bash`) tool call followed by a short
 * final message. Registered on the mock only while recording; on replay the
 * captured tool-call wire is served from the fixture. Mirrors the smoke test's
 * proven bash tool-call shape.
 */
const BASH_TOOL_SCENARIO_ID = 'replay-bash-tool';
const BASH_TOOL_SCENARIO: IMockScenario = {
	id: BASH_TOOL_SCENARIO_ID,
	definition: {
		type: 'multi-turn',
		turns: [
			{
				kind: 'tool-calls',
				toolCalls: [{ toolNamePattern: /^(bash|pwsh|powershell)$/i, arguments: { command: 'echo REPLAY_TOOL_OK' } }],
			},
			{ kind: 'content', chunks: [{ content: 'Done.', delayMs: 0 }] },
		],
	},
};

/**
 * Fixtures live in the source tree so they can be committed and reviewed. The
 * compiled test runs from `out/` (dev) or `out-build/` (CI `--build`) — both at
 * the repo root — so resolve up to the root and back into `src/...`. This is
 * the same relative-to-root pattern `testHelpers.ts` uses to reach `scripts/`,
 * and is robust regardless of the output-directory name (unlike string-matching
 * `/out/`).
 */
const FIXTURES_DIR = fileURLToPath(new URL('../../../../../../../src/vs/platform/agentHost/test/node/protocol/captures/copilotReplay/', import.meta.url));

suite('Protocol WebSocket — Copilot SDK (record/replay)', function () {

	let server: IServerHandle | undefined;
	let client: TestProtocolClient | undefined;
	const createdSessions: string[] = [];
	const tempDirs: string[] = [];

	/**
	 * Start a fresh agent host wired to a per-test fixture, and connect a client.
	 * `workDir`/`homeDir` are isolated temp dirs so their absolute paths are
	 * normalized out of the recorded request bodies (keeping fixtures portable).
	 * `scenarios` are registered on the mock so a recording run can script model
	 * behavior (e.g. a tool call); they are unused when replaying a fixture.
	 */
	async function startForFixture(fixtureName: string, workDir: string, homeDir: string, scenarios?: readonly IMockScenario[]): Promise<TestProtocolClient> {
		server = await startRealServer({
			homeDir,
			capiReplay: { fixturePath: join(FIXTURES_DIR, `${fixtureName}.json`), mode: REPLAY_MODE, workDir },
			mockScenarios: scenarios,
		});
		client = new TestProtocolClient(server.port);
		await client.connect();
		return client;
	}

	/** Create an isolated temp workspace + home pair, tracked for cleanup. */
	async function makeWorkspace(prefix: string): Promise<{ workDir: string; homeDir: string }> {
		const workDir = await mkdtemp(`${tmpdir()}/${prefix}-work-`);
		const homeDir = await mkdtemp(`${tmpdir()}/${prefix}-home-`);
		tempDirs.push(workDir, homeDir);
		return { workDir, homeDir };
	}

	teardown(async function () {
		this.timeout(30_000);
		if (client) {
			for (const session of createdSessions) {
				try {
					await client.call('disposeSession', { session }, 5000);
				} catch { /* best-effort */ }
			}
			client.close();
			client = undefined;
		}
		createdSessions.length = 0;

		// Flush any recording and surface strict-mode cache misses before the
		// process (and its mock upstream) go away. Kill the process even if the
		// strict check throws, so a cache miss never leaks the server.
		try {
			await server?.capiReplay?.stop();
		} finally {
			server?.process.kill();
			server = undefined;
		}

		for (const dir of tempDirs) {
			try {
				await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
			} catch { /* best-effort */ }
		}
		tempDirs.length = 0;
	});

	test('replays a single deterministic turn', async function () {
		this.timeout(180_000);
		const { workDir, homeDir } = await makeWorkspace('agent-host-replay-single');
		const c = await startForFixture('single-turn', workDir, homeDir);

		const probe = 'REPLAY_PROBE_ALPHA';
		const sessionUri = await createRealSession(c, COPILOT_CONFIG, 'replay-single', createdSessions, URI.file(workDir));
		const result = await driveTurnToCompletion(c, sessionUri, 'turn-1', `Reply with exactly: ${probe}`, 1);

		assert.match(result.responseText, new RegExp(probe), `expected probe in assistant response; got: ${JSON.stringify(result.responseText)}`);
	});

	test('replays a multi-turn conversation in order', async function () {
		this.timeout(240_000);
		const { workDir, homeDir } = await makeWorkspace('agent-host-replay-multi');
		const c = await startForFixture('multi-turn', workDir, homeDir);

		const probe1 = 'REPLAY_PROBE_ONE';
		const probe2 = 'REPLAY_PROBE_TWO';
		const sessionUri = await createRealSession(c, COPILOT_CONFIG, 'replay-multi', createdSessions, URI.file(workDir));

		const first = await driveTurnToCompletion(c, sessionUri, 'turn-1', `Reply with exactly: ${probe1}`, 1);
		assert.match(first.responseText, new RegExp(probe1), `expected first probe; got: ${JSON.stringify(first.responseText)}`);

		const second = await driveTurnToCompletion(c, sessionUri, 'turn-2', `Reply with exactly: ${probe2}`, 2);
		assert.match(second.responseText, new RegExp(probe2), `expected second probe; got: ${JSON.stringify(second.responseText)}`);
	});

	test('a committed fixture is served without contacting the upstream model', async function () {
		this.timeout(180_000);
		const { workDir, homeDir } = await makeWorkspace('agent-host-replay-upstream');
		const c = await startForFixture('no-upstream', workDir, homeDir);

		const sessionUri = await createRealSession(c, COPILOT_CONFIG, 'replay-upstream', createdSessions, URI.file(workDir));
		await driveTurnToCompletion(c, sessionUri, 'turn-1', 'Reply with exactly: REPLAY_PROBE_UPSTREAM', 1);

		// The whole point of replay: when serving a committed fixture the proxy
		// never forwards, so the mock upstream sees zero requests. During a
		// recording run (no committed fixture yet) the mock is contacted, so
		// this invariant only holds while replaying.
		if (server?.capiReplay?.isReplaying) {
			assert.strictEqual(server.mockLlm?.requestCount() ?? 0, 0, 'replay must not contact the upstream mock');
		}
	});

	test('replays a scripted shell tool call', async function () {
		this.timeout(180_000);
		const { workDir, homeDir } = await makeWorkspace('agent-host-replay-tool');
		const c = await startForFixture('tool-call', workDir, homeDir, [BASH_TOOL_SCENARIO]);

		const sessionUri = await createRealSession(c, COPILOT_CONFIG, 'replay-tool', createdSessions, URI.file(workDir));

		// The scripted model turn calls the `bash` tool; `driveTurnToCompletion`
		// approves any permission request and drives the turn to the end (the
		// mock's instant follow-up turn keeps the two-call sequence deterministic
		// to replay). This exercises the SDK parsing a `tool_use` wire and
		// executing the tool end-to-end through the agent host — the behavior a
		// CLI/SDK bump is most likely to regress.
		await driveTurnToCompletion(c, sessionUri, 'turn-tool', `[scenario:${BASH_TOOL_SCENARIO_ID}] Run the shell command: echo REPLAY_TOOL_OK`, 1);

		const toolStarts = c.receivedNotifications(n => isActionNotification(n, 'chat/toolCallStart'));
		assert.ok(toolStarts.length > 0, 'expected the scripted bash tool call to start');
	});
});
