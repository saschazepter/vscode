/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IAgentHostService, IAgentToolCompleteEvent, IAgentToolStartEvent } from '../../../../../platform/agent/common/agentService.js';
import { IDefaultAccountService } from '../../../../../platform/defaultAccount/common/defaultAccount.js';
import { IAuthenticationService } from '../../../../services/authentication/common/authentication.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ChatAgentLocation, ChatModeKind } from '../../common/constants.js';
import { IChatAgentData, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentService } from '../../common/participants/chatAgents.js';
import { IChatProgress, IChatTerminalToolInvocationData, IChatToolInvocationSerialized, ToolConfirmKind } from '../../common/chatService/chatService.js';
import { ChatToolInvocation } from '../../common/model/chatProgressTypes/chatToolInvocation.js';
import { IToolData, ToolDataSource } from '../../common/tools/languageModelToolsService.js';
import { ChatSessionStatus, IChatSession, IChatSessionContentProvider, IChatSessionHistoryItem, IChatSessionItem, IChatSessionItemController, IChatSessionsService } from '../../common/chatSessionsService.js';
import { getAgentHostIcon } from '../agentSessions/agentSessions.js';

const AGENT_HOST_SESSION_TYPE = 'agent-host';
const AGENT_HOST_AGENT_ID = 'agent-host';

// =============================================================================
// Session list controller - lists SDK sessions in the chat sessions view
// =============================================================================

/**
 * Lists sessions from the agent host process in the chat sessions view.
 * Standalone - no shared state with the other pieces.
 */
export class AgentHostSessionListController extends Disposable implements IChatSessionItemController {

	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<void>());
	readonly onDidChangeChatSessionItems = this._onDidChangeChatSessionItems.event;

	private _items: IChatSessionItem[] = [];

	constructor(
		private readonly _agentHostService: IAgentHostService,
		private readonly _productService: IProductService,
	) {
		super();
	}

	get items(): readonly IChatSessionItem[] {
		return this._items;
	}

	async refresh(_token: CancellationToken): Promise<void> {
		try {
			const sessions = await this._agentHostService.listSessions();
			this._items = sessions.map(s => ({
				resource: URI.from({ scheme: AGENT_HOST_SESSION_TYPE, path: `/${s.sessionId}` }),
				label: s.summary ?? `Session ${s.sessionId.substring(0, 8)}`,
				iconPath: getAgentHostIcon(this._productService),
				status: ChatSessionStatus.Completed,
				timing: {
					created: s.startTime,
					lastRequestStarted: s.modifiedTime,
					lastRequestEnded: s.modifiedTime,
				},
			}));
		} catch {
			this._items = [];
		}
		this._onDidChangeChatSessionItems.fire();
	}
}

// =============================================================================
// Session handler - opens sessions, streams responses, handles agent invocation
// =============================================================================

/**
 * Opens SDK sessions for viewing and handles user messages. Implements the
 * content provider (for the sessions view) and the agent invoke handler
 * (for the chat widget). These are coupled through shared streaming logic
 * ({@link _sendAndStreamResponse}) and session-ID resolution.
 */
export class AgentHostSessionHandler extends Disposable implements IChatSessionContentProvider {

	/** Maps VS Code chat resource URIs → SDK session IDs for multi-turn reuse. */
	private readonly _resourceToSessionId = new Map<string, string>();

	/** Tracks active contributed-session state (progress observable, completion). */
	private readonly _activeSessions = new Map<string, {
		readonly progressObs: ReturnType<typeof observableValue<IChatProgress[]>>;
		readonly isCompleteObs: ReturnType<typeof observableValue<boolean>>;
		readonly disposables: DisposableStore;
	}>();

	constructor(
		private readonly _agentHostService: IAgentHostService,
		private readonly _chatAgentService: IChatAgentService,
		private readonly _logService: ILogService,
		private readonly _productService: IProductService,
	) {
		super();
		this._registerAgent();
	}

