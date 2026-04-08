/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ILogService, NullLogService } from '../../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { AgentSession, type IAgentCreateSessionConfig, type IAgentHostService, type IAgentSessionMetadata } from '../../../../../../platform/agentHost/common/agentService.js';
import { SessionClientState } from '../../../../../../platform/agentHost/common/state/sessionClientState.js';
import { ROOT_STATE_URI, SessionLifecycle, SessionStatus, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, TurnState, ResponsePartKind, createActiveTurn, createSessionState, type ISessionState, type ISessionSummary } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { ActionType, type IActionEnvelope, type INotification, type ISessionAction } from '../../../../../../platform/agentHost/common/state/sessionActions.js';
import type { IStateSnapshot } from '../../../../../../platform/agentHost/common/state/sessionProtocol.js';
import { IChatAgentData, IChatAgentImplementation, IChatAgentService } from '../../../common/participants/chatAgents.js';
import { IChatService, IChatToolInvocation, IChatToolInvocationSerialized } from '../../../common/chatService/chatService.js';
import { IChatEditingService } from '../../../common/editing/chatEditingService.js';
import { AgentHostSessionHandler } from '../../../browser/agentSessions/agentHost/agentHostSessionHandler.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';

class MockAgentHostService extends mock<IAgentHostService>() {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidAction = new Emitter<IActionEnvelope>();
	override readonly onDidAction = this._onDidAction.event;
	private readonly _onDidNotification = new Emitter<INotification>();
	override readonly onDidNotification = this._onDidNotification.event;
	override readonly onAgentHostExit = Event.None;
	override readonly onAgentHostStart = Event.None;
	override readonly clientId = 'test-window-1';

	private _nextId = 1;
	private _nextSeq = 1;
	private readonly _sessions = new Map<string, IAgentSessionMetadata>();
	readonly sessionStates = new Map<string, ISessionState>();
	readonly dispatchedActions: { action: ISessionAction; clientId: string; clientSeq: number }[] = [];

	override async listSessions(): Promise<IAgentSessionMetadata[]> {
		return [...this._sessions.values()];
	}

	override async createSession(config?: IAgentCreateSessionConfig): Promise<URI> {
		const id = `sdk-session-${this._nextId++}`;
		const session = AgentSession.uri('copilot', id);
		this._sessions.set(id, { session, startTime: Date.now(), modifiedTime: Date.now() });
		void config;
		return session;
	}

	override async disposeSession(_session: URI): Promise<void> { }
	override async shutdown(): Promise<void> { }
	override async restartAgentHost(): Promise<void> { }

	override async subscribe(resource: URI): Promise<IStateSnapshot> {
		const resourceStr = resource.toString();
		const existingState = this.sessionStates.get(resourceStr);
		if (existingState) {
			return { resource: resourceStr, state: existingState, fromSeq: 0 };
		}
		if (resourceStr === ROOT_STATE_URI) {
			return {
				resource: resourceStr,
				state: { agents: [{ provider: 'copilot', displayName: 'Agent Host - Copilot', description: 'test', models: [] }], activeSessions: 0 },
				fromSeq: 0,
			};
		}

		throw new Error(`No mocked session state for ${resourceStr}`);
	}

	override unsubscribe(_resource: URI): void { }

	override dispatchAction(action: ISessionAction, clientId: string, clientSeq: number): void {
		this.dispatchedActions.push({ action, clientId, clientSeq });
	}

	override nextClientSeq(): number {
		return this._nextSeq++;
	}

	fireAction(envelope: IActionEnvelope): void {
		this._onDidAction.fire(envelope);
	}

	dispose(): void {
		this._onDidAction.dispose();
		this._onDidNotification.dispose();
	}
}

class MockChatAgentService extends mock<IChatAgentService>() {
	declare readonly _serviceBrand: undefined;

	override registerDynamicAgent(_data: IChatAgentData, _agentImpl: IChatAgentImplementation) {
		return toDisposable(() => { });
	}
}

