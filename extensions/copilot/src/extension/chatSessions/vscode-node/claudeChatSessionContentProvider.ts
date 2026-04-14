/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ChatExtendedRequestHandler } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { INativeEnvService } from '../../../platform/env/common/envService';
import { IGitService } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { URI } from '../../../util/vs/base/common/uri';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { ClaudeFolderInfo } from '../claude/common/claudeFolderInfo';
import { ClaudeSessionUri } from '../claude/common/claudeSessionUri';
import { ClaudeAgentManager } from '../claude/node/claudeCodeAgent';
import { IClaudeCodeSdkService } from '../claude/node/claudeCodeSdkService';
import { parseClaudeModelId } from '../claude/node/claudeModelId';
import { IClaudeSessionStateService } from '../claude/common/claudeSessionStateService';
import { IClaudeCodeSessionService } from '../claude/node/sessionParser/claudeCodeSessionService';
import { IClaudeCodeSessionInfo } from '../claude/node/sessionParser/claudeSessionSchema';
import { IClaudeSlashCommandService } from '../claude/vscode-node/claudeSlashCommandService';
import { IChatSessionWorktreeService } from '../common/chatSessionWorktreeService';
import { IFolderRepositoryManager, IsolationMode } from '../common/folderRepositoryManager';
import { buildChatHistory } from './chatHistoryBuilder';
import { getSelectedSessionOptions, ISessionOptionGroupBuilder } from './sessionOptionGroupBuilder';

