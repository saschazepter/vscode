/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import type { IAgentCreateSessionConfig, IAgentModelInfo, IAgentSessionMetadata } from '../../common/agentService.js';
import { SessionStatus } from '../../common/state/protocol/channels-session/state.js';
import { buildDefaultChatUri } from '../../common/state/sessionState.js';
import { AgentHostStateManager } from '../../node/agentHostStateManager.js';
import {
	applyCreateChatTool,
	applyDeleteSessionTool,
	createChatToolName,
	createSessionServerToolGroup,
	createSessionToolName,
	deleteSessionToolName,
	getCreateChatArgs,
	getCreateSessionArgs,
	getCurrentSessionToolName,
	getDeleteSessionArgs,
	listSessionsToolName,
	sessionServerToolDefinitions,
	sessionToolRequiresConfirmation,
	serializeSessions,
	type ISessionServerToolAccessor,
} from '../../node/shared/sessionServerTools.js';

suite('SessionServerTools', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const workspace = URI.parse('file:///workspace/app');
	const model: IAgentModelInfo = { provider: 'copilot', id: 'gpt-4o', name: 'GPT-4o', supportsVision: false };

	function sessionMeta(id: string, status: SessionStatus, dir: URI): IAgentSessionMetadata {
		return { session: URI.parse(`copilot:/${id}`), startTime: 0, modifiedTime: 0, status, workingDirectory: dir, summary: `title-${id}` };
	}

	function createAccessor(overrides?: Partial<ISessionServerToolAccessor> & { onCreate?: (config: IAgentCreateSessionConfig) => void; onPrompt?: (session: URI, chat: URI, prompt: string) => void; onCreateChat?: (session: URI, chat: URI, title?: string) => void; onDelete?: (session: URI) => void }): ISessionServerToolAccessor {
		return {
			listSessions: overrides?.listSessions ?? (async () => [sessionMeta('s1', SessionStatus.InProgress, workspace)]),
			createSession: overrides?.createSession ?? (async config => { overrides?.onCreate?.(config); return URI.parse('copilot:/new'); }),
			getModels: overrides?.getModels ?? (() => [model]),
			startPrompt: overrides?.startPrompt ?? (async (session, chat, prompt) => { overrides?.onPrompt?.(session, chat, prompt); }),
			createChat: overrides?.createChat ?? (async (session, chat, title) => { overrides?.onCreateChat?.(session, chat, title); }),
			deleteSession: overrides?.deleteSession ?? (async session => { overrides?.onDelete?.(session); }),
		};
	}

	test('definitions and confirmation', () => {
		assert.deepStrictEqual(sessionServerToolDefinitions.map(d => d.name), [listSessionsToolName, getCurrentSessionToolName, createSessionToolName, createChatToolName, deleteSessionToolName]);
		assert.strictEqual(sessionToolRequiresConfirmation(createSessionToolName), true);
		assert.strictEqual(sessionToolRequiresConfirmation(createChatToolName), true);
		assert.strictEqual(sessionToolRequiresConfirmation(deleteSessionToolName), true);
		assert.strictEqual(sessionToolRequiresConfirmation(listSessionsToolName), false);
		assert.strictEqual(sessionToolRequiresConfirmation(getCurrentSessionToolName), false);
	});

	test('serializeSessions produces compact metadata', () => {
		const text = serializeSessions([sessionMeta('s1', SessionStatus.InputNeeded, workspace)]);
		assert.deepStrictEqual(JSON.parse(text), {
			sessions: [{
				session: 'copilot:/s1',
				status: 'inputNeeded',
				workingDirectory: workspace.toString(),
				title: 'title-s1',
			}],
		});
	});

	test('getCreateSessionArgs resolves workspace by working directory and model by id/name', () => {
		const sessions = [sessionMeta('s1', SessionStatus.Idle, workspace)];
		const byId = getCreateSessionArgs({ workspace: workspace.toString(), prompt: 'hi', model: 'gpt-4o' }, sessions, [model]);
		assert.strictEqual(byId.workspace.toString(), workspace.toString());
		assert.strictEqual(byId.model?.id, 'gpt-4o');
		const byName = getCreateSessionArgs({ workspace: workspace.toString(), prompt: 'hi', model: 'GPT-4o' }, sessions, [model]);
		assert.strictEqual(byName.model?.name, 'GPT-4o');
	});

	test('getCreateSessionArgs accepts an absolute filesystem path as workspace', () => {
		const resolved = getCreateSessionArgs({ workspace: '/Users/me/work/repo', prompt: 'hi' }, [], []);
		assert.strictEqual(resolved.workspace.scheme, 'file');
		assert.strictEqual(resolved.workspace.fsPath, '/Users/me/work/repo');
	});

	test('getCreateSessionArgs throws on invalid input', () => {
		assert.throws(() => getCreateSessionArgs({ workspace: 'not a uri', prompt: 'hi' }, [], []), /workspace/);
		assert.throws(() => getCreateSessionArgs({ workspace: workspace.toString(), prompt: 'hi', model: 'nope' }, [], [model]), /model/);
		assert.throws(() => getCreateSessionArgs({ workspace: workspace.toString() }, [], []), /prompt/);
	});

	test('create_session builds config, starts the default chat, and returns an open link', async () => {
		const store = new DisposableStore();
		const stateManager = store.add(new AgentHostStateManager(new NullLogService()));
		let created: IAgentCreateSessionConfig | undefined;
		let prompted: { chat: URI; prompt: string } | undefined;
		const accessor = createAccessor({ onCreate: c => { created = c; }, onPrompt: (_s, chat, prompt) => { prompted = { chat, prompt }; } });
		const group = createSessionServerToolGroup(accessor);

		const text = await group.execute(stateManager, 'copilot:/caller', createSessionToolName, { workspace: workspace.toString(), prompt: 'do it', model: 'gpt-4o' });

		assert.deepStrictEqual(created, { workingDirectory: workspace, provider: 'copilot', model: { id: 'gpt-4o' } });
		assert.strictEqual(prompted?.prompt, 'do it');
		assert.strictEqual(prompted?.chat.toString(), buildDefaultChatUri(URI.parse('copilot:/new')));
		assert.ok(text.includes('agent-host-session://copilot/new'), 'result carries the open-session link for the pill');
		assert.ok(!text.includes('copilot:/new'), 'result does not echo the raw backend session URI');
		store.dispose();
	});

	test('list_sessions execute returns serialized sessions', async () => {
		const store = new DisposableStore();
		const stateManager = store.add(new AgentHostStateManager(new NullLogService()));
		const group = createSessionServerToolGroup(createAccessor());
		const text = await group.execute(stateManager, 'copilot:/caller', listSessionsToolName, {});
		assert.deepStrictEqual(JSON.parse(text).sessions.map((s: { session: string }) => s.session), ['copilot:/s1']);
		store.dispose();
	});

	test('create_session enforces a recursion cap', async () => {
		const store = new DisposableStore();
		const stateManager = store.add(new AgentHostStateManager(new NullLogService()));
		const group = createSessionServerToolGroup(createAccessor());
		const args = { workspace: workspace.toString(), prompt: 'go' };
		for (let i = 0; i < 5; i++) {
			await group.execute(stateManager, 'copilot:/caller', createSessionToolName, args);
		}
		await assert.rejects(async () => { await group.execute(stateManager, 'copilot:/caller', createSessionToolName, args); }, /more than 5 sessions/);
		store.dispose();
	});

	test('getCreateChatArgs resolves an explicit session, falls back to current, and validates', () => {
		const sessions = [sessionMeta('s1', SessionStatus.Idle, workspace)];
		const explicit = getCreateChatArgs({ session: 'copilot:/s1', prompt: 'hi', title: 'My chat' }, sessions);
		assert.strictEqual(explicit.session.toString(), 'copilot:/s1');
		assert.strictEqual(explicit.title, 'My chat');
		const current = getCreateChatArgs({ prompt: 'hi' }, sessions, URI.parse('copilot:/s1'));
		assert.strictEqual(current.session.toString(), 'copilot:/s1');
		assert.throws(() => getCreateChatArgs({ session: 'copilot:/unknown', prompt: 'hi' }, sessions), /session/);
		assert.throws(() => getCreateChatArgs({ prompt: 'hi' }, sessions), /session/);
	});

	test('create_chat adds a chat to the session, starts the prompt, and returns an open link', async () => {
		let createdChat: { session: URI; chat: URI; title?: string } | undefined;
		let prompted: { session: URI; chat: URI; prompt: string } | undefined;
		const accessor = createAccessor({
			listSessions: async () => [sessionMeta('s1', SessionStatus.Idle, workspace)],
			onCreateChat: (session, chat, title) => { createdChat = { session, chat, title }; },
			onPrompt: (session, chat, prompt) => { prompted = { session, chat, prompt }; },
		});
		const result = await applyCreateChatTool(accessor, { session: 'copilot:/s1', prompt: 'do it', title: 'T' });
		assert.strictEqual(result.session, 'copilot:/s1');
		assert.strictEqual(result.openLink, 'agent-host-session://copilot/s1');
		assert.strictEqual(createdChat?.session.toString(), 'copilot:/s1');
		assert.strictEqual(createdChat?.title, 'T');
		assert.strictEqual(createdChat?.chat.toString(), result.chat);
		assert.strictEqual(prompted?.chat.toString(), result.chat);
		assert.strictEqual(prompted?.prompt, 'do it');
	});

	test('get_current_session returns the current session link + metadata', async () => {
		const store = new DisposableStore();
		const stateManager = store.add(new AgentHostStateManager(new NullLogService()));
		const group = createSessionServerToolGroup(createAccessor({ listSessions: async () => [sessionMeta('s1', SessionStatus.Idle, workspace)] }));
		// Tool call runs on the session's default chat channel; the tool resolves the owning session.
		const chatChannel = buildDefaultChatUri('copilot:/s1');
		const text = await group.execute(stateManager, chatChannel, getCurrentSessionToolName, {});
		const parsed = JSON.parse(text);
		assert.strictEqual(parsed.session, 'copilot:/s1');
		assert.strictEqual(parsed.openLink, 'agent-host-session://copilot/s1');
		store.dispose();
	});

	test('getDeleteSessionArgs validates and refuses the current session', () => {
		const sessions = [sessionMeta('s1', SessionStatus.Idle, workspace), sessionMeta('s2', SessionStatus.Idle, workspace)];
		assert.strictEqual(getDeleteSessionArgs({ session: 'copilot:/s2' }, sessions).toString(), 'copilot:/s2');
		assert.throws(() => getDeleteSessionArgs({ session: 'copilot:/unknown' }, sessions), /session/);
		assert.throws(() => getDeleteSessionArgs({}, sessions), /session/);
		assert.throws(() => getDeleteSessionArgs({ session: 'copilot:/s1' }, sessions, URI.parse('copilot:/s1')), /current session/);
	});

	test('delete_session deletes the target and returns a confirmation', async () => {
		let deleted: URI | undefined;
		const accessor = createAccessor({
			listSessions: async () => [sessionMeta('s1', SessionStatus.Idle, workspace), sessionMeta('s2', SessionStatus.Idle, workspace)],
			onDelete: session => { deleted = session; },
		});
		const text = await applyDeleteSessionTool(accessor, { session: 'copilot:/s2' }, URI.parse('copilot:/s1'));
		assert.strictEqual(deleted?.toString(), 'copilot:/s2');
		assert.ok(text.includes('copilot:/s2'));
	});
});
