/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../../base/common/path.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ActionType } from '../../../../common/state/sessionActions.js';
import { CompletionItemKind, type CompletionsResult, type ListSessionsResult, type SubscribeResult } from '../../../../common/state/protocol/commands.js';
import {
	buildChatUri,
	buildDefaultChatUri,
	isAhpChatChannel,
	MessageKind,
	parseRequiredSessionUriFromChatUri,
	ResponsePartKind,
	ROOT_STATE_URI,
	SessionStatus,
	type ChatState,
	type RootState,
	type SessionState,
} from '../../../../common/state/sessionState.js';
import { createRealSession } from '../harness/agentHostE2ETestHarness.js';
import { getActionEnvelope, isActionNotification } from '../../serverIntegrationTestHelpers.js';
import { hostOnlyTest, type IAgentHostE2ETestContext } from './e2eTestContext.js';

export function defineMultiChatTests(context: IAgentHostE2ETestContext): void {
	const { config, createdSessions, tempDirs } = context;

	async function createSession(prefix: string): Promise<{ sessionUri: string; defaultChatUri: string; workspace: string }> {
		const workspace = mkdtempSync(join(tmpdir(), `ahp-multichat-${prefix}-`));
		tempDirs.push(workspace);
		const sessionUri = await createRealSession(
			context.client,
			config,
			`${prefix}-${config.provider}`,
			createdSessions,
			URI.file(workspace),
		);
		return { sessionUri, defaultChatUri: buildDefaultChatUri(sessionUri), workspace };
	}

	async function createPeer(sessionUri: string, id: string, source?: { chat: string; turnId: string }): Promise<string> {
		const chat = buildChatUri(sessionUri, id);
		await context.client.call('createChat', {
			channel: sessionUri,
			chat,
			...(source ? { source } : {}),
		}, 30_000);
		return chat;
	}

	async function sessionState(sessionUri: string): Promise<SessionState> {
		const result = await context.client.call<SubscribeResult>('subscribe', { channel: sessionUri });
		return result.snapshot!.state as SessionState;
	}

	async function chatState(chatUri: string): Promise<ChatState> {
		const result = await context.client.call<SubscribeResult>('subscribe', { channel: chatUri });
		return result.snapshot!.state as ChatState;
	}

	async function rename(channel: string, title: string, clientSeq = 1): Promise<void> {
		context.client.clearReceived();
		context.client.dispatch({
			channel,
			clientSeq,
			action: { type: ActionType.SessionTitleChanged, title },
		});
		if (isAhpChatChannel(channel)) {
			const session = parseRequiredSessionUriFromChatUri(channel);
			await context.client.waitForNotification(n => {
				if (!isActionNotification(n, 'session/chatUpdated') || getActionEnvelope(n).channel !== session) {
					return false;
				}
				const action = getActionEnvelope(n).action as { chat: string; changes: { title?: string } };
				return action.chat === channel && action.changes.title === title;
			});
		} else {
			await context.client.waitForNotification(n =>
				isActionNotification(n, 'session/titleChanged')
				&& getActionEnvelope(n).channel === channel,
			);
		}
	}

	function providerTest(title: string, run: Mocha.AsyncFunc): void {
		(config.supportsMultipleChats ? test : test.skip)(title, function () {
			this.timeout(180_000);
			return run.call(this);
		});
	}

	interface IObservedModelMessage {
		readonly role: string;
		readonly content: string;
	}

	function observedModelMessages(body: string): readonly IObservedModelMessage[] {
		const request: unknown = JSON.parse(body);
		if (!isRecord(request) || !Array.isArray(request.messages)) {
			return [];
		}
		return request.messages.flatMap(message => {
			if (!isRecord(message) || typeof message.role !== 'string') {
				return [];
			}
			return [{ role: message.role, content: modelContentText(message.content) }];
		});
	}

	function modelContentText(value: unknown): string {
		if (typeof value === 'string') {
			return value;
		}
		if (Array.isArray(value)) {
			return value.map(modelContentText).join('');
		}
		if (isRecord(value)) {
			if (typeof value.text === 'string') {
				return value.text;
			}
			return modelContentText(value.content);
		}
		return '';
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null;
	}

	function forkProviderTest(title: string, run: Mocha.AsyncFunc): void {
		(config.supportsChatForkE2E ? test : test.skip)(title, function () {
			this.timeout(180_000);
			return run.call(this);
		});
	}

	async function driveTurn(chatUri: string, turnId: string, text: string, clientSeq: number): Promise<string> {
		context.client.clearReceived();
		context.client.dispatch({
			channel: chatUri,
			clientSeq,
			action: {
				type: ActionType.ChatTurnStarted,
				turnId,
				startedAt: '2025-01-01T00:00:00.000Z',
				message: { text, origin: { kind: MessageKind.User } },
			},
		});
		await context.client.waitForNotification(n =>
			isActionNotification(n, 'chat/turnComplete')
			&& getActionEnvelope(n).channel === chatUri
			&& (getActionEnvelope(n).action as { turnId: string }).turnId === turnId,
			90_000,
		);

		const markdownPartIds = new Set<string>();
		const pieces: string[] = [];
		for (const notification of context.client.receivedNotifications(n =>
			(isActionNotification(n, 'chat/responsePart') || isActionNotification(n, 'chat/delta'))
			&& getActionEnvelope(n).channel === chatUri
		)) {
			const action = getActionEnvelope(notification).action;
			if (action.type === ActionType.ChatResponsePart && action.part.kind === ResponsePartKind.Markdown) {
				markdownPartIds.add(action.part.id);
				pieces.push(action.part.content);
			} else if (action.type === ActionType.ChatDelta && markdownPartIds.has(action.partId)) {
				pieces.push(action.content);
			}
		}
		return pieces.join('');
	}

	hostOnlyTest(context, 'agent advertises its multiple chat capability', async function () {
		await createSession('capability');
		const root = await context.client.call<SubscribeResult>('subscribe', { channel: ROOT_STATE_URI });
		const agent = (root.snapshot!.state as RootState).agents.find(agent => agent.provider === config.provider);

		assert.deepStrictEqual({
			multipleChats: !!agent?.capabilities?.multipleChats,
			fork: agent?.capabilities?.multipleChats?.fork ?? false,
		}, {
			multipleChats: config.supportsMultipleChats,
			fork: config.supportsChatFork,
		});
	});

	hostOnlyTest(context, 'provider without multiple chat capability rejects peer creation', async function () {
		const { sessionUri } = await createSession('unsupported');

		await assert.rejects(
			() => createPeer(sessionUri, 'unsupported-peer'),
			/does not support multiple chats/i,
		);
	}, !config.supportsMultipleChats);

	hostOnlyTest(context, 'creating a peer chat adds it to the session catalog', async function () {
		const { sessionUri } = await createSession('catalog-add');
		const peer = await createPeer(sessionUri, 'peer');

		assert.ok((await sessionState(sessionUri)).chats.some(chat => chat.resource === peer));
	}, config.supportsMultipleChats);

	hostOnlyTest(context, 'peer chat subscription starts empty and idle', async function () {
		const { sessionUri } = await createSession('empty-peer');
		const peer = await createPeer(sessionUri, 'peer');

		const state = await chatState(peer);

		assert.deepStrictEqual({ turns: state.turns, activeTurn: state.activeTurn, status: state.status }, {
			turns: [],
			activeTurn: undefined,
			status: SessionStatus.Idle,
		});
	}, config.supportsMultipleChats);

	hostOnlyTest(context, 'creating the same peer chat twice is idempotent', async function () {
		const { sessionUri } = await createSession('idempotent');
		const peer = await createPeer(sessionUri, 'peer');

		await createPeer(sessionUri, 'peer');

		assert.strictEqual((await sessionState(sessionUri)).chats.filter(chat => chat.resource === peer).length, 1);
	}, config.supportsMultipleChats);

	hostOnlyTest(context, 'creating two peer chats preserves both catalog entries', async function () {
		const { sessionUri } = await createSession('two-peers');
		const first = await createPeer(sessionUri, 'first');
		const second = await createPeer(sessionUri, 'second');

		const peers = (await sessionState(sessionUri)).chats.map(chat => chat.resource);

		assert.ok(peers.includes(first) && peers.includes(second));
	}, config.supportsMultipleChats);

	hostOnlyTest(context, 'disposing a peer chat removes its catalog entry', async function () {
		const { sessionUri } = await createSession('dispose');
		const peer = await createPeer(sessionUri, 'peer');

		await context.client.call('disposeChat', { channel: peer }, 30_000);

		assert.strictEqual((await sessionState(sessionUri)).chats.some(chat => chat.resource === peer), false);
	}, config.supportsMultipleChats);

	hostOnlyTest(context, 'disposing one peer chat preserves its sibling', async function () {
		const { sessionUri } = await createSession('dispose-one');
		const first = await createPeer(sessionUri, 'first');
		const second = await createPeer(sessionUri, 'second');

		await context.client.call('disposeChat', { channel: first }, 30_000);

		const peers = (await sessionState(sessionUri)).chats.map(chat => chat.resource);
		assert.ok(!peers.includes(first) && peers.includes(second));
	}, config.supportsMultipleChats);

	hostOnlyTest(context, 'recreating a disposed peer chat starts empty', async function () {
		const { sessionUri } = await createSession('recreate');
		const peer = await createPeer(sessionUri, 'peer');
		await context.client.call('disposeChat', { channel: peer }, 30_000);

		await createPeer(sessionUri, 'peer');

		assert.deepStrictEqual((await chatState(peer)).turns, []);
	}, config.supportsMultipleChats);

	hostOnlyTest(context, 'renaming a peer chat updates its catalog title', async function () {
		const { sessionUri } = await createSession('rename-peer');
		const peer = await createPeer(sessionUri, 'peer');

		await rename(peer, 'Peer Title');

		assert.strictEqual((await sessionState(sessionUri)).chats.find(chat => chat.resource === peer)?.title, 'Peer Title');
	}, config.supportsMultipleChats);

	hostOnlyTest(context, 'renaming a peer chat leaves the session title unchanged', async function () {
		const { sessionUri } = await createSession('rename-isolated');
		await rename(sessionUri, 'Session Title');
		const peer = await createPeer(sessionUri, 'peer');

		await rename(peer, 'Peer Title', 2);

		assert.strictEqual((await sessionState(sessionUri)).title, 'Session Title');
	}, config.supportsMultipleChats);

	hostOnlyTest(context, 'peer chat survives unsubscribe and resubscribe', async function () {
		const { sessionUri } = await createSession('resubscribe');
		const peer = await createPeer(sessionUri, 'peer');
		await context.client.call<SubscribeResult>('subscribe', { channel: peer });

		context.client.notify('unsubscribe', { channel: peer });

		assert.strictEqual((await chatState(peer)).resource, peer);
	}, config.supportsMultipleChats);

	hostOnlyTest(context, 'peer creation does not leak a provider backing as a top-level session', async function () {
		const { sessionUri } = await createSession('session-list');
		const before = await context.client.call<ListSessionsResult>('listSessions', { channel: ROOT_STATE_URI });

		await createPeer(sessionUri, 'peer');

		const after = await context.client.call<ListSessionsResult>('listSessions', { channel: ROOT_STATE_URI });
		const beforeResources = new Set(before.items.map(item => item.resource));
		const unexpected = after.items
			.map(item => item.resource)
			.filter(resource => !beforeResources.has(resource) && resource !== sessionUri);

		assert.deepStrictEqual(unexpected, []);
	}, config.supportsMultipleChats);

	hostOnlyTest(context, 'peer file completion uses the parent workspace', async function () {
		const { sessionUri, workspace } = await createSession('completion');
		writeFileSync(join(workspace, 'peer-target.txt'), 'target');
		const peer = await createPeer(sessionUri, 'peer');

		const completions = await context.client.call<CompletionsResult>('completions', {
			channel: peer,
			kind: CompletionItemKind.UserMessage,
			text: '@peer-t',
			offset: '@peer-t'.length,
		});

		assert.deepStrictEqual(completions.items.map(item => item.insertText), ['@peer-target.txt']);
	}, config.supportsMultipleChats);

	hostOnlyTest(context, 'first peer chat snapshots the session title onto the default chat', async function () {
		const { sessionUri, defaultChatUri } = await createSession('default-title');
		await rename(sessionUri, 'Original Session');

		await createPeer(sessionUri, 'peer');

		assert.strictEqual((await sessionState(sessionUri)).chats.find(chat => chat.resource === defaultChatUri)?.title, 'Original Session');
	}, config.supportsMultipleChats);

	hostOnlyTest(context, 'session rename after peer creation preserves the default chat title', async function () {
		const { sessionUri, defaultChatUri } = await createSession('independent-title');
		await rename(sessionUri, 'Original Session');
		await createPeer(sessionUri, 'peer');

		await rename(sessionUri, 'Renamed Session', 2);

		assert.strictEqual((await sessionState(sessionUri)).chats.find(chat => chat.resource === defaultChatUri)?.title, 'Original Session');
	}, config.supportsMultipleChats);

	hostOnlyTest(context, 'forking an unknown turn creates a fresh empty peer chat', async function () {
		const { sessionUri, defaultChatUri } = await createSession('unknown-fork');

		const peer = await createPeer(sessionUri, 'fork', { chat: defaultChatUri, turnId: 'missing-turn' });

		assert.deepStrictEqual((await chatState(peer)).turns, []);
	}, config.supportsMultipleChats);

	providerTest('peer chat completes a simple turn', async function () {
		const { sessionUri } = await createSession('peer-turn');
		const peer = await createPeer(sessionUri, 'peer');
		await context.client.call<SubscribeResult>('subscribe', { channel: peer });

		const response = await driveTurn(peer, 'peer-turn', 'Reply exactly "PEER_OK".', 1);

		assert.match(response, /PEER_OK/);
	});

	providerTest('peer chat retains context across consecutive turns', async function () {
		const { sessionUri } = await createSession('peer-context');
		const peer = await createPeer(sessionUri, 'peer');
		await context.client.call<SubscribeResult>('subscribe', { channel: peer });

		const firstResponse = await driveTurn(peer, 'peer-context-1', 'Remember the code word PEAR. Reply exactly "ready".', 1);
		const response = await driveTurn(peer, 'peer-context-2', 'What code word did I ask you to remember? Reply with only the code word.', 2);
		const messages = observedModelMessages(context.observedModelRequestBodies.at(-1) ?? '');

		assert.deepStrictEqual({
			responseHasCodeWord: /PEAR/i.test(response),
			requestHasPriorUserMessage: messages.some(message => message.role === 'user' && message.content.includes('Remember the code word PEAR')),
			requestHasPriorAssistantMessage: messages.some(message => message.role === 'assistant' && message.content.includes(firstResponse.trim())),
		}, {
			responseHasCodeWord: true,
			requestHasPriorUserMessage: true,
			requestHasPriorAssistantMessage: true,
		});
	});

	forkProviderTest('forked peer chat inherits source history through the provider', async function () {
		const { sessionUri, defaultChatUri } = await createSession('fork-history');
		const sourceResponse = await driveTurn(defaultChatUri, 'fork-source', 'Remember the code word FORKCODE. Reply exactly "ready".', 1);

		const peer = await createPeer(sessionUri, 'fork', { chat: defaultChatUri, turnId: 'fork-source' });
		await context.client.call<SubscribeResult>('subscribe', { channel: peer });
		const response = await driveTurn(peer, 'fork-turn', 'What code word did I ask you to remember? Reply with only the code word.', 2);
		const messages = observedModelMessages(context.observedModelRequestBodies.at(-1) ?? '');

		assert.deepStrictEqual({
			seededMessages: (await chatState(peer)).turns.map(turn => turn.message.text),
			responseHasCodeWord: /FORKCODE/i.test(response),
			requestHasPriorUserMessage: messages.some(message => message.role === 'user' && message.content.includes('Remember the code word FORKCODE')),
			requestHasPriorAssistantMessage: messages.some(message => message.role === 'assistant' && message.content.includes(sourceResponse.trim())),
		}, {
			seededMessages: [
				'Remember the code word FORKCODE. Reply exactly "ready".',
				'What code word did I ask you to remember? Reply with only the code word.',
			],
			responseHasCodeWord: true,
			requestHasPriorUserMessage: true,
			requestHasPriorAssistantMessage: true,
		});
	});

	providerTest('disposing a peer after a completed turn removes it from the catalog', async function () {
		const { sessionUri } = await createSession('dispose-after-turn');
		const peer = await createPeer(sessionUri, 'peer');
		await context.client.call<SubscribeResult>('subscribe', { channel: peer });
		await driveTurn(peer, 'peer-turn', 'Reply exactly "DONE".', 1);

		await context.client.call('disposeChat', { channel: peer }, 30_000);

		assert.strictEqual((await sessionState(sessionUri)).chats.some(chat => chat.resource === peer), false);
	});
}
