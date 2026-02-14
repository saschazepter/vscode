/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ILoggerService, LogLevel } from '../../../../../platform/log/common/log.js';
import { IAgentHostService, IAgentProgressEvent } from '../../../../../platform/agent/common/agentService.js';
import { IDefaultAccountService } from '../../../../../platform/defaultAccount/common/defaultAccount.js';
import { IAuthenticationService } from '../../../../services/authentication/common/authentication.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ChatAgentLocation, ChatModeKind } from '../../common/constants.js';
import { IChatAgentData, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentService } from '../../common/participants/chatAgents.js';
import { IChatProgress } from '../../common/chatService/chatService.js';
import { ChatSessionStatus, IChatSession, IChatSessionContentProvider, IChatSessionHistoryItem, IChatSessionItem, IChatSessionItemController, IChatSessionsService } from '../../common/chatSessionsService.js';

const AGENT_HOST_SESSION_TYPE = 'agent-host';
const AGENT_HOST_AGENT_ID = 'agent-host';

/**
 * Workbench contribution that:
 * 1. Pushes GitHub auth tokens to the agent host process
 * 2. Registers a chat session item controller (lists sessions)
 * 3. Registers a chat session content provider (opens sessions)
 * 4. Registers a dynamic chat agent (handles user requests)
 */
