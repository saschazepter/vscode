/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../../../base/common/path.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { URI } from '../../../../../base/common/uri.js';
import { AgentSession } from '../../../common/agentService.js';
import type { INotificationBroadcastParams } from '../../../common/state/sessionProtocol.js';
import type { ISessionAddedNotification } from '../../../common/state/sessionActions.js';
import { PROTOCOL_VERSION } from '../../../common/state/sessionCapabilities.js';
import {
	dispatchTurnStarted,
	isActionNotification,
	type IServerHandle,
	TestProtocolClient,
} from './testHelpers.js';
import { startCopilotServer } from './copilotAgentCwdHelpers.js';

/**
 * Integration test that exercises the real CopilotAgent → Copilot SDK path.
 *
 * Verifies that the `workingDirectory` passed to `createSession` is correctly
 * forwarded to the SDK and appears in the `session.start` event in
 * `events.jsonl`.
 *
 * Requirements:
 *  - `gh auth` logged in (provides the GitHub token)
 *  - `node_modules` installed
 *
 * Run: scripts/test-integration.sh --run src/vs/platform/agentHost/test/node/protocol/copilotAgentCwd.integrationTest.ts
 */
suite('CopilotAgent — Working Directory (real SDK)', function () {

	let server: IServerHandle;
	let client: TestProtocolClient;
	let tmpDir: string;
	let ghToken: string;
	let sessionUri: string | undefined;
	let sdkSessionId: string | undefined;

	suiteSetup(async function () {
		this.timeout(30_000);

		// Obtain a GitHub token. Prefer GITHUB_OAUTH_TOKEN (used by CI and
		// the copilot extension's simulation tests), then fall back to the
		// local `gh` CLI.
		ghToken = process.env['GITHUB_OAUTH_TOKEN'] ?? '';
		if (!ghToken) {
			try {
				ghToken = execFileSync('gh', ['auth', 'token'], {
					encoding: 'utf-8',
					timeout: 5_000,
					stdio: 'pipe',
				}).trim();
			} catch {
				// Neither env var nor gh CLI available — skip the suite.
				return this.skip();
			}
		}

		// Start the agent host server with CopilotAgent (not --quiet, not --enable-mock-agent)
		server = await startCopilotServer();
	});

	suiteTeardown(function () {
		server?.process.kill();
	});

	setup(async function () {
		this.timeout(15_000);

		tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'copilot-cwd-test-'));
		client = new TestProtocolClient(server.port);
		await client.connect();

		// Handshake
		await client.call('initialize', { protocolVersion: PROTOCOL_VERSION, clientId: 'test-copilot-cwd' });

		// Authenticate with the real GitHub token so CopilotAgent can talk to the API
		await client.call('authenticate', {
			resource: 'https://api.github.com',
			token: ghToken,
		});
	});

	teardown(async function () {
		this.timeout(15_000);
		if (client && sessionUri) {
			try {
				await client.call('disposeSession', { session: sessionUri }, 10_000);
			} catch { /* best effort */ }
		}
		client?.close();
		sessionUri = undefined;
		// Clean up SDK session-state directory for this specific session
		if (sdkSessionId) {
			try {
				fs.rmSync(join(os.homedir(), '.copilot', 'session-state', sdkSessionId), { recursive: true, force: true });
			} catch { /* best effort */ }
			sdkSessionId = undefined;
		}
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch { /* best effort */ }
	});

	test('session.start event in events.jsonl reports the correct cwd', async function () {
		this.timeout(120_000);

		// 1. Create a session with a specific working directory
		const sessionId = generateUuid();
		const requestedSessionUri = AgentSession.uri('copilot', sessionId).toString();
		await client.call('createSession', {
			session: requestedSessionUri,
			provider: 'copilot',
			workingDirectory: URI.file(tmpDir).toString(),
		}, 60_000);

		// Wait for the sessionAdded notification to learn the real session URI
		const addedNotif = await client.waitForNotification(
			n => n.method === 'notification' &&
				(n.params as INotificationBroadcastParams).notification.type === 'notify/sessionAdded',
			15_000,
		);
		sessionUri = ((addedNotif.params as INotificationBroadcastParams).notification as ISessionAddedNotification).summary.resource;
		sdkSessionId = AgentSession.id(URI.parse(sessionUri));

		// 2. Set client tools (mimics what VS Code does before the first message).
		//    This populates the ActiveClient for the session, so the sendMessage
		//    path sees an outdated snapshot and recreates the SDK session.
		await client.call('subscribe', { resource: sessionUri }, 5_000);
		client.clearReceived();

		client.notify('dispatchAction', {
			clientSeq: 1,
			action: {
				type: 'session/activeClientChanged',
				session: sessionUri,
				activeClient: {
					clientId: 'test-copilot-cwd',
					tools: [{
						name: 'dummy_tool',
						description: 'A no-op tool for testing',
					}],
				},
			},
		});

		// Give the server time to process the activeClientChanged action
		await client.waitForNotification(
			n => isActionNotification(n, 'session/activeClientChanged'),
			5_000,
		);

		// 3. Send a trivial message by dispatching a turnStarted action.
		//    Because the active client was set after createSession, the
		//    sendMessage path detects an outdated snapshot, disposes the
		//    existing SDK session, and recreates it via _resumeSession.
		dispatchTurnStarted(client, sessionUri, 'turn-cwd-1', 'Respond with exactly: HELLO', 2);

		// Wait for the turn to complete (the real LLM processes the request)
		await client.waitForNotification(
			n => isActionNotification(n, 'session/turnComplete'),
			90_000,
		);

		// 4. Read the SDK's events.jsonl and verify the cwd in the session.start event
		const eventsPath = join(os.homedir(), '.copilot', 'session-state', sdkSessionId, 'events.jsonl');
		assert.ok(fs.existsSync(eventsPath), `events.jsonl should exist at: ${eventsPath}`);

		const lines = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n');
		const sessionStartLine = lines.find(line => line.includes('"session.start"'));
		assert.ok(sessionStartLine, 'events.jsonl should contain a session.start event');

		const sessionStartEvent = JSON.parse(sessionStartLine);
		assert.strictEqual(
			sessionStartEvent.data?.context?.cwd,
			tmpDir,
			`session.start cwd should match the requested workingDirectory`,
		);
	});
});
