/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { IAgentHostService, IAgentMessageEvent, IAgentProgressEvent, IAgentSessionMetadata } from '../../../../../../platform/agent/common/agentService.js';
import { IDefaultAccountService } from '../../../../../../platform/defaultAccount/common/defaultAccount.js';
import { IAuthenticationService } from '../../../../../services/authentication/common/authentication.js';
import { IChatAgentData, IChatAgentImplementation, IChatAgentRequest, IChatAgentService } from '../../../common/participants/chatAgents.js';
import { ChatAgentLocation } from '../../../common/constants.js';
import { IChatMarkdownContent, IChatProgress, IChatToolInvocation } from '../../../common/chatService/chatService.js';
import { IChatSessionsService, IChatSessionContentProvider, IChatSessionItemController } from '../../../common/chatSessionsService.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { AgentHostChatContribution, AgentHostSessionListController, AgentHostSessionHandler } from '../../../browser/agentSessions/agentHostChatContribution.js';

// ---- Mock agent host service ------------------------------------------------

class MockAgentHostService extends mock<IAgentHostService>() {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidSessionProgress = new Emitter<IAgentProgressEvent>();
	override readonly onDidSessionProgress = this._onDidSessionProgress.event;
	override readonly onAgentHostExit = Event.None;
	override readonly onAgentHostStart = Event.None;

	private _nextId = 1;
	private readonly _sessions = new Map<string, IAgentSessionMetadata>();
	private readonly _sessionMessages = new Map<string, IAgentMessageEvent[]>();
	public sendMessageCalls: { sessionId: string; prompt: string }[] = [];

	override async setAuthToken(_token: string): Promise<void> { }

	override async listSessions(): Promise<IAgentSessionMetadata[]> {
		return [...this._sessions.values()];
	}

	override async createSession(): Promise<string> {
		const id = `sdk-session-${this._nextId++}`;
		this._sessions.set(id, { sessionId: id, startTime: Date.now(), modifiedTime: Date.now() });
		return id;
	}

	override async sendMessage(sessionId: string, prompt: string): Promise<void> {
		this.sendMessageCalls.push({ sessionId, prompt });
	}

	override async getSessionMessages(sessionId: string): Promise<IAgentMessageEvent[]> {
		return this._sessionMessages.get(sessionId) ?? [];
	}

	override async disposeSession(_sessionId: string): Promise<void> { }
	override async shutdown(): Promise<void> { }
	override async restartAgentHost(): Promise<void> { }

	// Test helpers
	fireProgress(event: IAgentProgressEvent): void {
		this._onDidSessionProgress.fire(event);
	}

	setSessionMessages(sessionId: string, messages: IAgentMessageEvent[]): void {
		this._sessionMessages.set(sessionId, messages);
	}

	addSession(meta: IAgentSessionMetadata): void {
		this._sessions.set(meta.sessionId, meta);
	}

	dispose(): void {
		this._onDidSessionProgress.dispose();
	}
}

// ---- Minimal service mocks --------------------------------------------------

class MockChatSessionsService extends mock<IChatSessionsService>() {
	declare readonly _serviceBrand: undefined;

	registeredControllers = new Map<string, IChatSessionItemController>();
	registeredContentProviders = new Map<string, IChatSessionContentProvider>();

	override registerChatSessionItemController(type: string, controller: IChatSessionItemController) {
		this.registeredControllers.set(type, controller);
		return toDisposable(() => this.registeredControllers.delete(type));
	}

	override registerChatSessionContentProvider(scheme: string, provider: IChatSessionContentProvider) {
		this.registeredContentProviders.set(scheme, provider);
		return toDisposable(() => this.registeredContentProviders.delete(scheme));
	}
}

class MockChatAgentService extends mock<IChatAgentService>() {
	declare readonly _serviceBrand: undefined;

	registeredAgents = new Map<string, { data: IChatAgentData; impl: IChatAgentImplementation }>();

	override registerDynamicAgent(data: IChatAgentData, agentImpl: IChatAgentImplementation) {
		this.registeredAgents.set(data.id, { data, impl: agentImpl });
		return toDisposable(() => this.registeredAgents.delete(data.id));
	}
}

class MockDefaultAccountService extends mock<IDefaultAccountService>() {
	declare readonly _serviceBrand: undefined;

	override readonly onDidChangeDefaultAccount = Event.None;

	override async getDefaultAccount() {
		return null;
	}
}

class MockAuthenticationService extends mock<IAuthenticationService>() {
	declare readonly _serviceBrand: undefined;

	override readonly onDidChangeSessions = Event.None;
}