const permissionModes: ReadonlySet<string> = new Set<PermissionMode>(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk']);

function isPermissionMode(value: string): value is PermissionMode {
	return permissionModes.has(value);
}

// Import the tool permission handlers
import '../claude/vscode-node/toolPermissionHandlers/index';

// Import the MCP server contributors to trigger self-registration
import '../claude/vscode-node/mcpServers/index';

const PERMISSION_MODE_OPTION_ID = 'permissionMode';

export class ClaudeChatSessionContentProvider extends Disposable implements vscode.ChatSessionContentProvider {
	private readonly _onDidChangeChatSessionOptions = this._register(new Emitter<vscode.ChatSessionOptionChangeEvent>());
	readonly onDidChangeChatSessionOptions = this._onDidChangeChatSessionOptions.event;

	private readonly _onDidChangeChatSessionProviderOptions = this._register(new Emitter<void>());
	readonly onDidChangeChatSessionProviderOptions = this._onDidChangeChatSessionProviderOptions.event;

	// Track the most recently used permission mode across sessions for new session defaults
	private _lastUsedPermissionMode: PermissionMode = 'acceptEdits';

	private readonly _controller: ClaudeChatSessionItemController;

	/**
	 * Exposes the session item controller for lifecycle event subscription (e.g., archive/unarchive).
	 */
	get controller(): ClaudeChatSessionItemController {
		return this._controller;
	}

	constructor(
		private readonly claudeAgentManager: ClaudeAgentManager,
		@IClaudeCodeSessionService private readonly sessionService: IClaudeCodeSessionService,
		@IClaudeSessionStateService private readonly sessionStateService: IClaudeSessionStateService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IClaudeSlashCommandService private readonly slashCommandService: IClaudeSlashCommandService,
		@IFolderRepositoryManager private readonly folderRepositoryManager: IFolderRepositoryManager,
		@IChatSessionWorktreeService private readonly worktreeService: IChatSessionWorktreeService,
		@ISessionOptionGroupBuilder private readonly _optionGroupBuilder: ISessionOptionGroupBuilder,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@INativeEnvService private readonly envService: INativeEnvService,
		@IGitService private readonly gitService: IGitService,
		@IClaudeCodeSdkService sdkService: IClaudeCodeSdkService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._controller = this._register(new ClaudeChatSessionItemController(sessionService, workspaceService, gitService, sdkService, logService));

		// Listen for configuration changes to update available options
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ConfigKey.ClaudeAgentAllowDangerouslySkipPermissions.fullyQualifiedId)) {
				this._onDidChangeChatSessionProviderOptions.fire();
			}
		}));

		// Listen for workspace folder changes to update folder options
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this._onDidChangeChatSessionProviderOptions.fire();
		}));

		// Wire up the new input state API (dynamic dropdowns with locking support)
		this._initializeInputState();

		// Listen for state changes and notify UI only if value actually changed from local selection
		this._register(this.sessionStateService.onDidChangeSessionState(e => {
			const updates: { optionId: string; value: string }[] = [];
			const existingMode = this._controller.getMetadata(e.sessionId)?.permissionMode;
			if (e.permissionMode !== undefined && e.permissionMode !== existingMode) {
				updates.push({ optionId: PERMISSION_MODE_OPTION_ID, value: e.permissionMode });
			}

			if (updates.length > 0) {
				const resource = ClaudeSessionUri.forSessionId(e.sessionId);
				this._onDidChangeChatSessionOptions.fire({ resource, updates });
			}
		}));
	}

	// #region Input State (dynamic dropdown management)

	/**
	 * Wires up `getChatSessionInputState` on the underlying controller,
	 * delegating to `SessionOptionGroupBuilder` for dynamic dropdown groups
	 * (isolation, repository/folder, branch). This replaces the old
	 * `provideChatSessionProviderOptions` approach with proper support for
	 * locking dropdowns on first message and dynamic branch selection.
	 */
	private _initializeInputState(): void {
		const newInputStates: WeakRef<vscode.ChatSessionInputState>[] = [];
		const controller = this._controller.rawController;

		controller.getChatSessionInputState = async (sessionResource, context, token) => {
			const isExistingSession = sessionResource && await this.sessionService.getSession(sessionResource, token);
			if (isExistingSession) {
				const groups = await this._optionGroupBuilder.buildExistingSessionInputStateGroups(sessionResource, token);
				// Add permission mode group for existing sessions
				this._addPermissionModeGroup(groups, sessionResource, true);
				return controller.createChatSessionInputState(groups);
			} else {
				const groups = await this._optionGroupBuilder.provideChatSessionProviderOptionGroups(context.previousInputState);
				// Add permission mode group for new sessions
				this._addPermissionModeGroup(groups, undefined, false);
				const state = controller.createChatSessionInputState(groups);
				// Only wire dynamic updates for new sessions (existing sessions are fully locked).
				newInputStates.push(new WeakRef(state));
				state.onDidChange(() => {
					void this._optionGroupBuilder.handleInputStateChange(state);
				});
				return state;
			}
		};

		// Refresh new-session dropdown groups when git or workspace state changes
		const refreshActiveInputState = () => {
			// Sweep stale WeakRefs before iterating
			for (let i = newInputStates.length - 1; i >= 0; i--) {
				if (!newInputStates[i].deref()) {
					newInputStates.splice(i, 1);
				}
			}
			for (const weakRef of newInputStates) {
				const state = weakRef.deref();
				if (state) {
					void this._optionGroupBuilder.rebuildInputState(state);
				}
			}
		};
		this._register(this.gitService.onDidFinishInitialization(refreshActiveInputState));
		this._register(this.gitService.onDidOpenRepository(refreshActiveInputState));
		this._register(this.gitService.onDidCloseRepository(refreshActiveInputState));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(refreshActiveInputState));
	}

	/**
	 * Add the permission mode option group to an existing set of groups.
	 * Permission mode is Claude-specific and not managed by SessionOptionGroupBuilder.
	 */
	private _addPermissionModeGroup(groups: vscode.ChatSessionProviderOptionGroup[], sessionResource: vscode.Uri | undefined, locked: boolean): void {
		const permissionModeItems: vscode.ChatSessionProviderOptionItem[] = [
			{ id: 'default', name: l10n.t('Ask before edits'), icon: new vscode.ThemeIcon('shield') },
			{ id: 'acceptEdits', name: l10n.t('Edit automatically'), icon: new vscode.ThemeIcon('edit') },
			{ id: 'plan', name: l10n.t('Plan mode'), icon: new vscode.ThemeIcon('lightbulb') },
		];
		if (this.configurationService.getConfig(ConfigKey.ClaudeAgentAllowDangerouslySkipPermissions)) {
			permissionModeItems.push({ id: 'bypassPermissions', name: l10n.t('Bypass all permissions'), icon: new vscode.ThemeIcon('warning') });
		}

		let selectedMode: string;
		if (sessionResource) {
			const sessionId = ClaudeSessionUri.getSessionId(sessionResource);
			selectedMode = this.getPermissionModeForSession(sessionId);
		} else {
			selectedMode = this._lastUsedPermissionMode;
		}

		const selectedItem = permissionModeItems.find(item => item.id === selectedMode) ?? permissionModeItems[0];
		const selected = locked ? { ...selectedItem, locked: true } : selectedItem;

		groups.unshift({
			id: PERMISSION_MODE_OPTION_ID,
			name: l10n.t('Permission Mode'),
			description: l10n.t('Pick Permission Mode'),
			items: locked ? permissionModeItems.map(item => ({ ...item, locked: true })) : permissionModeItems,
			selected,
		});
	}

	// #endregion

	/**
	 * Gets the permission mode for a session
	 */
	public getPermissionModeForSession(sessionId: string): PermissionMode {
		return this._controller.getMetadata(sessionId)?.permissionMode ?? this.sessionStateService.getPermissionModeForSession(sessionId);
	}

	/**
	 * Resolves the cwd and additionalDirectories for a session.
	 *
	 * - If the session has a worktree, cwd is the worktree path
	 * - Single-root workspace: cwd is the one folder, no additionalDirectories
	 * - Multi-root workspace: cwd is the selected folder, additionalDirectories are the rest
	 * - Empty workspace: cwd is the selected MRU folder, no additionalDirectories
	 */
	public async getFolderInfoForSession(sessionId: string): Promise<ClaudeFolderInfo> {
		// Check if this session has a worktree — use it as cwd if so
		const worktreeProperties = await this.worktreeService.getWorktreeProperties(sessionId);
		if (worktreeProperties) {
			return {
				cwd: worktreeProperties.worktreePath,
				additionalDirectories: [],
			};
		}

		const workspaceFolders = this.workspaceService.getWorkspaceFolders();

		if (workspaceFolders.length === 1) {
			return {
				cwd: workspaceFolders[0].fsPath,
				additionalDirectories: [],
			};
		}

		// Multi-root or empty workspace: use the selected folder
		const selectedFolder = this._controller.getMetadata(sessionId)?.cwd;

		if (workspaceFolders.length > 1) {
			const cwd = selectedFolder?.fsPath ?? workspaceFolders[0].fsPath;
			const additionalDirectories = workspaceFolders
				.map(f => f.fsPath)
				.filter(p => p !== cwd);
			return { cwd, additionalDirectories };
		}

		// Empty workspace
		if (selectedFolder) {
			return {
				cwd: selectedFolder.fsPath,
				additionalDirectories: [],
			};
		}

		// Fallback for empty workspace with no selection: try MRU
		const mru = await this.folderRepositoryManager.getFolderMRU();
		if (mru.length > 0) {
			return {
				cwd: mru[0].folder.fsPath,
				additionalDirectories: [],
			};
		}

		// No folder available at all — fall back to the user's home directory
		return {
			cwd: this.envService.userHome.fsPath,
			additionalDirectories: [],
		};
	}

	/**
	 * Initializes a worktree for a new Claude session if isolation mode is 'worktree'.
	 * This must be called during request handling (where stream and toolInvocationToken are available).
	 *
	 * @returns `true` if the request should continue, `false` if it should abort
	 * (e.g., user cancelled the uncommitted-changes prompt or denied trust).
	 */
	private async _initializeWorktreeForNewSession(
		sessionId: string,
		stream: vscode.ChatResponseStream,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		token: vscode.CancellationToken
	): Promise<boolean> {
		const isolationMode = this._controller.getMetadata(sessionId)?.isolationMode;
		if (isolationMode !== IsolationMode.Worktree) {
			return true;
		}

		const selectedFolder = this._controller.getMetadata(sessionId)?.cwd;
		const workspaceFolders = this.workspaceService.getWorkspaceFolders();
		const folder = selectedFolder ?? (workspaceFolders.length === 1 ? workspaceFolders[0] : undefined);

		const folderInfo = await this.folderRepositoryManager.initializeFolderRepository(
			sessionId,
			{
				stream,
				toolInvocationToken,
				isolation: IsolationMode.Worktree,
				folder,
			},
			token
		);

		if (folderInfo.cancelled || folderInfo.trusted === false) {
			return false;
		}

		if (folderInfo.worktreeProperties) {
			await this.worktreeService.setWorktreeProperties(sessionId, folderInfo.worktreeProperties);
			this.logService.info(`[Claude] Created worktree for session ${sessionId}: ${folderInfo.worktreeProperties.worktreePath}`);
		}

		return true;
	}

	// #endregion

	// #region Chat Participant Handler

	createHandler(): ChatExtendedRequestHandler {
		return async (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult | void> => {
			const { chatSessionContext } = context;
			if (!chatSessionContext) {
				/* Via @claude */
				// TODO: Think about how this should work
				stream.markdown(vscode.l10n.t("Start a new Claude Agent session"));
				stream.button({ command: `workbench.action.chat.openNewSessionEditor.${ClaudeSessionUri.scheme}`, title: vscode.l10n.t("Start Session") });
				return {};
			}

			// Try to handle as a slash command first
			const slashResult = await this.slashCommandService.tryHandleCommand(request, stream, token);
			if (slashResult.handled) {
				return slashResult.result ?? {};
			}

			const effectiveSessionId = ClaudeSessionUri.getSessionId(chatSessionContext.chatSessionItem.resource);
			const yieldRequested = () => context.yieldRequested;

			// Determine whether this is a new session by checking if a session
			// already exists on disk via the session service.
			const sessionUri = ClaudeSessionUri.forSessionId(effectiveSessionId);
			const existingSession = await this.sessionService.getSession(sessionUri, token);
			const isNewSession = !existingSession;

			// Lock all dropdown groups on first message (prevents changing isolation/branch/folder mid-session)
			if (isNewSession) {
				this._optionGroupBuilder.lockInputStateGroups(chatSessionContext.inputState);
			}

			// Read selected options from input state (new API)
			const selectedOptions = getSelectedSessionOptions(chatSessionContext.inputState);
			const selectedPermissionMode = this._getPermissionModeFromInputState(chatSessionContext.inputState);

			// Store selected options in metadata for the session
			if (isNewSession) {
				const isolationMode = selectedOptions.isolation ?? IsolationMode.Worktree;
				const folder = selectedOptions.folder;
				this._controller.setMetadata(effectiveSessionId, {
					isolationMode,
					cwd: folder,
					permissionMode: selectedPermissionMode,
				});
				if (selectedPermissionMode) {
					this._lastUsedPermissionMode = selectedPermissionMode;
				}
			}

			// Initialize worktree for new sessions with worktree isolation
			if (isNewSession) {
				const shouldContinue = await this._initializeWorktreeForNewSession(effectiveSessionId, stream, request.toolInvocationToken, token);
				if (token.isCancellationRequested || !shouldContinue) {
					// Unlock dropdowns so the user can adjust and retry
					await this._optionGroupBuilder.rebuildInputState(chatSessionContext.inputState);
					return {};
				}
			}

			// Update branch in input state after worktree creation
			if (isNewSession) {
				const worktreeProperties = await this.worktreeService.getWorktreeProperties(effectiveSessionId);
				if (worktreeProperties?.branchName) {
					this._optionGroupBuilder.updateBranchInInputState(chatSessionContext.inputState, worktreeProperties.branchName);
				}
			}

			const modelId = parseClaudeModelId(request.model.id);
			const permissionMode = this.getPermissionModeForSession(effectiveSessionId);
			const folderInfo = await this.getFolderInfoForSession(effectiveSessionId);

			// Commit UI state to session state service before invoking agent manager
			this.sessionStateService.setModelIdForSession(effectiveSessionId, modelId);
			this.sessionStateService.setPermissionModeForSession(effectiveSessionId, permissionMode);
			this.sessionStateService.setFolderInfoForSession(effectiveSessionId, folderInfo);

			// Set usage handler to report token usage for context window widget
			this.sessionStateService.setUsageHandlerForSession(effectiveSessionId, (usage) => {
				stream.usage(usage);
			});

			const prompt = request.prompt;
			this._controller.updateItemStatus(effectiveSessionId, vscode.ChatSessionStatus.InProgress, prompt);
			const result = await this.claudeAgentManager.handleRequest(effectiveSessionId, request, context, stream, token, isNewSession, yieldRequested);
			this._controller.updateItemStatus(effectiveSessionId, vscode.ChatSessionStatus.Completed, prompt);

			// Auto-commit worktree changes after successful, non-cancelled turns
			if (!token.isCancellationRequested) {
				try {
					await this.worktreeService.handleRequestCompleted(effectiveSessionId);
				} catch (error) {
					this.logService.error(error instanceof Error ? error : new Error(String(error)), `[Claude] Failed to handle worktree request completion for session ${effectiveSessionId}`);
				}
			}

			// Clear usage handler after request completes
			this.sessionStateService.setUsageHandlerForSession(effectiveSessionId, undefined);

			return result.errorDetails ? { errorDetails: result.errorDetails } : {};
		};
	}

	/**
	 * Read the selected permission mode from the input state groups.
	 */
	private _getPermissionModeFromInputState(inputState: vscode.ChatSessionInputState): PermissionMode | undefined {
		const group = inputState.groups.find(g => g.id === PERMISSION_MODE_OPTION_ID);
		const selectedId = group?.selected?.id;
		if (selectedId && isPermissionMode(selectedId)) {
			return selectedId;
		}
		return undefined;
	}

	// #endregion

	async provideChatSessionContent(sessionResource: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const existingSession = await this.sessionService.getSession(sessionResource, token);
		const history = existingSession ?
			buildChatHistory(existingSession) :
			[];

		return {
			title: existingSession?.label,
			history,
			activeResponseCallback: undefined,
			requestHandler: undefined,
		};
	}

}

