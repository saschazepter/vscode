/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { ChatViewId } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatSessionItem, IChatSessionProviderOptionItem, IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ChatViewPane } from '../../../../workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.js';
import { IAgentSession } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsModel.js';
import { IAgentSessionsService } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';

//#region Active Session Service

const LAST_SELECTED_SESSION_KEY = 'agentSessions.lastSelectedSession';
const repositoryOptionId = 'repository';

/**
 * An active session item extends IChatSessionItem with repository information.
 * - For agent session items: repository is the workingDirectory from metadata
 * - For new sessions: repository comes from the session option with id 'repository'
 */
export type IActiveSessionItem = (IChatSessionItem | IAgentSession) & {
	/**
	 * The repository URI for this session.
	 */
	readonly repository: URI | undefined;

	/**
	 * The worktree URI for this session.
	 */
	readonly worktree: URI | undefined;
};

export interface IActiveSessionService {
	readonly _serviceBrand: undefined;

	/**
	 * Observable for the currently active session.
	 */
	readonly activeSession: IObservable<IActiveSessionItem | undefined>;

	/**
	 * Returns the currently active session, if any.
	 */
	getActiveSession(): IActiveSessionItem | undefined;
}

export const IActiveSessionService = createDecorator<IActiveSessionService>('activeSessionService');

export class ActiveSessionService extends Disposable implements IActiveSessionService {

	declare readonly _serviceBrand: undefined;

	private readonly _activeSession = observableValue<IActiveSessionItem | undefined>(this, undefined);
	readonly activeSession: IObservable<IActiveSessionItem | undefined> = this._activeSession;

	private lastSelectedSession: URI | undefined;
	private readonly widgetTrackingStore = this._register(new DisposableStore());

	constructor(
		@IViewsService private readonly viewsService: IViewsService,
		@IStorageService private readonly storageService: IStorageService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Load last selected session
		this.lastSelectedSession = this.loadLastSelectedSession();

		// Track the active session from the ChatBar's ChatViewPane widget
		this.registerChatBarWidgetTracking();

		// Save on shutdown
		this._register(this.storageService.onWillSaveState(() => {
			this.saveLastSelectedSession();
		}));

		// Update active session when session options change
		this._register(this.chatSessionsService.onDidChangeSessionOptions(sessionResource => {
			const currentActive = this._activeSession.get();
			if (currentActive && currentActive.resource.toString() === sessionResource.toString()) {
				// Re-fetch the repository from session options and update the active session
				const repository = this.getRepositoryFromSessionOption(sessionResource);
				if (currentActive.repository?.toString() !== repository?.toString()) {
					this._activeSession.set({ ...currentActive, repository }, undefined);
				}
			}
		}));

		// Update active session when the agent sessions model changes (e.g., metadata updates with worktree/repository info)
		this._register(this.agentSessionsService.model.onDidChangeSessions(() => {
			this.refreshActiveSessionFromModel();
		}));
	}

	private registerChatBarWidgetTracking(): void {
		// Try to get the ChatViewPane
		const chatViewPane = this.viewsService.getViewWithId<ChatViewPane>(ChatViewId);
		if (chatViewPane) {
			this.trackChatViewPaneWidget(chatViewPane);
		}

		// Also listen for view visibility changes to catch when the view becomes available
		this._register(this.viewsService.onDidChangeViewVisibility(e => {
			if (e.id === ChatViewId && e.visible) {
				const viewPane = this.viewsService.getViewWithId<ChatViewPane>(ChatViewId);
				if (viewPane) {
					this.trackChatViewPaneWidget(viewPane);
				}
			}
		}));
	}

	private trackChatViewPaneWidget(chatViewPane: ChatViewPane): void {
		// Clear previous tracking
		this.widgetTrackingStore.clear();

		const widget = chatViewPane.widget;
		if (!widget) {
			return;
		}

		// Set initial session from current widget state
		this.updateActiveSessionFromWidget(widget);

		// Listen to model changes on the widget
		this.widgetTrackingStore.add(widget.onDidChangeViewModel(() => {
			this.updateActiveSessionFromWidget(widget);
		}));
	}