function createSessionHandler(disposables: DisposableStore) {
	const instantiationService = disposables.add(new TestInstantiationService());
	const agentHostService = new MockAgentHostService();
	disposables.add(toDisposable(() => agentHostService.dispose()));
	const chatAgentService = new MockChatAgentService();

	instantiationService.stub(IChatAgentService, chatAgentService);
	instantiationService.stub(IChatService, {
		getSession: () => undefined,
		onDidCreateModel: Event.None,
		removePendingRequest: () => { },
	});
	instantiationService.stub(IChatEditingService, {
		registerEditingSessionProvider: () => toDisposable(() => { }),
	});
	instantiationService.stub(ILogService, new NullLogService());
	instantiationService.stub(IProductService, { quality: 'insider' });
	instantiationService.stub(IWorkspaceContextService, { getWorkspace: () => ({ id: '', folders: [] }), getWorkspaceFolder: () => null });

	const clientState = disposables.add(new SessionClientState(agentHostService.clientId, new NullLogService(), () => agentHostService.nextClientSeq()));
	disposables.add(agentHostService.onDidAction(e => clientState.receiveEnvelope(e)));

	const sessionHandler = disposables.add(instantiationService.createInstance(AgentHostSessionHandler, {
		provider: 'copilot' as const,
		agentId: 'agent-host-copilot',
		sessionType: 'agent-host-copilot',
		fullName: 'Agent Host - Copilot',
		description: 'Copilot SDK agent running in a dedicated process',
		connection: agentHostService,
		connectionAuthority: 'local',
		clientState,
	}));

	return { sessionHandler, agentHostService };
}

function makeActiveSessionStateWithRunningSubagent(sessionUri: string): ISessionState {
	const summary: ISessionSummary = {
		resource: sessionUri,
		provider: 'copilot',
		title: 'Active Session',
		status: SessionStatus.Idle,
		createdAt: Date.now(),
		modifiedAt: Date.now(),
	};

	return {
		...createSessionState(summary),
		lifecycle: SessionLifecycle.Ready,
		turns: [],
		activeTurn: {
			...createActiveTurn('turn-active', { text: 'Second message' }),
			responseParts: [{
				kind: ResponsePartKind.ToolCall,
				toolCall: {
					status: ToolCallStatus.Running,
					toolCallId: 'tc-subagent',
					toolName: 'runSubagent',
					displayName: 'Run Subagent',
					invocationMessage: 'Delegating task...',
					confirmed: ToolCallConfirmationReason.NotNeeded,
					content: [{
						type: ToolResultContentType.Subagent,
						resource: `${sessionUri}/subagent/tc-subagent`,
						title: 'Code Reviewer',
						agentName: 'code-reviewer',
						description: 'Reviews code',
					}],
				},
			}],
		},
	};
}

function makeCompletedSessionStateWithSubagentTurn(sessionUri: string): ISessionState {
	const summary: ISessionSummary = {
		resource: sessionUri,
		provider: 'copilot',
		title: 'Completed Session',
		status: SessionStatus.Idle,
		createdAt: Date.now(),
		modifiedAt: Date.now(),
	};

	return {
		...createSessionState(summary),
		lifecycle: SessionLifecycle.Ready,
		turns: [{
			id: 'turn-complete',
			userMessage: { text: 'Review this change' },
			responseParts: [{
				kind: ResponsePartKind.ToolCall,
				toolCall: {
					status: ToolCallStatus.Completed,
					toolCallId: 'tc-complete-subagent',
					toolName: 'runSubagent',
					displayName: 'Run Subagent',
					invocationMessage: 'Delegating task...',
					confirmed: ToolCallConfirmationReason.NotNeeded,
					success: true,
					pastTenseMessage: 'Delegated task',
					content: [{
						type: ToolResultContentType.Subagent,
						resource: `${sessionUri}/subagent/tc-complete-subagent`,
						title: 'Code Reviewer',
						agentName: 'code-reviewer',
						description: 'Reviews code',
					}, {
						type: ToolResultContentType.Text,
						text: 'Suggested one follow-up fix',
					}],
				},
			}],
			usage: undefined,
			state: TurnState.Complete,
		}],
	};
}

