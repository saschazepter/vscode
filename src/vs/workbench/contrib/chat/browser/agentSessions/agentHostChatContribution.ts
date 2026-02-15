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
import { IAgentHostService } from '../../../../../platform/agent/common/agentService.js';
import { IDefaultAccountService } from '../../../../../platform/defaultAccount/common/defaultAccount.js';
import { IAuthenticationService } from '../../../../services/authentication/common/authentication.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ChatAgentLocation, ChatModeKind } from '../../common/constants.js';
import { IChatAgentData, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentService } from '../../common/participants/chatAgents.js';
import { IChatProgress } from '../../common/chatService/chatService.js';
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
		let history: IChatSessionHistoryItem[] = [];
		if (!sessionId.startsWith('untitled-')) {
			const messages = await this._agentHostService.getSessionMessages(sessionId);
			history = messages.map(m => {
				if (m.role === 'user') {
					return { type: 'request' as const, prompt: m.content, participant: AGENT_HOST_AGENT_ID };
				}
				return {
					type: 'response' as const,
					parts: [{ kind: 'markdownContent' as const, content: new MarkdownString(m.content) }],
					participant: AGENT_HOST_AGENT_ID,
				};
			});
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
			interruptActiveResponseCallback: async () => {
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
		const sessionId = await this._resolveSessionId(request.sessionResource);

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
					const invocation = this._createToolInvocation(e.toolCallId, e.toolName, e.toolArguments);
					activeToolInvocations.set(e.toolCallId, invocation);
					progress([invocation]);
					break;
				}

				case 'tool_complete': {
					const invocation = activeToolInvocations.get(e.toolCallId);
					if (invocation) {
						activeToolInvocations.delete(e.toolCallId);
						invocation.didExecuteTool(!e.success ? { content: [], toolResultError: e.error?.message } : undefined);
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
			await this._agentHostService.sendMessage(sessionId, message);
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

	private _createToolInvocation(toolCallId: string, toolName: string, toolArguments: string | undefined): ChatToolInvocation {
		const toolData: IToolData = {
			id: toolName,
			source: ToolDataSource.Internal,
			displayName: toolName,
			modelDescription: toolName,
		};
		let parameters: unknown;
		if (toolArguments) {
			try {
				parameters = JSON.parse(toolArguments);
			} catch {
				// malformed JSON - leave parameters undefined
			}
		}
		return new ChatToolInvocation(undefined, toolData, toolCallId, undefined, parameters);
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