	// ---- IChatSessionContentProvider ----------------------------------------

	async provideChatSessionContent(sessionResource: URI, _token: CancellationToken): Promise<IChatSession> {
		const sessionId = sessionResource.path.substring(1); // strip leading /

		// Load history (skip for brand-new untitled sessions)
		const history: IChatSessionHistoryItem[] = [];
		if (!sessionId.startsWith('untitled-')) {
			const events = await this._agentHostService.getSessionMessages(sessionId);

			// Group events into request/response pairs. Tool events are interleaved
			// into the preceding assistant response.
			let currentResponseParts: IChatProgress[] | undefined;
			const toolStartEvents = new Map<string, IAgentToolStartEvent>();

			for (const e of events) {
				if (e.type === 'message') {
					if (e.role === 'user') {
						// Flush any pending response
						if (currentResponseParts) {
							history.push({ type: 'response', parts: currentResponseParts, participant: AGENT_HOST_AGENT_ID });
							currentResponseParts = undefined;
						}
						history.push({ type: 'request', prompt: e.content, participant: AGENT_HOST_AGENT_ID });
					} else {
						if (!currentResponseParts) {
							currentResponseParts = [];
						}
						if (e.content) {
							currentResponseParts.push({ kind: 'markdownContent', content: new MarkdownString(e.content) });
						}
					}
				} else if (e.type === 'tool_start') {
					toolStartEvents.set(e.toolCallId, e);
					if (!currentResponseParts) {
						currentResponseParts = [];
					}
					// Build a serialized tool invocation from the protocol event
					const toolSpecificData = (e.toolKind === 'terminal' && e.toolInput)
						? { kind: 'terminal' as const, commandLine: { original: e.toolInput }, language: e.language ?? 'shellscript' }
						: undefined;
					currentResponseParts.push({
						kind: 'toolInvocationSerialized',
						toolCallId: e.toolCallId,
						toolId: e.toolName,
						source: ToolDataSource.Internal,
						invocationMessage: new MarkdownString(e.invocationMessage),
						originMessage: undefined,
						pastTenseMessage: undefined,
						isConfirmed: { type: ToolConfirmKind.ConfirmationNotNeeded },
						isComplete: false, // will be updated by tool_complete
						presentation: undefined,
						toolSpecificData,
					} satisfies IChatToolInvocationSerialized);
				} else if (e.type === 'tool_complete') {
					const startEvent = toolStartEvents.get(e.toolCallId);
					toolStartEvents.delete(e.toolCallId);
					// Find and update the matching tool invocation in currentResponseParts
					if (currentResponseParts) {
						const idx = currentResponseParts.findIndex(
							p => p.kind === 'toolInvocationSerialized' && p.toolCallId === e.toolCallId
						);
						if (idx >= 0) {
							const existing = currentResponseParts[idx] as IChatToolInvocationSerialized;
							const isTerminal = existing.toolSpecificData?.kind === 'terminal';
							currentResponseParts[idx] = {
								...existing,
								isComplete: true,
								pastTenseMessage: isTerminal ? undefined : new MarkdownString(e.pastTenseMessage),
								toolSpecificData: isTerminal
									? {
										...existing.toolSpecificData as IChatTerminalToolInvocationData,
										terminalCommandOutput: e.toolOutput !== undefined ? { text: e.toolOutput } : undefined,
										terminalCommandState: { exitCode: e.success ? 0 : 1 },
									}
									: existing.toolSpecificData,
							};
						}
					}
					if (!startEvent) {
						// Orphan tool_complete without matching tool_start -- skip
					}
				}
			}
			// Mark any incomplete tool invocations as complete (orphaned tool_start without tool_complete)
			if (currentResponseParts) {
				for (let i = 0; i < currentResponseParts.length; i++) {
					const part = currentResponseParts[i];
					if (part.kind === 'toolInvocationSerialized' && !part.isComplete) {
						currentResponseParts[i] = { ...part, isComplete: true };
					}
				}
			}
			// Flush trailing response
			if (currentResponseParts) {
				history.push({ type: 'response', parts: currentResponseParts, participant: AGENT_HOST_AGENT_ID });
			}
		}

		// Set up streaming state
		const progressObs = observableValue<IChatProgress[]>('agentHostProgress', []);
		const isCompleteObs = observableValue<boolean>('agentHostComplete', true);
		const disposables = new DisposableStore();
		const onWillDispose = new Emitter<void>();
		disposables.add(onWillDispose);

		this._activeSessions.set(sessionId, { progressObs, isCompleteObs, disposables });

		return {
			sessionResource,
			history,
			progressObs,
			isCompleteObs,
			onWillDispose: onWillDispose.event,
			requestHandler: async (request, progress, _history, cancellationToken) => {
				this._logService.info(`[AgentHost] requestHandler called for session ${sessionId}, message: "${request.message.substring(0, 50)}"`);
				const resolvedId = await this._resolveSessionId(sessionResource);

				const activeSession = this._activeSessions.get(sessionId);
				if (activeSession) {
					activeSession.isCompleteObs.set(false, undefined);
				}

				await this._sendAndStreamResponse(resolvedId, request.message, progress, cancellationToken);

				if (activeSession) {
					activeSession.isCompleteObs.set(true, undefined);
				}
			},
			// Only provide interruptActiveResponseCallback for sessions without
			// existing history. When history exists and isCompleteObs starts true,
			// the chat service creates a "pending request" that never gets cleaned
			// up, blocking all future requests with "already has a pending request".
			interruptActiveResponseCallback: history.length > 0 ? undefined : async () => {
				// TODO: Hook up session.abort()
				return true;
			},
			dispose: () => {
				onWillDispose.fire();
				this._activeSessions.delete(sessionId);

				// Destroy the SDK session in the agent host process
				const key = sessionResource.toString();
				const resolvedId = this._resourceToSessionId.get(key) ?? sessionId;
				this._resourceToSessionId.delete(key);
				this._agentHostService.disposeSession(resolvedId);

				disposables.dispose();
			},
		};
	}