class MockProductService extends mock<IProductService>() {
	declare readonly _serviceBrand: undefined;
	override readonly quality: string = 'insider';
}

// ---- Helpers ----------------------------------------------------------------

function createContribution(disposables: DisposableStore) {
	const agentHostService = new MockAgentHostService();
	disposables.add(toDisposable(() => agentHostService.dispose()));

	const chatSessionsService = new MockChatSessionsService();
	const chatAgentService = new MockChatAgentService();
	const productService = new MockProductService() as unknown as IProductService;

	const listController = disposables.add(new AgentHostSessionListController(
		agentHostService as unknown as IAgentHostService,
		productService,
	));

	const sessionHandler = disposables.add(new AgentHostSessionHandler(
		agentHostService as unknown as IAgentHostService,
		chatAgentService as unknown as IChatAgentService,
		new NullLogService(),
		productService,
	));

	const contribution = disposables.add(new AgentHostChatContribution(
		agentHostService as unknown as IAgentHostService,
		chatSessionsService as unknown as IChatSessionsService,
		chatAgentService as unknown as IChatAgentService,
		new MockDefaultAccountService() as unknown as IDefaultAccountService,
		new MockAuthenticationService() as unknown as IAuthenticationService,
		new NullLogService(),
		productService,
	));

	return { contribution, listController, sessionHandler, agentHostService, chatSessionsService, chatAgentService };
}

function makeRequest(overrides: Partial<{ message: string; sessionResource: URI }> = {}): IChatAgentRequest {
	return upcastPartial<IChatAgentRequest>({
		sessionResource: overrides.sessionResource ?? URI.from({ scheme: 'untitled', path: '/chat-1' }),
		requestId: 'req-1',
		agentId: 'agent-host',
		message: overrides.message ?? 'Hello',
		variables: { variables: [] },
		location: ChatAgentLocation.Chat,
	});
}

