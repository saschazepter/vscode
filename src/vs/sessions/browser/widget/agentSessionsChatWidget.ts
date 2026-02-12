/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentSessionsChatWidget.css';
import { Disposable, DisposableStore, IReference, MutableDisposable } from '../../../base/common/lifecycle.js';
import * as dom from '../../../base/browser/dom.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IAgentChatTargetConfig, IAgentChatTargetConfigOptions, AgentSessionsChatTargetConfig } from './agentSessionsChatTargetConfig.js';
import { AgentSessionProviders } from '../../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';
import { ChatSessionPosition, getResourceForNewChatSession } from '../../../workbench/contrib/chat/browser/chatSessions/chatSessions.contribution.js';
import { ChatWidget, IChatWidgetStyles } from '../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { AgentSessionsChatWelcomePart, IAgentSessionsWelcomePartOptions } from '../parts/agentSessionsChatWelcomePart.js';
import { IChatModel, IChatResponseModel } from '../../../workbench/contrib/chat/common/model/chatModel.js';
import { IChatAcceptInputOptions, IChatWidgetViewContext, IChatWidgetViewOptions } from '../../../workbench/contrib/chat/browser/chat.js';
import { ChatAgentLocation, ChatModeKind } from '../../../workbench/contrib/chat/common/constants.js';
import { IChatService } from '../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatSessionProviderOptionGroup, IChatSessionsService } from '../../../workbench/contrib/chat/common/chatSessionsService.js';
import { OpenModelPickerAction, OpenModePickerAction, OpenSessionTargetPickerAction } from '../../../workbench/contrib/chat/browser/actions/chatExecuteActions.js';
import { ConfigureToolsAction } from '../../../workbench/contrib/chat/browser/actions/chatToolActions.js';

/**
 * Options specific to the AgentChatWidget.
 */
export interface IAgentChatWidgetOptions {
	/**
	 * Target configuration options. The widget creates and owns the
	 * `AgentSessionsChatTargetConfig` instance from these options.
	 */
	readonly targetConfig: IAgentChatTargetConfigOptions;

	/**
	 * Called after a session is created on first send.
	 * Allows consumers to react (e.g., navigate to the session in the chat panel).
	 */
	readonly onSessionCreated?: (sessionResource: URI, target: AgentSessionProviders) => void;

	/**
	 * The chat session position used when creating resources (sidebar vs editor).
	 * Defaults to `ChatSessionPosition.Sidebar`.
	 */
	readonly sessionPosition?: ChatSessionPosition;

	/**
	 * When true, renders a welcome view with mascot, target buttons, and option
	 * pickers when the chat is empty. The input is placed inside the welcome
	 * view's input slot for a centered layout.
	 */
	readonly showFullWelcome?: boolean;

	/**
	 * Maximum number of sessions to display in the welcome part's sessions grid.
	 * Only used when `showFullWelcome` is true.
	 */
	readonly maxSessions?: number;
}

/**
 * A chat widget that supports deferred session creation and target restriction.
 *
 * Unlike `ChatWidget`, this widget does not require a session to exist at construction time.
 * Instead, the session is created lazily when the user first sends a message.
 *
 * The widget manages target selection through `IAgentChatTargetConfig`, which:
 * - Specifies which targets are available (restrictable at creation, modifiable at runtime)
 * - Tracks the currently selected target
 * - Does not trigger any session creation when the target changes
 *
 * On first send:
 * 1. The selected target is read from the target config
 * 2. A session resource is created for that target type
 * 3. The session is loaded/started via the chat service
 * 4. The session model is attached to the underlying ChatWidget
 * 5. The message is sent through the normal ChatWidget flow
 *
 * After the first send, subsequent sends go through the normal ChatWidget path
 * since a session already exists.
 */
export class AgentSessionsChatWidget extends Disposable {