	// ---- Chat agent ---------------------------------------------------------

	private _registerAgent(): void {
		const agentData: IChatAgentData = {
			id: AGENT_HOST_AGENT_ID,
			name: AGENT_HOST_AGENT_ID,
			fullName: 'Agent Host',
			description: 'Copilot SDK agent running in a dedicated process',
			extensionId: new ExtensionIdentifier('vscode.agent-host'),
			extensionVersion: undefined,
			extensionPublisherId: 'vscode',
			extensionDisplayName: 'Agent Host',
			isDefault: false,
			isDynamic: true,
			isCore: true,
			metadata: { themeIcon: getAgentHostIcon(this._productService) },
			slashCommands: [],
			locations: [ChatAgentLocation.Chat],
			modes: [ChatModeKind.Agent],
			disambiguation: [],
		};

		const agentImpl: IChatAgentImplementation = {
			invoke: async (request, progress, _history, cancellationToken) => {
				return this._invokeAgent(request, progress, cancellationToken);
			},
		};

		this._register(this._chatAgentService.registerDynamicAgent(agentData, agentImpl));
	}

	private async _invokeAgent(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		cancellationToken: CancellationToken,
	): Promise<IChatAgentResult> {
		this._logService.info(`[AgentHost] _invokeAgent called for resource: ${request.sessionResource.toString()}`);
		const sessionId = await this._resolveSessionId(request.sessionResource);
		this._logService.info(`[AgentHost] resolved session ID: ${sessionId}`);

		await this._sendAndStreamResponse(sessionId, request.message, progress, cancellationToken);

		const activeSession = this._activeSessions.get(sessionId);
		if (activeSession) {
			activeSession.isCompleteObs.set(true, undefined);
		}

		return {};
	}