/**
 * Chat session item controller wrapper for Claude Agent.
 * Reads sessions from ~/.claude/projects/<folder-slug>/, where each file name is a session id (GUID).
 */
export class ClaudeChatSessionItemController extends Disposable {
	private readonly _controller: vscode.ChatSessionItemController;
	private readonly _inProgressItems = new Map<string, vscode.ChatSessionItem>();
	private _showBadge: boolean;

	/**
	 * Fired when an item's archived state changes.
	 */
	get onDidChangeChatSessionItemState() {
		return this._controller.onDidChangeChatSessionItemState;
	}

	/**
	 * Exposes the underlying controller for input state API wiring.
	 */
	get rawController(): vscode.ChatSessionItemController {
		return this._controller;
	}

	constructor(
		@IClaudeCodeSessionService private readonly _claudeCodeSessionService: IClaudeCodeSessionService,
		@IWorkspaceService private readonly _workspaceService: IWorkspaceService,
		@IGitService private readonly _gitService: IGitService,
		@IClaudeCodeSdkService private readonly _sdkService: IClaudeCodeSdkService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._registerCommands();
		this._controller = this._register(vscode.chat.createChatSessionItemController(
			ClaudeSessionUri.scheme,
			() => this._refreshItems(CancellationToken.None)
		));

		this._controller.newChatSessionItemHandler = async (context, _token) => {
			const newSessionId = generateUuid();
			const item = this._controller.createChatSessionItem(
				ClaudeSessionUri.forSessionId(newSessionId),
				context.request.prompt,
			);
			item.iconPath = new vscode.ThemeIcon('claude');
			item.timing = { created: Date.now() };
			// Metadata (permissionMode, cwd, isolationMode) is set by the request handler
			// when it reads from inputState — no need to read from sessionOptions here.
			this._controller.items.add(item);
			return item;
		};

		this._controller.forkHandler = async (sessionResource: vscode.Uri, request: vscode.ChatRequestTurn2 | undefined, token: CancellationToken): Promise<vscode.ChatSessionItem> => {
			const item = this._controller.items.get(sessionResource);
			const title = vscode.l10n.t('Forked: {0}', item?.label ?? request?.prompt ?? 'Claude Session');

			// Fork whole history if no request specified
			let upToMessageId: string | undefined = undefined;
			if (request) {
				// we need to get the message right before the `request`
				const session = await this._claudeCodeSessionService.getSession(sessionResource, token);
				if (!session) {
					// This shouldn't happen
					this._logService.error(`Failed to fork session: session not found for resource ${sessionResource.toString()}`);
					throw new Error('Unable to fork: session not found.');
				} else {
					const messageIndex = session.messages.findIndex(m => m.uuid === request.id);
					if (messageIndex === -1) {
						this._logService.error(`Failed to fork session: request with id ${request.id} not found in session ${sessionResource.toString()}`);
						throw new Error('Unable to fork: the selected message could not be found.');
					}
					if (messageIndex === 0) {
						this._logService.error(`Failed to fork session: cannot fork at the first message`);
						throw new Error('Cannot fork from the first message.');
					}
					const forkMessage = session.messages[messageIndex - 1];
					upToMessageId = forkMessage.uuid;
				}
			}
			const result = await this._sdkService.forkSession(
				ClaudeSessionUri.getSessionId(sessionResource),
				{ upToMessageId, title }
			);
			const newItem = this._controller.createChatSessionItem(ClaudeSessionUri.forSessionId(result.sessionId), title);
			newItem.iconPath = new vscode.ThemeIcon('claude');
			newItem.timing = { created: Date.now() };
			newItem.metadata = item?.metadata ? { ...item.metadata } : undefined;
			this._controller.items.add(newItem);
			return newItem;
		};

		this._showBadge = this._computeShowBadge();

		// Refresh session items and recompute badge when repositories change.
		// _computeShowBadge() reads gitService.repositories synchronously, which
		// may be incomplete while the git extension is still initializing.
		this._register(_gitService.onDidOpenRepository(() => {
			this._showBadge = this._computeShowBadge();
			void this._refreshItems(CancellationToken.None);
		}));
		this._register(_gitService.onDidCloseRepository(() => {
			this._showBadge = this._computeShowBadge();
			void this._refreshItems(CancellationToken.None);
		}));
	}