	private readonly _chatWidget: ChatWidget;
	private readonly _targetConfig: IAgentChatTargetConfig;
	private readonly _agentOptions: IAgentChatWidgetOptions;
	private readonly _contentDisposables = this._register(new DisposableStore());
	private readonly _welcomePart = this._register(new MutableDisposable<AgentSessionsChatWelcomePart>());

	private _welcomeContainer: HTMLElement | undefined;
	private _mainInputContainer: HTMLElement | undefined;
	private _chatModelRef: IReference<IChatModel> | undefined;
	private _sessionCreated = false;

	private readonly _onDidCreateSession = this._register(new Emitter<{ sessionResource: URI; target: AgentSessionProviders }>());
	readonly onDidCreateSession = this._onDidCreateSession.event;

	get chatWidget(): ChatWidget {
		return this._chatWidget;
	}

	get targetConfig(): IAgentChatTargetConfig {
		return this._targetConfig;
	}

	private static readonly _CACHED_OPTION_GROUPS_KEY = 'agentSessionsWidget.cachedOptionGroups';

	constructor(
		private readonly location: ChatAgentLocation,
		viewContext: IChatWidgetViewContext,
		viewOptions: IChatWidgetViewOptions,
		agentOptions: IAgentChatWidgetOptions,
		styles: IChatWidgetStyles,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatService private readonly chatService: IChatService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
	) {
		super();

		// Create and own the target config from the provided options
		this._targetConfig = this._register(new AgentSessionsChatTargetConfig(agentOptions.targetConfig, this.chatSessionsService));
		this._agentOptions = agentOptions;

		// Seed the service with cached option groups so pickers render
		// immediately before extensions activate. The extension will
		// overwrite them once it loads.
		this._loadCachedOptionGroups();

		// Persist option groups whenever extensions update them
		this._register(this.chatSessionsService.onDidChangeOptionGroups(sessionType => {
			this._persistOptionGroups(sessionType);
		}));

		// Bridge target config changes → sessionTypePickerDelegate so the
		// ChatInputPart refreshes its option groups when the target changes.
		const originalDelegate = viewOptions.sessionTypePickerDelegate;
		if (originalDelegate) {
			this._register(this._targetConfig.onDidChangeSelectedTarget(target => {
				if (target !== undefined && originalDelegate.setActiveSessionProvider) {
					originalDelegate.setActiveSessionProvider(target);
				}
			}));
		}

		// Wire up the submit handler to intercept sends and create sessions lazily
		const originalSubmitHandler = viewOptions.submitHandler;

		// When showing the full welcome, hide pickers that the welcome part handles:
		// - Target picker (Local/Cloud buttons rendered in welcome)
		// - Mode picker, model picker, tools config (rendered in welcome)
		// Repository/folder option groups are excluded from ChatSessionPrimaryPicker
		// via excludeOptionGroup, since they're rendered in the welcome part above.
		const hiddenPickerIds = agentOptions.showFullWelcome
			? new Set([
				OpenSessionTargetPickerAction.ID,
				ConfigureToolsAction.ID,
				OpenModePickerAction.ID,
				OpenModelPickerAction.ID,
			])
			: viewOptions.hiddenPickerIds;

		const excludeOptionGroup = agentOptions.showFullWelcome
			? (group: { id: string; name: string }) => {
				const idLower = group.id.toLowerCase();
				const nameLower = group.name.toLowerCase();
				return idLower === 'repositories' || idLower === 'folders' ||
					nameLower === 'repository' || nameLower === 'repositories' ||
					nameLower === 'folder' || nameLower === 'folders' ||
					idLower === 'branch' || nameLower === 'branch';
			}
			: viewOptions.excludeOptionGroup;

		// Wrap the session type picker delegate to include allowed targets
		// from the target config, so the delegation picker (Continue In)
		// only shows targets that are in the allowed set.
		const wrappedSessionTypePickerDelegate = viewOptions.sessionTypePickerDelegate
			? {
				...viewOptions.sessionTypePickerDelegate,
				allowedTargets: this._targetConfig.allowedTargets.get(),
			}
			: undefined;

		const wrappedViewOptions: IChatWidgetViewOptions = {
			...viewOptions,
			hiddenPickerIds,
			excludeOptionGroup,
			sessionTypePickerDelegate: wrappedSessionTypePickerDelegate,
			submitHandler: async (query: string, mode: ChatModeKind) => {
				if (originalSubmitHandler) {
					const handled = await originalSubmitHandler(query, mode);
					if (handled) {
						return true;
					}
				}

				if (!this._sessionCreated) {
					// Creating the session calls setModel() which syncs the input
					// from the new (empty) model state, clearing whatever the user
					// typed. Restore it afterwards so the text reaches sendRequest.
					await this._createSessionForCurrentTarget();
					this._chatWidget.setInput(query);
				}

				return false;
			},
		};

		this._chatWidget = this._register(this.instantiationService.createInstance(
			ChatWidget,
			location,
			viewContext,
			wrappedViewOptions,
			styles,
		));

		// Patch the inner ChatWidget's acceptInput so that when the send
		// button (ChatSubmitAction) calls it directly, we:
		// 1. Create the session (if not yet created)
		// 2. Attach pending option selections to the session context so the
		//    extension receives them atomically with the request
		const originalAcceptInput = this._chatWidget.acceptInput.bind(this._chatWidget);
		this._chatWidget.acceptInput = async (query?: string, options?: IChatAcceptInputOptions) => {
			// Capture the input text before session creation, because
			// _createSessionForCurrentTarget → setModel → setInputModel
			// syncs from the new (empty) model state and clears the editor.
			const capturedInput = query ?? this._chatWidget.getInput();

			if (!this._sessionCreated) {
				await this._createSessionForCurrentTarget();
			}

			// Gather all option selections and attach to the contributed session
			// so the extension receives them atomically with the first request.
			const model = this._chatWidget.viewModel?.model;
			const contributedSession = model?.contributedChatSession;
			if (model && contributedSession) {
				const allOptions = this._gatherAllOptionSelections();
				if (allOptions && allOptions.length > 0) {
					model.setContributedChatSession({
						...contributedSession,
						initialSessionOptions: allOptions,
					});
				}
			}

			return originalAcceptInput(capturedInput, options);
		};

		// Toggle welcome/conversation view when empty state changes
		this._register(this._chatWidget.onDidChangeEmptyState(() => {
			this._updateWelcomeVisibility();
		}));
	}