suite('AgentHostChatContribution', () => {

	const disposables = new DisposableStore();

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	// ---- Registration ---------------------------------------------------

	suite('registration', () => {

		test('registers session item controller, content provider, and agent', () => {
			const { chatSessionsService, chatAgentService } = createContribution(disposables);

			assert.ok(chatSessionsService.registeredControllers.has('agent-host'));
			assert.ok(chatSessionsService.registeredContentProviders.has('agent-host'));
			assert.ok(chatAgentService.registeredAgents.has('agent-host'));
		});
	});

	// ---- Session list (IChatSessionItemController) ----------------------

	suite('session list', () => {

		test('refresh populates items from agent host', async () => {
			const { listController, agentHostService } = createContribution(disposables);

			agentHostService.addSession({ sessionId: 'aaa', startTime: 1000, modifiedTime: 2000, summary: 'My session' });
			agentHostService.addSession({ sessionId: 'bbb', startTime: 3000, modifiedTime: 4000 });

			await listController.refresh(CancellationToken.None);

			assert.strictEqual(listController.items.length, 2);
			assert.strictEqual(listController.items[0].label, 'My session');
			assert.strictEqual(listController.items[1].label, 'Session bbb');
			assert.strictEqual(listController.items[0].resource.scheme, 'agent-host');
			assert.strictEqual(listController.items[0].resource.path, '/aaa');
		});

		test('refresh fires onDidChangeChatSessionItems', async () => {
			const { listController, agentHostService } = createContribution(disposables);

			let fired = false;
			disposables.add(listController.onDidChangeChatSessionItems(() => { fired = true; }));

			agentHostService.addSession({ sessionId: 'x', startTime: 1000, modifiedTime: 2000 });
			await listController.refresh(CancellationToken.None);

			assert.ok(fired);
		});

		test('refresh handles error gracefully', async () => {
			const { listController, agentHostService } = createContribution(disposables);

			agentHostService.listSessions = async () => { throw new Error('fail'); };

			await listController.refresh(CancellationToken.None);

			assert.strictEqual(listController.items.length, 0);
		});
	});

	// ---- Session ID resolution in _invokeAgent --------------------------

	suite('session ID resolution', () => {

		test('creates new SDK session for untitled resource', async () => {
			const { chatAgentService, agentHostService } = createContribution(disposables);

			const agent = chatAgentService.registeredAgents.get('agent-host')!;

			const origSend = agentHostService.sendMessage.bind(agentHostService);
			agentHostService.sendMessage = async (sessionId: string, prompt: string) => {
				await origSend(sessionId, prompt);
				agentHostService.fireProgress({ sessionId, type: 'idle' });
			};

			await agent.impl.invoke(
				makeRequest({ message: 'Hello' }),
				() => { }, [], CancellationToken.None,
			);

			assert.strictEqual(agentHostService.sendMessageCalls.length, 1);
			assert.strictEqual(agentHostService.sendMessageCalls[0].prompt, 'Hello');
			assert.ok(agentHostService.sendMessageCalls[0].sessionId.startsWith('sdk-session-'));
		});

		test('reuses SDK session for same resource on second message', async () => {
			const { chatAgentService, agentHostService } = createContribution(disposables);

			const agent = chatAgentService.registeredAgents.get('agent-host')!;
			const resource = URI.from({ scheme: 'untitled', path: '/chat-reuse' });

			agentHostService.sendMessage = async (sessionId: string, prompt: string) => {
				agentHostService.sendMessageCalls.push({ sessionId, prompt });
				agentHostService.fireProgress({ sessionId, type: 'idle' });
			};

			await agent.impl.invoke(
				makeRequest({ message: 'First', sessionResource: resource }),
				() => { }, [], CancellationToken.None,
			);

			await agent.impl.invoke(
				makeRequest({ message: 'Second', sessionResource: resource }),
				() => { }, [], CancellationToken.None,
			);

			assert.strictEqual(agentHostService.sendMessageCalls.length, 2);
			assert.strictEqual(agentHostService.sendMessageCalls[0].sessionId, agentHostService.sendMessageCalls[1].sessionId);
		});

		test('uses sessionId from agent-host scheme resource', async () => {
			const { chatAgentService, agentHostService } = createContribution(disposables);

			const agent = chatAgentService.registeredAgents.get('agent-host')!;
			const resource = URI.from({ scheme: 'agent-host', path: '/existing-session-42' });

			agentHostService.sendMessage = async (sessionId: string, prompt: string) => {
				agentHostService.sendMessageCalls.push({ sessionId, prompt });
				agentHostService.fireProgress({ sessionId, type: 'idle' });
			};

			await agent.impl.invoke(
				makeRequest({ message: 'Hi', sessionResource: resource }),
				() => { }, [], CancellationToken.None,
			);

			assert.strictEqual(agentHostService.sendMessageCalls[0].sessionId, 'existing-session-42');
		});

		test('agent-host scheme with untitled path creates new session via mapping', async () => {
			const { chatAgentService, agentHostService } = createContribution(disposables);

			const agent = chatAgentService.registeredAgents.get('agent-host')!;
			const resource = URI.from({ scheme: 'agent-host', path: '/untitled-abc123' });

			agentHostService.sendMessage = async (sessionId: string, prompt: string) => {
				agentHostService.sendMessageCalls.push({ sessionId, prompt });
				agentHostService.fireProgress({ sessionId, type: 'idle' });
			};

			await agent.impl.invoke(
				makeRequest({ message: 'Hi', sessionResource: resource }),
				() => { }, [], CancellationToken.None,
			);

			// Should create a new SDK session, not use "untitled-abc123" literally
			assert.ok(agentHostService.sendMessageCalls[0].sessionId.startsWith('sdk-session-'));
		});
	});

	// ---- Progress event → chat progress conversion ----------------------

	suite('progress routing', () => {

		test('delta events become markdownContent progress', async () => {
			const { chatAgentService, agentHostService } = createContribution(disposables);

			const agent = chatAgentService.registeredAgents.get('agent-host')!;
			const collected: IChatProgress[][] = [];

			agentHostService.sendMessage = async (sessionId: string) => {
				agentHostService.sendMessageCalls.push({ sessionId, prompt: '' });
				agentHostService.fireProgress({ sessionId, type: 'delta', messageId: 'msg-1', content: 'hello ' });
				agentHostService.fireProgress({ sessionId, type: 'delta', messageId: 'msg-1', content: 'world' });
				agentHostService.fireProgress({ sessionId, type: 'idle' });
			};

			await agent.impl.invoke(
				makeRequest(),
				(parts) => collected.push(parts),
				[], CancellationToken.None,
			);

			assert.strictEqual(collected.length, 2);
			assert.strictEqual(collected[0][0].kind, 'markdownContent');
			assert.strictEqual((collected[0][0] as IChatMarkdownContent).content.value, 'hello ');
			assert.strictEqual(collected[1][0].kind, 'markdownContent');
			assert.strictEqual((collected[1][0] as IChatMarkdownContent).content.value, 'world');
		});

		test('tool_start events become toolInvocation progress', async () => {
			const { chatAgentService, agentHostService } = createContribution(disposables);

			const agent = chatAgentService.registeredAgents.get('agent-host')!;
			const collected: IChatProgress[][] = [];

			agentHostService.sendMessage = async (sessionId: string) => {
				agentHostService.sendMessageCalls.push({ sessionId, prompt: '' });
				agentHostService.fireProgress({ sessionId, type: 'tool_start', toolCallId: 'tc-1', toolName: 'read_file' });
				agentHostService.fireProgress({ sessionId, type: 'idle' });
			};

			await agent.impl.invoke(
				makeRequest(),
				(parts) => collected.push(parts),
				[], CancellationToken.None,
			);

			assert.strictEqual(collected.length, 1);
			assert.strictEqual(collected[0][0].kind, 'toolInvocation');
		});

		test('tool_complete event transitions toolInvocation to completed', async () => {
			const { chatAgentService, agentHostService } = createContribution(disposables);

			const agent = chatAgentService.registeredAgents.get('agent-host')!;
			const collected: IChatProgress[][] = [];

			agentHostService.sendMessage = async (sessionId: string) => {
				agentHostService.sendMessageCalls.push({ sessionId, prompt: '' });
				agentHostService.fireProgress({ sessionId, type: 'tool_start', toolCallId: 'tc-2', toolName: 'shell' });
				agentHostService.fireProgress({ sessionId, type: 'tool_complete', toolCallId: 'tc-2', success: true });
				agentHostService.fireProgress({ sessionId, type: 'idle' });
			};

			await agent.impl.invoke(
				makeRequest(),
				(parts) => collected.push(parts),
				[], CancellationToken.None,
			);

			assert.strictEqual(collected.length, 1);
			const invocation = collected[0][0] as IChatToolInvocation;
			assert.strictEqual(invocation.kind, 'toolInvocation');
			assert.strictEqual(invocation.toolCallId, 'tc-2');
			assert.strictEqual(IChatToolInvocation.isComplete(invocation), true);
		});

		test('tool_complete with failure sets error state', async () => {
			const { chatAgentService, agentHostService } = createContribution(disposables);

			const agent = chatAgentService.registeredAgents.get('agent-host')!;
			const collected: IChatProgress[][] = [];

			agentHostService.sendMessage = async (sessionId: string) => {
				agentHostService.sendMessageCalls.push({ sessionId, prompt: '' });
				agentHostService.fireProgress({ sessionId, type: 'tool_start', toolCallId: 'tc-3', toolName: 'shell' });
				agentHostService.fireProgress({ sessionId, type: 'tool_complete', toolCallId: 'tc-3', success: false, error: { message: 'command not found' } });
				agentHostService.fireProgress({ sessionId, type: 'idle' });
			};

			await agent.impl.invoke(
				makeRequest(),
				(parts) => collected.push(parts),
				[], CancellationToken.None,
			);

			assert.strictEqual(collected.length, 1);
			const invocation = collected[0][0] as IChatToolInvocation;
			assert.strictEqual(invocation.kind, 'toolInvocation');
			assert.strictEqual(IChatToolInvocation.isComplete(invocation), true);
		});

		test('malformed toolArguments does not throw', async () => {
			const { chatAgentService, agentHostService } = createContribution(disposables);

			const agent = chatAgentService.registeredAgents.get('agent-host')!;
			const collected: IChatProgress[][] = [];

			agentHostService.sendMessage = async (sessionId: string) => {
				agentHostService.sendMessageCalls.push({ sessionId, prompt: '' });
				agentHostService.fireProgress({ sessionId, type: 'tool_start', toolCallId: 'tc-bad', toolName: 'shell', toolArguments: '{not valid json' });
				agentHostService.fireProgress({ sessionId, type: 'idle' });
			};

			await agent.impl.invoke(
				makeRequest(),
				(parts) => collected.push(parts),
				[], CancellationToken.None,
			);

			assert.strictEqual(collected.length, 1);
			assert.strictEqual(collected[0][0].kind, 'toolInvocation');
		});

		test('outstanding tool invocations are completed on idle', async () => {
			const { chatAgentService, agentHostService } = createContribution(disposables);

			const agent = chatAgentService.registeredAgents.get('agent-host')!;
			const collected: IChatProgress[][] = [];

			agentHostService.sendMessage = async (sessionId: string) => {
				agentHostService.sendMessageCalls.push({ sessionId, prompt: '' });
				// tool_start without tool_complete
				agentHostService.fireProgress({ sessionId, type: 'tool_start', toolCallId: 'tc-orphan', toolName: 'shell' });
				agentHostService.fireProgress({ sessionId, type: 'idle' });
			};

			await agent.impl.invoke(
				makeRequest(),
				(parts) => collected.push(parts),
				[], CancellationToken.None,
			);

			assert.strictEqual(collected.length, 1);
			const invocation = collected[0][0] as IChatToolInvocation;
			assert.strictEqual(invocation.kind, 'toolInvocation');
			assert.strictEqual(IChatToolInvocation.isComplete(invocation), true);
		});

		test('events from other sessions are ignored', async () => {
			const { chatAgentService, agentHostService } = createContribution(disposables);

			const agent = chatAgentService.registeredAgents.get('agent-host')!;
			const collected: IChatProgress[][] = [];

			agentHostService.sendMessage = async (sessionId: string) => {
				agentHostService.sendMessageCalls.push({ sessionId, prompt: '' });
				agentHostService.fireProgress({ sessionId: 'other-session', type: 'delta', messageId: 'msg-x', content: 'wrong' });
				agentHostService.fireProgress({ sessionId, type: 'delta', messageId: 'msg-y', content: 'right' });
				agentHostService.fireProgress({ sessionId, type: 'idle' });
			};

			await agent.impl.invoke(
				makeRequest(),
				(parts) => collected.push(parts),
				[], CancellationToken.None,
			);

			assert.strictEqual(collected.length, 1);
			assert.strictEqual((collected[0][0] as IChatMarkdownContent).content.value, 'right');
		});
	});

	// ---- Cancellation -----------------------------------------------------

	suite('cancellation', () => {

		test('cancellation resolves the agent invoke', async () => {
			const { chatAgentService, agentHostService } = createContribution(disposables);

			const agent = chatAgentService.registeredAgents.get('agent-host')!;
			const cts = new CancellationTokenSource();
			disposables.add(cts);

			agentHostService.sendMessage = async (sessionId: string) => {
				agentHostService.sendMessageCalls.push({ sessionId, prompt: '' });
				cts.cancel();
			};

			const result = await agent.impl.invoke(
				makeRequest(),
				() => { }, [], cts.token,
			);

			assert.ok(result);
		});

		test('cancellation force-completes outstanding tool invocations', async () => {
			const { chatAgentService, agentHostService } = createContribution(disposables);

			const agent = chatAgentService.registeredAgents.get('agent-host')!;
			const cts = new CancellationTokenSource();
			disposables.add(cts);
			const collected: IChatProgress[][] = [];

			agentHostService.sendMessage = async (sessionId: string) => {
				agentHostService.sendMessageCalls.push({ sessionId, prompt: '' });
				agentHostService.fireProgress({ sessionId, type: 'tool_start', toolCallId: 'tc-cancel', toolName: 'shell' });
				cts.cancel();
			};

			await agent.impl.invoke(
				makeRequest(),
				(parts) => collected.push(parts),
				[], cts.token,
			);

			assert.strictEqual(collected.length, 1);
			const invocation = collected[0][0] as IChatToolInvocation;
			assert.strictEqual(invocation.kind, 'toolInvocation');
			assert.strictEqual(IChatToolInvocation.isComplete(invocation), true);
		});
	});

	// ---- History loading ---------------------------------------------------

	suite('history loading', () => {

		test('loads user and assistant messages into history', async () => {
			const { sessionHandler, agentHostService } = createContribution(disposables);

			agentHostService.setSessionMessages('sess-1', [
				{ sessionId: 'sess-1', type: 'message', messageId: 'msg-u1', content: 'What is 2+2?', role: 'user' },
				{ sessionId: 'sess-1', type: 'message', messageId: 'msg-a1', content: '4', role: 'assistant' },
			]);

			const sessionResource = URI.from({ scheme: 'agent-host', path: '/sess-1' });
			const session = await sessionHandler.provideChatSessionContent(sessionResource, CancellationToken.None);
			disposables.add(toDisposable(() => session.dispose()));

			assert.strictEqual(session.history.length, 2);

			const request = session.history[0];
			assert.strictEqual(request.type, 'request');
			if (request.type === 'request') {
				assert.strictEqual(request.prompt, 'What is 2+2?');
			}

			const response = session.history[1];
			assert.strictEqual(response.type, 'response');
			if (response.type === 'response') {
				assert.strictEqual((response.parts[0] as IChatMarkdownContent).content.value, '4');
			}
		});

		test('untitled sessions have empty history', async () => {
			const { sessionHandler } = createContribution(disposables);

			const sessionResource = URI.from({ scheme: 'agent-host', path: '/untitled-xyz' });
			const session = await sessionHandler.provideChatSessionContent(sessionResource, CancellationToken.None);
			disposables.add(toDisposable(() => session.dispose()));

			assert.strictEqual(session.history.length, 0);
		});
	});
});