	private updateActiveSessionFromWidget(widget: ChatViewPane['widget']): void {
		const viewModel = widget.viewModel;
		if (!viewModel?.sessionResource) {
			return;
		}

		const sessionResource = viewModel.sessionResource;
		this.lastSelectedSession = sessionResource;

		// Try to get the full session from the model first
		const agentSession = this.agentSessionsService.model.getSession(sessionResource);
		if (agentSession) {
			// For agent sessions, get repository from metadata.workingDirectory
			const [repository, worktree] = this.getRepositoryFromMetadata(agentSession.metadata);
			const activeSessionItem: IActiveSessionItem = {
				...agentSession,
				repository,
				worktree,
			};
			this.logService.info(`[ActiveSessionService] Active session changed: ${sessionResource.toString()}, repository: ${repository?.toString() ?? 'none'}`);
			this._activeSession.set(activeSessionItem, undefined);
		} else {
			// For new/empty sessions not yet in the model, get repository from session option
			const repository = this.getRepositoryFromSessionOption(sessionResource);
			const activeSessionItem: IActiveSessionItem = {
				resource: sessionResource,
				label: viewModel.model.title || '',
				timing: viewModel.model.timing,
				repository,
				worktree: undefined
			};
			this.logService.info(`[ActiveSessionService] Active session changed (new): ${sessionResource.toString()}, repository: ${repository?.toString() ?? 'none'}`);
			this._activeSession.set(activeSessionItem, undefined);
		}
	}

	private refreshActiveSessionFromModel(): void {
		const currentActive = this._activeSession.get();
		if (!currentActive) {
			return;
		}

		const agentSession = this.agentSessionsService.model.getSession(currentActive.resource);
		if (!agentSession) {
			return;
		}

		const [repository, worktree] = this.getRepositoryFromMetadata(agentSession.metadata);
		if (currentActive.repository?.toString() !== repository?.toString() || currentActive.worktree?.toString() !== worktree?.toString()) {
			const activeSessionItem: IActiveSessionItem = {
				...agentSession,
				repository,
				worktree,
			};
			this.logService.info(`[ActiveSessionService] Active session updated from model: ${currentActive.resource.toString()}, repository: ${repository?.toString() ?? 'none'}, worktree: ${worktree?.toString() ?? 'none'}`);
			this._activeSession.set(activeSessionItem, undefined);
		}
	}

	private getRepositoryFromMetadata(metadata: { readonly [key: string]: unknown } | undefined): [URI | undefined, URI | undefined] {
		if (!metadata) {
			return [undefined, undefined];
		}

		const repositoryPath = metadata?.repositoryPath as string | undefined;
		const repositoryPathUri = typeof repositoryPath === 'string' ? URI.file(repositoryPath) : undefined;

		const worktreePath = metadata?.worktreePath as string | undefined;
		const worktreePathUri = typeof worktreePath === 'string' ? URI.file(worktreePath) : undefined;

		return [
			URI.isUri(repositoryPathUri) ? repositoryPathUri : undefined,
			URI.isUri(worktreePathUri) ? worktreePathUri : undefined];
	}

	private getRepositoryFromSessionOption(sessionResource: URI): URI | undefined {
		const optionValue = this.chatSessionsService.getSessionOption(sessionResource, repositoryOptionId);
		if (!optionValue) {
			return undefined;
		}

		// Option value can be a string or IChatSessionProviderOptionItem
		const optionId = typeof optionValue === 'string' ? optionValue : (optionValue as IChatSessionProviderOptionItem).id;
		if (!optionId) {
			return undefined;
		}

		try {
			return URI.parse(optionId);
		} catch {
			return undefined;
		}
	}

	getActiveSession(): IActiveSessionItem | undefined {
		return this._activeSession.get();
	}

	private loadLastSelectedSession(): URI | undefined {
		const cached = this.storageService.get(LAST_SELECTED_SESSION_KEY, StorageScope.WORKSPACE);
		if (!cached) {
			return undefined;
		}

		try {
			return URI.parse(cached);
		} catch {
			return undefined;
		}
	}

	private saveLastSelectedSession(): void {
		if (this.lastSelectedSession) {
			this.storageService.store(LAST_SELECTED_SESSION_KEY, this.lastSelectedSession.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
	}
}

//#endregion