	/**
	 * Gathers all option selections from every source:
	 * 1. Welcome part pickers (repository/folder, managed by AgentSessionsChatWelcomePart)
	 * 2. Input toolbar pickers (model, etc., cached in ChatInputPart._pendingOptionSelections)
	 *
	 * Returns a merged array with no duplicates (input toolbar wins over welcome part).
	 */
	private _gatherAllOptionSelections(): ReadonlyArray<{ optionId: string; value: string | { id: string; name: string } }> | undefined {
		const merged = new Map<string, string | { id: string; name: string }>();

		// 1. Welcome part selections (repository/folder pickers - includes defaults)
		if (this._welcomePart.value) {
			for (const [optionId, value] of this._welcomePart.value.getSelectedSessionOptions()) {
				merged.set(optionId, value);
			}
		}

		// 2. Input toolbar selections (model, etc.) - higher priority
		const inputSelections = this._chatWidget.input.takePendingOptionSelections();
		if (inputSelections) {
			for (const { optionId, value } of inputSelections) {
				merged.set(optionId, value);
			}
		}

		if (merged.size === 0) {
			return undefined;
		}

		return [...merged.entries()].map(([optionId, value]) => ({ optionId, value }));
	}

	// --- Session creation ---

	private async _createSessionForCurrentTarget(): Promise<void> {
		const target = this._targetConfig.selectedTarget.get();
		if (!target) {
			this.logService.warn('AgentChatWidget: No target selected, cannot create session');
			return;
		}

		const position = this._agentOptions.sessionPosition ?? ChatSessionPosition.Sidebar;

		try {
			const resource = getResourceForNewChatSession({
				type: target,
				position,
				displayName: '',
			});

			if (target === AgentSessionProviders.Local) {
				this._chatModelRef = this.chatService.startSession(this.location);
			} else {
				const ref = await this.chatService.loadSessionForResource(resource, this.location, CancellationToken.None);
				this._chatModelRef = ref ?? this.chatService.startSession(this.location);
			}

			this._contentDisposables.add(this._chatModelRef);

			if (this._chatModelRef.object) {
				this._chatWidget.setModel(this._chatModelRef.object);
				this._sessionCreated = true;

				const sessionResource = this._chatModelRef.object.sessionResource;
				this._onDidCreateSession.fire({ sessionResource, target });
				this._agentOptions.onSessionCreated?.(sessionResource, target);
			}
		} catch (e) {
			this.logService.error('AgentChatWidget: Failed to create session', e);
		}
	}