export class AgentHostChatContribution extends Disposable implements IChatSessionItemController, IChatSessionContentProvider, IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentHostChatContribution';

	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<void>());
	readonly onDidChangeChatSessionItems = this._onDidChangeChatSessionItems.event;

	private _items: IChatSessionItem[] = [];

	private readonly _logger;

	/** Map of session resource URI strings → SDK session IDs for multi-turn. */
	private readonly _resourceToSessionId = new Map<string, string>();

	/** Map of session IDs to active session state for streaming. */
	private readonly _activeSessions = new Map<string, {
		readonly progressObs: ReturnType<typeof observableValue<IChatProgress[]>>;
		readonly isCompleteObs: ReturnType<typeof observableValue<boolean>>;
		readonly disposables: DisposableStore;
	}>();

	constructor(
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IChatSessionsService private readonly _chatSessionsService: IChatSessionsService,
		@IChatAgentService private readonly _chatAgentService: IChatAgentService,
		@IDefaultAccountService private readonly _defaultAccountService: IDefaultAccountService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@ILoggerService loggerService: ILoggerService,
	) {
		super();

		// Create a dedicated output channel logger for Agent Host
		const logger = this._register(loggerService.createLogger('agentHost', { name: 'Agent Host' }));
		logger.setLevel(LogLevel.Trace);
		this._logger = logger;

		this._logger.info('AgentHostChatContribution initialized');

		// 1. Register as session item controller
		this._register(this._chatSessionsService.registerChatSessionItemController(AGENT_HOST_SESSION_TYPE, this));

		// 2. Register as content provider
		this._register(this._chatSessionsService.registerChatSessionContentProvider(AGENT_HOST_SESSION_TYPE, this));

		// 3. Register the dynamic chat agent
		this._registerAgent();

		// 4. Push auth tokens
		this._pushAuthToken();
		this._register(this._defaultAccountService.onDidChangeDefaultAccount(() => this._pushAuthToken()));
		this._register(this._authenticationService.onDidChangeSessions(() => this._pushAuthToken()));
	}

	// ---- Auth ---------------------------------------------------------------

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
				this._logger.info('Pushed auth token to agent host');
			}
		} catch (err) {
			this._logger.warn('Failed to push auth token', err);
		}
	}

	// ---- IChatSessionItemController -----------------------------------------

	get items(): readonly IChatSessionItem[] {
		return this._items;
	}

	async refresh(token: CancellationToken): Promise<void> {
		this._logger.debug('Refreshing session list...');
		try {
			const sessions = await this._agentHostService.listSessions();
			this._items = sessions.map(s => ({
				resource: URI.from({ scheme: AGENT_HOST_SESSION_TYPE, path: `/${s.sessionId}` }),
				label: s.summary ?? `Session ${s.sessionId.substring(0, 8)}`,
				iconPath: Codicon.copilot,
				status: ChatSessionStatus.Completed,
				timing: {
					created: s.startTime,
					lastRequestStarted: s.modifiedTime,
					lastRequestEnded: s.modifiedTime,
				},
			}));
			this._logger.info(`Found ${this._items.length} sessions`);
		} catch {
			this._items = [];
		}
		this._onDidChangeChatSessionItems.fire();
	}

	// ---- IChatSessionContentProvider ----------------------------------------

	async provideChatSessionContent(sessionResource: URI, token: CancellationToken): Promise<IChatSession> {
		const sessionId = sessionResource.path.substring(1); // strip leading /
		this._logger.info(`Loading session content for ${sessionId}`);

		// Load history from the SDK
		const messages = await this._agentHostService.getSessionMessages(sessionId);
		const history: IChatSessionHistoryItem[] = messages.map(m => {
			if (m.role === 'user') {
				return {
					type: 'request' as const,
					prompt: m.content ?? '',
					participant: AGENT_HOST_AGENT_ID,
				};
			}
			return {
				type: 'response' as const,
				parts: [{ kind: 'markdownContent' as const, content: new MarkdownString(m.content ?? '') }],
				participant: AGENT_HOST_AGENT_ID,
			};
		});

		// Set up streaming observables
		const progressObs = observableValue<IChatProgress[]>('agentHostProgress', []);
		const isCompleteObs = observableValue<boolean>('agentHostComplete', true);

		const disposables = new DisposableStore();

		const sessionState = { progressObs, isCompleteObs, disposables };
		this._activeSessions.set(sessionId, sessionState);

		const onWillDispose = new Emitter<void>();
		disposables.add(onWillDispose);

		const chatSession: IChatSession = {
			sessionResource,
			history,
			progressObs,
			isCompleteObs,
			onWillDispose: onWillDispose.event,
			requestHandler: async (request, progress, _history, cancellationToken) => {
				await this._handleRequest(sessionId, request, progress, cancellationToken);
			},
			interruptActiveResponseCallback: async () => {
				// TODO: Hook up session.abort()
				return true;
			},
			dispose: () => {
				onWillDispose.fire();
				this._activeSessions.delete(sessionId);
				disposables.dispose();
			},
		};

		return chatSession;
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
			metadata: {
				themeIcon: Codicon.copilot,
			},
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
		// Determine session ID from the request resource or create a new one
		const sessionResource = request.sessionResource;
		let sessionId: string;

		if (sessionResource.scheme === AGENT_HOST_SESSION_TYPE && !sessionResource.path.startsWith('/untitled-')) {
			sessionId = sessionResource.path.substring(1);
			this._logger.debug(`Using existing agent-host session: ${sessionId}`);
		} else {
			// Reuse existing session for this resource, or create a new one
			const key = sessionResource.toString();
			const existing = this._resourceToSessionId.get(key);
			if (existing) {
				sessionId = existing;
				this._logger.debug(`Reusing SDK session ${sessionId} for resource ${key}`);
			} else {
				sessionId = await this._agentHostService.createSession();
				this._resourceToSessionId.set(key, sessionId);
				this._logger.info(`Created new SDK session ${sessionId} for resource ${key}`);
			}
		}

		// Listen for progress events filtered to this session
		let resolveDone: () => void;
		const done = new Promise<void>((resolve) => { resolveDone = resolve; });

		const listener = this._agentHostService.onDidSessionProgress((e: IAgentProgressEvent) => {
			if (e.sessionId !== sessionId || cancellationToken.isCancellationRequested) {
				return;
			}

			if (e.type === 'delta' && e.content) {
				this._logger.trace(`[${sessionId}] delta: ${e.content.length} chars`);
				progress([{ kind: 'markdownContent', content: new MarkdownString(e.content) }]);
			} else if (e.type === 'tool_start' && e.content) {
				this._logger.info(`[${sessionId}] tool start: ${e.content}`);
				progress([{ kind: 'progressMessage', content: new MarkdownString(`Running tool: ${e.content}`) }]);
			} else if (e.type === 'idle') {
				this._logger.info(`[${sessionId}] session idle - response complete`);
				listener.dispose();
				resolveDone!();
			}
		});

		const cancelListener = cancellationToken.onCancellationRequested(() => {
			listener.dispose();
			cancelListener.dispose();
			resolveDone!();
		});

		// Send the message
		this._logger.info(`[${sessionId}] Sending message: "${request.message.substring(0, 100)}${request.message.length > 100 ? '...' : ''}"`);
		try {
			await this._agentHostService.sendMessage(sessionId, request.message);
		} catch (err) {
			this._logger.error(`[${sessionId}] sendMessage failed`, err);
			listener.dispose();
			cancelListener.dispose();
			resolveDone!();
		}
		await done;
		cancelListener.dispose();
		const activeSession = this._activeSessions.get(sessionId);
		if (activeSession) {
			activeSession.isCompleteObs.set(true, undefined);
		}

		return {};
	}

	// ---- Request handler for contributed sessions ---------------------------

	private async _handleRequest(
		sessionId: string,
		request: IChatAgentRequest,
		progress: (progress: IChatProgress[]) => void,
		cancellationToken: CancellationToken,
	): Promise<void> {
		const activeSession = this._activeSessions.get(sessionId);
		if (activeSession) {
			activeSession.isCompleteObs.set(false, undefined);
		}

		let resolveDone: () => void;
		const done = new Promise<void>((resolve) => { resolveDone = resolve; });

		const listener = this._agentHostService.onDidSessionProgress((e: IAgentProgressEvent) => {
			if (e.sessionId !== sessionId || cancellationToken.isCancellationRequested) {
				return;
			}

			if (e.type === 'delta' && e.content) {
				const progressItem: IChatProgress = { kind: 'markdownContent', content: new MarkdownString(e.content) };
				progress([progressItem]);

				if (activeSession) {
					const current = activeSession.progressObs.get();
					activeSession.progressObs.set([...current, progressItem], undefined);
				}
			} else if (e.type === 'idle') {
				listener.dispose();
				resolveDone!();
			}
		});

		const cancelListener = cancellationToken.onCancellationRequested(() => {
			listener.dispose();
			cancelListener.dispose();
			resolveDone!();
		});

		try {
			await this._agentHostService.sendMessage(sessionId, request.message);
		} catch (err) {
			this._logger.error(`[${sessionId}] sendMessage failed in session handler`, err);
			listener.dispose();
			cancelListener.dispose();
			resolveDone!();
		}
		await done;
		cancelListener.dispose();

		if (activeSession) {
			activeSession.isCompleteObs.set(true, undefined);
		}
	}

	override dispose(): void {
		for (const [, state] of this._activeSessions) {
			state.disposables.dispose();
		}
		this._activeSessions.clear();
		super.dispose();
	}
}