	// ---- Core streaming -----------------------------------------------------

	/**
	 * Sends a message to the SDK session and streams progress events back to
	 * the chat UI until the session goes idle, the token is cancelled, or
	 * the send fails.
	 *
	 * Progress flow:
	 *   SDK event → IPC → onDidSessionProgress → this listener → progress()
	 *
	 *   delta          → markdownContent parts (streaming text)
	 *   tool_start     → ChatToolInvocation (persistent tool call block)
	 *   tool_complete  → completes the matching ChatToolInvocation
	 *   idle           → resolves the promise, ends the response
	 */
	private async _sendAndStreamResponse(
		sessionId: string,
		message: string,
		progress: (parts: IChatProgress[]) => void,
		cancellationToken: CancellationToken,
	): Promise<void> {
		if (cancellationToken.isCancellationRequested) {
			return;
		}

		const activeToolInvocations = new Map<string, ChatToolInvocation>();

		let resolveDone: () => void;
		const done = new Promise<void>(resolve => { resolveDone = resolve; });

		const finish = () => {
			this._finalizeOutstandingTools(activeToolInvocations);
			listener.dispose();
			resolveDone();
		};

		const listener = this._agentHostService.onDidSessionProgress(e => {
			if (e.sessionId !== sessionId || cancellationToken.isCancellationRequested) {
				return;
			}

			switch (e.type) {
				case 'delta':
					progress([{ kind: 'markdownContent', content: new MarkdownString(e.content) }]);
					break;

				case 'tool_start': {
					const invocation = this._createToolInvocation(e);
					activeToolInvocations.set(e.toolCallId, invocation);
					progress([invocation]);
					break;
				}

				case 'tool_complete': {
					const invocation = activeToolInvocations.get(e.toolCallId);
					if (invocation) {
						activeToolInvocations.delete(e.toolCallId);
						this._finalizeToolInvocation(invocation, e);
					}
					break;
				}

				case 'idle':
					finish();
					break;
			}
		});

		const cancelListener = cancellationToken.onCancellationRequested(() => {
			finish();
			cancelListener.dispose();
		});

		try {
			this._logService.info(`[AgentHost] Sending message to session ${sessionId}`);
			await this._agentHostService.sendMessage(sessionId, message);
			this._logService.info(`[AgentHost] sendMessage returned for session ${sessionId}`);
		} catch (err) {
			this._logService.error(`[AgentHost] [${sessionId}] sendMessage failed`, err);
			finish();
		}

		await done;
		cancelListener.dispose();
	}

	// ---- Helpers ------------------------------------------------------------

	/**
	 * Resolves a VS Code chat resource URI to an SDK session ID.
	 *
	 * - `agent-host:///some-id` → uses `some-id` directly (existing session)
	 * - `agent-host:///untitled-*` → creates a new SDK session (mapped)
	 * - Any other scheme → creates or reuses an SDK session keyed by URI
	 */
	private async _resolveSessionId(sessionResource: URI): Promise<string> {
		if (sessionResource.scheme === AGENT_HOST_SESSION_TYPE && !sessionResource.path.startsWith('/untitled-')) {
			return sessionResource.path.substring(1);
		}

		const key = sessionResource.toString();
		const existing = this._resourceToSessionId.get(key);
		if (existing) {
			return existing;
		}

		const sessionId = await this._agentHostService.createSession();
		this._resourceToSessionId.set(key, sessionId);
		return sessionId;
	}