	// --- Rendering ---

	render(container: HTMLElement): void {
		this._chatWidget.render(container);

		if (this._agentOptions.showFullWelcome) {
			this._createWelcomeView();
			this._updateWelcomeVisibility();
		}
	}

	/**
	 * Creates the welcome view using `AgentSessionsChatWelcomePart`.
	 * The welcome view renders mascot, target buttons, and option pickers
	 * with an input slot. The chat input is placed inside the input slot
	 * so it appears centered with the welcome content.
	 *
	 * When the chat has items, the welcome hides and the input moves to
	 * the main input container at the bottom of the session area.
	 */
	private _createWelcomeView(): void {
		const sessionContainer = this._chatWidget.domNode;

		// Welcome container - wraps the welcome part element
		this._welcomeContainer = dom.$('.agent-chat-welcome-container');

		// Create the welcome part (mascot + pickers + inputSlot)
		const welcomePartOptions: IAgentSessionsWelcomePartOptions = {
			targetConfig: this._targetConfig,
			getSessionResource: () => this._chatWidget.viewModel?.sessionResource,
			maxSessions: this._agentOptions.maxSessions,
		};
		this._welcomePart.value = this.instantiationService.createInstance(
			AgentSessionsChatWelcomePart,
			welcomePartOptions,
		);
		dom.append(this._welcomeContainer, this._welcomePart.value.element);

		// Main input container - used in conversation mode when welcome is hidden
		this._mainInputContainer = dom.$('.agent-chat-main-input-container');
		dom.setVisibility(false, this._mainInputContainer);

		// Insert welcome at the start, main input at the end
		sessionContainer.insertBefore(this._welcomeContainer, sessionContainer.firstChild);
		sessionContainer.appendChild(this._mainInputContainer);

		// Move the input into the welcome's input slot initially
		const inputElement = this._chatWidget.input.element;
		this._welcomePart.value.inputSlot.appendChild(inputElement);
	}

	/**
	 * Toggles between welcome view (empty chat) and conversation view (has items).
	 * Moves the input element between the welcome's inputSlot and the main container.
	 */
	private _updateWelcomeVisibility(): void {
		if (!this._welcomeContainer || !this._welcomePart.value || !this._mainInputContainer) {
			return;
		}

		const isEmpty = this._chatWidget.isEmpty();

		// Show/hide the welcome overlay
		dom.setVisibility(isEmpty, this._welcomeContainer);

		// Hide the standard welcome message if ChatWidget created one
		// eslint-disable-next-line no-restricted-syntax
		const standardWelcome = this._chatWidget.domNode.querySelector('.chat-welcome-view-container') as HTMLElement | null;
		if (standardWelcome) {
			dom.setVisibility(false, standardWelcome);
		}

		const inputElement = this._chatWidget.input.element;
		if (isEmpty) {
			// Move input into welcome's inputSlot
			if (inputElement.parentElement !== this._welcomePart.value.inputSlot) {
				this._welcomePart.value.inputSlot.appendChild(inputElement);
			}
			dom.setVisibility(false, this._mainInputContainer);
		} else {
			// Move input to main container for conversation view
			if (inputElement.parentElement !== this._mainInputContainer) {
				this._mainInputContainer.appendChild(inputElement);
			}
			dom.setVisibility(true, this._mainInputContainer);
		}
	}