	setMetadata(sessionId: string, metadata: Partial<{ permissionMode: PermissionMode; cwd?: URI; isolationMode?: IsolationMode }>): void {
		const item = this._controller.items.get(ClaudeSessionUri.forSessionId(sessionId));
		if (item) {
			item.metadata = {
				...item.metadata,
				permissionMode: metadata.permissionMode ?? item.metadata?.permissionMode,
				cwd: metadata.cwd ?? item.metadata?.cwd,
				isolationMode: metadata.isolationMode ?? item.metadata?.isolationMode,
			};
		}
	}

	getMetadata(sessionId: string): { permissionMode?: PermissionMode; cwd?: URI; isolationMode?: IsolationMode } | undefined {
		const candidate = this._controller.items.get(ClaudeSessionUri.forSessionId(sessionId));
		if (candidate) {
			if (candidate.metadata?.permissionMode !== undefined && !isPermissionMode(candidate.metadata.permissionMode)) {
				this._logService.warn(`Invalid permission mode "${candidate.metadata?.permissionMode}" found in metadata for session ${sessionId}. Falling back to default.`);
				candidate.metadata = {
					permissionMode: 'acceptEdits',
					cwd: candidate.metadata?.cwd,
					isolationMode: candidate.metadata?.isolationMode,
				};
			}
			if (candidate.metadata?.cwd && !(URI.isUri(candidate.metadata.cwd))) {
				this._logService.warn(`Invalid cwd "${candidate.metadata.cwd}" found in metadata for session ${sessionId}. Ignoring.`);
				candidate.metadata = {
					permissionMode: candidate.metadata.permissionMode,
					cwd: undefined,
					isolationMode: candidate.metadata?.isolationMode,
				};
			}
			return {
				permissionMode: candidate.metadata?.permissionMode,
				cwd: candidate.metadata?.cwd,
				isolationMode: candidate.metadata?.isolationMode,
			};
		}
	}