function makeActiveSubagentChildSessionState(sessionUri: string): ISessionState {
	const summary: ISessionSummary = {
		resource: sessionUri,
		provider: 'copilot',
		title: 'Child Session',
		status: SessionStatus.Idle,
		createdAt: Date.now(),
		modifiedAt: Date.now(),
	};

	return {
		...createSessionState(summary),
		lifecycle: SessionLifecycle.Ready,
		turns: [],
		activeTurn: {
			...createActiveTurn('child-turn-active', { text: 'Inspect issue' }),
			responseParts: [{ kind: ResponsePartKind.Markdown, id: 'child-md-1', content: 'Inspecting files now' }, {
				kind: ResponsePartKind.ToolCall,
				toolCall: {
					status: ToolCallStatus.Running,
					toolCallId: 'child-tool-1',
					toolName: 'bash',
					displayName: 'Bash',
					invocationMessage: 'Running Bash',
					confirmed: ToolCallConfirmationReason.NotNeeded,
					_meta: { toolKind: 'terminal', language: 'shellscript' },
					toolInput: 'git status',
				},
			}],
		},
	};
}

suite('AgentHostSubagentIntegration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let disposables: DisposableStore;

	setup(() => {
		disposables = store.add(new DisposableStore());
	});

	teardown(() => disposables.clear());

	test('restores a running subagent tool from snapshot and finalizes it with result data', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { sessionHandler, agentHostService } = createSessionHandler(disposables);
		const sessionUri = AgentSession.uri('copilot', 'reconnect-subagent');
		agentHostService.sessionStates.set(sessionUri.toString(), makeActiveSessionStateWithRunningSubagent(sessionUri.toString()));

		const sessionResource = URI.from({ scheme: 'agent-host-copilot', path: '/reconnect-subagent' });
		const chatSession = await sessionHandler.provideChatSessionContent(sessionResource, CancellationToken.None);
		disposables.add(toDisposable(() => chatSession.dispose()));

		assert.strictEqual(chatSession.history.length, 2);
		assert.strictEqual(chatSession.history[0].type, 'request');
		if (chatSession.history[0].type === 'request') {
			assert.strictEqual(chatSession.history[0].prompt, 'Second message');
		}
		assert.strictEqual(chatSession.history[1].type, 'response');
		if (chatSession.history[1].type === 'response') {
			assert.strictEqual(chatSession.history[1].parts.length, 0);
		}

		assert.ok(chatSession.progressObs);
		const progress = chatSession.progressObs.get();
		const invocation = progress.find((item): item is IChatToolInvocation => item.kind === 'toolInvocation');
		assert.ok(invocation);
		assert.deepStrictEqual(invocation.toolSpecificData, {
			kind: 'subagent',
			description: 'Reviews code',
			agentName: 'code-reviewer',
		});
		const completeToolCallAction: ISessionAction = {
			type: ActionType.SessionToolCallComplete,
			session: sessionUri.toString(),
			turnId: 'turn-active',
			toolCallId: 'tc-subagent',
			result: {
				success: true,
				pastTenseMessage: 'Delegated task',
				content: [{
					type: ToolResultContentType.Subagent,
					resource: `${sessionUri}/subagent/tc-subagent`,
					title: 'Code Reviewer',
					agentName: 'code-reviewer',
					description: 'Reviews code',
				}, {
					type: ToolResultContentType.Text,
					text: 'Child session finished',
				}],
			},
		};
		const completeTurnAction: ISessionAction = { type: ActionType.SessionTurnComplete, session: sessionUri.toString(), turnId: 'turn-active' };

		agentHostService.fireAction({
			action: completeToolCallAction,
			serverSeq: 1,
			origin: undefined,
		});
		agentHostService.fireAction({
			action: completeTurnAction,
			serverSeq: 2,
			origin: undefined,
		});

		await timeout(10);

		assert.ok(chatSession.isCompleteObs);
		assert.strictEqual(chatSession.isCompleteObs.get(), true);
		const finalizedProgress = chatSession.progressObs.get();
		const finalizedInvocation = finalizedProgress.find((item): item is IChatToolInvocation => item.kind === 'toolInvocation' && item.toolCallId === 'tc-subagent');
		assert.ok(finalizedInvocation);
		assert.deepStrictEqual(finalizedInvocation.toolSpecificData, {
			kind: 'subagent',
			description: 'Reviews code',
			agentName: 'code-reviewer',
			result: 'Child session finished',
		});
		assert.strictEqual(IChatToolInvocation.isComplete(finalizedInvocation), true);
	}));

	test('reconnects an active subagent child session and continues streaming progress', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { sessionHandler, agentHostService } = createSessionHandler(disposables);
		const childSessionUri = AgentSession.uri('copilot', 'reconnect-subagent/subagent/tc-subagent');
		agentHostService.sessionStates.set(childSessionUri.toString(), makeActiveSubagentChildSessionState(childSessionUri.toString()));

		const sessionResource = URI.from({ scheme: 'agent-host-copilot', path: '/reconnect-subagent/subagent/tc-subagent' });
		const chatSession = await sessionHandler.provideChatSessionContent(sessionResource, CancellationToken.None);
		disposables.add(toDisposable(() => chatSession.dispose()));

		assert.strictEqual(chatSession.history.length, 2);
		assert.strictEqual(chatSession.history[0].type, 'request');
		if (chatSession.history[0].type === 'request') {
			assert.strictEqual(chatSession.history[0].prompt, 'Inspect issue');
		}
		assert.strictEqual(chatSession.history[1].type, 'response');
		if (chatSession.history[1].type === 'response') {
			assert.strictEqual(chatSession.history[1].parts.length, 0);
		}

		assert.ok(chatSession.isCompleteObs);
		assert.ok(chatSession.progressObs);
		assert.strictEqual(chatSession.isCompleteObs.get(), false);
		const progress = chatSession.progressObs.get();
		const markdown = progress.find(item => item.kind === 'markdownContent');
		const childToolInvocation = progress.find((item): item is IChatToolInvocation => item.kind === 'toolInvocation' && item.toolCallId === 'child-tool-1');
		assert.ok(markdown);
		assert.ok(childToolInvocation);
		if (markdown?.kind !== 'markdownContent') {
			return;
		}
		assert.strictEqual(markdown.content.value, 'Inspecting files now');
		assert.strictEqual(childToolInvocation.toolId, 'bash');

		const deltaAction: ISessionAction = {
			type: ActionType.SessionDelta,
			session: childSessionUri.toString(),
			turnId: 'child-turn-active',
			partId: 'child-md-1',
			content: ' and reporting back',
		};
		const childTurnCompleteAction: ISessionAction = { type: ActionType.SessionTurnComplete, session: childSessionUri.toString(), turnId: 'child-turn-active' };

		agentHostService.fireAction({
			action: deltaAction,
			serverSeq: 1,
			origin: undefined,
		});
		await timeout(10);

		const updatedProgress = chatSession.progressObs.get();
		const updatedMarkdown = updatedProgress.filter(item => item.kind === 'markdownContent');
		assert.strictEqual(updatedMarkdown.length, 2);
		assert.strictEqual(updatedMarkdown[1].content.value, ' and reporting back');

		agentHostService.fireAction({
			action: childTurnCompleteAction,
			serverSeq: 2,
			origin: undefined,
		});
		await timeout(10);

		assert.ok(chatSession.isCompleteObs);
		assert.strictEqual(chatSession.isCompleteObs.get(), true);
	}));

	test('restores a completed subagent tool in history with finalized result data', async () => {
		const { sessionHandler, agentHostService } = createSessionHandler(disposables);
		const sessionUri = AgentSession.uri('copilot', 'history-subagent');
		agentHostService.sessionStates.set(sessionUri.toString(), makeCompletedSessionStateWithSubagentTurn(sessionUri.toString()));

		const sessionResource = URI.from({ scheme: 'agent-host-copilot', path: '/history-subagent' });
		const chatSession = await sessionHandler.provideChatSessionContent(sessionResource, CancellationToken.None);
		disposables.add(toDisposable(() => chatSession.dispose()));

		assert.strictEqual(chatSession.history.length, 2);
		assert.strictEqual(chatSession.history[1].type, 'response');
		if (chatSession.history[1].type !== 'response') {
			return;
		}

		const invocation = chatSession.history[1].parts.find((part): part is IChatToolInvocationSerialized => part.kind === 'toolInvocationSerialized');
		assert.ok(invocation);
		assert.deepStrictEqual(invocation.toolSpecificData, {
			kind: 'subagent',
			description: 'Reviews code',
			agentName: 'code-reviewer',
			result: 'Suggested one follow-up fix',
		});
		assert.strictEqual(invocation.isComplete, true);
	});
});