	private _createToolInvocation(event: IAgentToolStartEvent): ChatToolInvocation {
		const toolData: IToolData = {
			id: event.toolName,
			source: ToolDataSource.Internal,
			displayName: event.displayName,
			modelDescription: event.toolName,
		};
		let parameters: unknown;
		if (event.toolArguments) {
			try {
				parameters = JSON.parse(event.toolArguments);
			} catch {
				// malformed JSON - leave parameters undefined
			}
		}

		const invocation = new ChatToolInvocation(undefined, toolData, event.toolCallId, undefined, parameters);
		invocation.invocationMessage = new MarkdownString(event.invocationMessage);

		// For terminal-kind tools, render as a proper terminal command block
		if (event.toolKind === 'terminal' && event.toolInput) {
			invocation.toolSpecificData = {
				kind: 'terminal',
				commandLine: { original: event.toolInput },
				language: event.language ?? 'shellscript',
			} satisfies IChatTerminalToolInvocationData;
		}

		return invocation;
	}

	private _finalizeToolInvocation(invocation: ChatToolInvocation, event: IAgentToolCompleteEvent): void {
		// Update terminal tool data with output and exit code.
		// Don't set pastTenseMessage for terminal tools -- the terminal command block
		// UI handles the display. Setting it would create a redundant markdown message
		// beneath the command block.
		if (invocation.toolSpecificData?.kind === 'terminal') {
			const terminalData = invocation.toolSpecificData as IChatTerminalToolInvocationData;
			invocation.toolSpecificData = {
				...terminalData,
				terminalCommandOutput: event.toolOutput !== undefined ? { text: event.toolOutput } : undefined,
				terminalCommandState: {
					exitCode: event.success ? 0 : 1,
				},
			};
		} else {
			invocation.pastTenseMessage = new MarkdownString(event.pastTenseMessage);
		}

		invocation.didExecuteTool(!event.success ? { content: [], toolResultError: event.error?.message } : undefined);
	}

	private _finalizeOutstandingTools(activeToolInvocations: Map<string, ChatToolInvocation>): void {
		for (const [id, invocation] of activeToolInvocations) {
			invocation.didExecuteTool(undefined);
			activeToolInvocations.delete(id);
		}
	}

	override dispose(): void {
		for (const [, state] of this._activeSessions) {
			state.disposables.dispose();
		}
		this._activeSessions.clear();
		this._resourceToSessionId.clear();
		super.dispose();
	}
}

// =============================================================================
// Workbench contribution - wires everything together and handles auth
// =============================================================================

/**
 * Entry point that creates and registers the session list controller,
 * session handler, and agent. Also pushes auth tokens to the agent host.
 */
export class AgentHostChatContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentHostChatContribution';

	constructor(
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IChatSessionsService chatSessionsService: IChatSessionsService,
		@IChatAgentService chatAgentService: IChatAgentService,
		@IDefaultAccountService private readonly _defaultAccountService: IDefaultAccountService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@ILogService logService: ILogService,
		@IProductService productService: IProductService,
	) {
		super();

		// Session list controller
		const listController = this._register(new AgentHostSessionListController(this._agentHostService, productService));
		this._register(chatSessionsService.registerChatSessionItemController(AGENT_HOST_SESSION_TYPE, listController));

		// Session handler + agent
		const sessionHandler = this._register(new AgentHostSessionHandler(this._agentHostService, chatAgentService, logService, productService));
		this._register(chatSessionsService.registerChatSessionContentProvider(AGENT_HOST_SESSION_TYPE, sessionHandler));

		// Auth
		this._pushAuthToken();
		this._register(this._defaultAccountService.onDidChangeDefaultAccount(() => this._pushAuthToken()));
		this._register(this._authenticationService.onDidChangeSessions(() => this._pushAuthToken()));
	}

	private async _pushAuthToken(): Promise<void> {
		try {
			const account = await this._defaultAccountService.getDefaultAccount();
			if (!account) {
				return;
			}

			const sessions = await this._authenticationService.getSessions(account.authenticationProvider.id);
			const session = sessions.find(s => s.id === account.sessionId);
			if (session) {
				await this._agentHostService.setAuthToken(session.accessToken);
			}
		} catch {
			// best-effort
		}
	}
}