	updateItemLabel(sessionId: string, label: string): void {
		const resource = ClaudeSessionUri.forSessionId(sessionId);
		const item = this._controller.items.get(resource);
		if (item) {
			item.label = label;
		}
	}

	async updateItemStatus(sessionId: string, status: vscode.ChatSessionStatus, newItemLabel: string): Promise<void> {
		const resource = ClaudeSessionUri.forSessionId(sessionId);
		let item = this._controller.items.get(resource);
		if (!item) {
			const session = await this._claudeCodeSessionService.getSession(resource, CancellationToken.None);
			if (session) {
				item = this._createClaudeChatSessionItem(session);
			} else {
				const newlyCreatedSessionInfo: IClaudeCodeSessionInfo = {
					id: sessionId,
					label: newItemLabel,
					created: Date.now(),
					lastRequestEnded: Date.now(),
					folderName: undefined
				};
				item = this._createClaudeChatSessionItem(newlyCreatedSessionInfo);
			}

			this._controller.items.add(item);
		}

		item.status = status;
		if (status === vscode.ChatSessionStatus.InProgress) {
			const timing = item.timing ? { ...item.timing } : { created: Date.now() };
			timing.lastRequestStarted = Date.now();
			// Clear lastRequestEnded while a request is in progress
			timing.lastRequestEnded = undefined;
			item.timing = timing;
			this._inProgressItems.set(sessionId, item);
		} else {
			this._inProgressItems.delete(sessionId);
			if (status === vscode.ChatSessionStatus.Completed) {
				if (!item.timing) {
					item.timing = {
						created: Date.now(),
						lastRequestEnded: Date.now()
					};
				} else {
					item.timing = { ...item.timing, lastRequestEnded: Date.now() };
				}
			}
		}
	}