	// --- Proxy ChatWidget methods ---

	layout(height: number, width: number): void {
		this._chatWidget.layout(height, width);
	}

	setVisible(visible: boolean): void {
		this._chatWidget.setVisible(visible);
	}

	focusInput(): void {
		this._chatWidget.focusInput();
	}

	setInput(query: string): void {
		this._chatWidget.setInput(query);
	}

	getInput(): string {
		return this._chatWidget.getInput();
	}

	async acceptInput(query?: string, options?: IChatAcceptInputOptions): Promise<IChatResponseModel | undefined> {
		return this._chatWidget.acceptInput(query, options);
	}

	get input() {
		return this._chatWidget.input;
	}

	get viewModel() {
		return this._chatWidget.viewModel;
	}

	get onDidAcceptInput(): Event<void> {
		return this._chatWidget.onDidAcceptInput;
	}

	get onDidChangeViewModel() {
		return this._chatWidget.onDidChangeViewModel;
	}

	get domNode() {
		return this._chatWidget.domNode;
	}

	resetSession(): void {
		this._chatWidget.setModel(undefined);
		this._chatModelRef?.dispose();
		this._chatModelRef = undefined;
		this._sessionCreated = false;

		// Clear pending option selections from the previous session
		this._chatWidget.input.takePendingOptionSelections();

		// Show the welcome view first, then reset options to ensure
		// pickers are re-rendered after the container is visible
		this._updateWelcomeVisibility();
		this._welcomePart.value?.resetSelectedOptions();
	}

	// --- Option groups caching ---

	/**
	 * Persist option groups for a session type to storage so they are
	 * available on next load before extensions activate.
	 */
	private _persistOptionGroups(sessionType: string): void {
		const groups = this.chatSessionsService.getOptionGroupsForSessionType(sessionType);
		if (!groups || groups.length === 0) {
			return;
		}
		const key = `${AgentSessionsChatWidget._CACHED_OPTION_GROUPS_KEY}.${sessionType}`;
		// Strip non-serializable properties (onSearch callbacks)
		const serializable: IChatSessionProviderOptionGroup[] = groups.map(g => ({
			id: g.id,
			name: g.name,
			description: g.description,
			items: g.items,
			searchable: g.searchable,
			when: g.when,
			icon: g.icon,
			commands: g.commands,
		}));
		this.storageService.store(key, JSON.stringify(serializable), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	/**
	 * Load cached option groups from storage and seed the service.
	 * Only loads for the allowed targets so we don't pollute other views.
	 */
	private _loadCachedOptionGroups(): void {
		for (const target of this._targetConfig.allowedTargets.get()) {
			const key = `${AgentSessionsChatWidget._CACHED_OPTION_GROUPS_KEY}.${target}`;
			const raw = this.storageService.get(key, StorageScope.APPLICATION);
			if (!raw) {
				continue;
			}
			try {
				const groups: IChatSessionProviderOptionGroup[] = JSON.parse(raw);
				if (Array.isArray(groups) && groups.length > 0 && !this.chatSessionsService.getOptionGroupsForSessionType(target)) {
					// Only seed if the service doesn't already have groups (extension already loaded)
					this.chatSessionsService.setOptionGroupsForSessionType(target, -1, groups);
				}
			} catch (e) {
				this.logService.warn(`[AgentSessionsChatWidget] Failed to parse cached option groups for ${target}`, e);
			}
		}
	}

	override dispose(): void {
		this._chatModelRef?.dispose();
		super.dispose();
	}
}