	private async _refreshItems(token: vscode.CancellationToken): Promise<void> {
		const sessions = await this._claudeCodeSessionService.getAllSessions(token);
		const items = sessions.map(session => this._createClaudeChatSessionItem(session));
		items.push(...this._inProgressItems.values());
		this._controller.items.replace(items);
	}

	private _createClaudeChatSessionItem(session: IClaudeCodeSessionInfo): vscode.ChatSessionItem {
		let badge: vscode.MarkdownString | undefined;
		if (session.folderName && this._showBadge) {
			badge = new vscode.MarkdownString(`$(folder) ${session.folderName}`);
			badge.supportThemeIcons = true;
		}

		const item = this._controller.createChatSessionItem(ClaudeSessionUri.forSessionId(session.id), session.label);
		item.badge = badge;
		item.tooltip = `Claude Code session: ${session.label}`;
		item.timing = {
			created: session.created,
			lastRequestStarted: session.lastRequestStarted,
			lastRequestEnded: session.lastRequestEnded,
		};
		item.iconPath = new vscode.ThemeIcon('claude');
		item.metadata = {
			// Allow it to be set when opened
			permissionMode: undefined,
			cwd: session.cwd ? URI.file(session.cwd) : undefined
		};
		return item;
	}

	private _computeShowBadge(): boolean {
		const workspaceFolders = this._workspaceService.getWorkspaceFolders();
		if (workspaceFolders.length === 0) {
			return true; // Empty window
		}
		if (workspaceFolders.length > 1) {
			return true; // Multi-root workspace
		}

		// Single-root workspace with multiple git repositories
		const repositories = this._gitService.repositories
			.filter(repository => repository.kind !== 'worktree');
		return repositories.length > 1;
	}

	private _registerCommands(): void {
		this._register(vscode.commands.registerCommand('github.copilot.claude.sessions.rename', async (sessionItem?: vscode.ChatSessionItem) => {
			if (!sessionItem?.resource) {
				return;
			}

			const sessionId = ClaudeSessionUri.getSessionId(sessionItem.resource);
			const newTitle = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('New agent session title'),
				value: sessionItem.label,
				validateInput: value => {
					if (!value.trim()) {
						return vscode.l10n.t('Title cannot be empty');
					}
					return undefined;
				}
			});

			if (newTitle) {
				const trimmedTitle = newTitle.trim();
				if (trimmedTitle) {
					try {
						await this._sdkService.renameSession(sessionId, trimmedTitle);
						this.updateItemLabel(sessionId, trimmedTitle);
					} catch (e) {
						this._logService.error(e, `[ClaudeChatSessionItemController] Failed to rename session: ${sessionId}`);
					}
				}
			}
		}));
	}
}
