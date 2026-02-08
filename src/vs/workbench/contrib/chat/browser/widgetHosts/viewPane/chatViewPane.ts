/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatViewPane.css';
import { $, addDisposableListener, append, EventHelper, EventType, getWindow } from '../../../../../../base/browser/dom.js';
import { renderAsPlaintext } from '../../../../../../base/browser/markdownRenderer.js';
import { StandardMouseEvent } from '../../../../../../base/browser/mouseEvent.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Event } from '../../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { MutableDisposable, toDisposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { MarshalledId } from '../../../../../../base/common/marshallingIds.js';
import { autorun, IReader } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { MenuId } from '../../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../../platform/instantiation/common/serviceCollection.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { asCssVariable, editorBackground } from '../../../../../../platform/theme/common/colorRegistry.js';
import { disabledForeground } from '../../../../../../platform/theme/common/colors/baseColors.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../../browser/parts/views/viewPane.js';
import { Memento } from '../../../../../common/memento.js';
import { SIDE_BAR_FOREGROUND } from '../../../../../common/theme.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../../common/views.js';
import { ILifecycleService, StartupKind } from '../../../../../services/lifecycle/common/lifecycle.js';
import { IChatViewTitleActionContext } from '../../../common/actions/chatActions.js';
import { IChatAgentService } from '../../../common/participants/chatAgents.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { IChatModel, IChatModelInputState } from '../../../common/model/chatModel.js';
import { CHAT_PROVIDER_ID } from '../../../common/participants/chatParticipantContribTypes.js';
import { IChatModelReference, IChatService } from '../../../common/chatService/chatService.js';
import { IChatSessionsService, localChatSessionType } from '../../../common/chatSessionsService.js';
import { LocalChatSessionUri, getChatSessionType } from '../../../common/model/chatUri.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../../../common/constants.js';
import { ChatWidget } from '../../widget/chatWidget.js';
import { ChatViewWelcomeController, IViewWelcomeDelegate } from '../../viewsWelcome/chatViewWelcomeController.js';
import { IChatViewsWelcomeDescriptor } from '../../viewsWelcome/chatViewsWelcome.js';
import { IWorkbenchLayoutService, LayoutSettings, Position } from '../../../../../services/layout/browser/layoutService.js';
import { IProgressService } from '../../../../../../platform/progress/common/progress.js';
import { ChatViewId } from '../../chat.js';
import { IActivityService, ProgressBadge } from '../../../../../services/activity/common/activity.js';
import { disposableTimeout } from '../../../../../../base/common/async.js';
import { IAgentSessionsService } from '../../agentSessions/agentSessionsService.js';
import { AgentSessionProviders, getAgentSessionProvider, getAgentSessionProviderIcon, getAgentSessionProviderName } from '../../agentSessions/agentSessions.js';
import { getAgentChangesSummary, hasValidDiff } from '../../agentSessions/agentSessionsModel.js';

interface IChatViewPaneState extends Partial<IChatModelInputState> {
	sessionId?: string;
}

type ChatViewPaneOpenedClassification = {
	owner: 'sbatten';
	comment: 'Event fired when the chat view pane is opened';
};

export class ChatViewPane extends ViewPane implements IViewWelcomeDelegate {

	private readonly memento: Memento<IChatViewPaneState>;
	private readonly viewState: IChatViewPaneState;

	private viewPaneContainer: HTMLElement | undefined;
	private readonly chatViewLocationContext: IContextKey<ViewContainerLocation>;

	private lastDimensions: { height: number; width: number } | undefined;

	private welcomeController: ChatViewWelcomeController | undefined;

	private restoringSession: Promise<void> | undefined;
	private readonly modelRef = this._register(new MutableDisposable<IChatModelReference>());

	private readonly activityBadge = this._register(new MutableDisposable());

	private _currentSessionTitle: string | undefined;
	private _currentSessionDescription: string | undefined;
	private readonly _modelTitleDisposable = this._register(new MutableDisposable());
	override get singleViewPaneContainerTitle(): string | undefined {
		return this._currentSessionTitle;
	}

	override get singleViewPaneContainerDescription(): string | undefined {
		return this._currentSessionDescription;
	}

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IStorageService private readonly storageService: IStorageService,
		@IChatService private readonly chatService: IChatService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@ILogService private readonly logService: ILogService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IProgressService private readonly progressService: IProgressService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@ICommandService _commandService: ICommandService,
		@IActivityService private readonly activityService: IActivityService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// View state for the ViewPane is currently global per-provider basically,
		// but some other strictly per-model state will require a separate memento.
		this.memento = new Memento(`interactive-session-view-${CHAT_PROVIDER_ID}`, this.storageService);
		this.viewState = this.memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE);
		if (
			lifecycleService.startupKind !== StartupKind.ReloadedWindow &&
			this.configurationService.getValue<boolean>(ChatConfiguration.RestoreLastPanelSession) === false
		) {
			this.viewState.sessionId = undefined; // clear persisted session on fresh start
		}

		// Contextkeys
		this.chatViewLocationContext = ChatContextKeys.panelLocation.bindTo(contextKeyService);
		this.updateContextKeys();

		this.registerListeners();
	}

	private updateContextKeys(): void {
		const location = this.getViewLocation();
		this.chatViewLocationContext.set(location ?? ViewContainerLocation.AuxiliaryBar);
	}

	private getViewLocation(): ViewContainerLocation | undefined {
		return this.viewDescriptorService.getViewLocationById(this.id) ?? undefined;
	}

	private updateViewPaneClasses(fromEvent: boolean): void {
		const activityBarLocationDefault = this.configurationService.getValue<string>(LayoutSettings.ACTIVITY_BAR_LOCATION) === 'default';
		this.viewPaneContainer?.classList.toggle('activity-bar-location-default', activityBarLocationDefault);
		this.viewPaneContainer?.classList.toggle('activity-bar-location-other', !activityBarLocationDefault);

		const viewLocation = this.getViewLocation();
		const sideBarPosition = this.layoutService.getSideBarPosition();
		const panelPosition = this.layoutService.getPanelPosition();

		let position: Position;
		switch (viewLocation) {
			case ViewContainerLocation.Sidebar:
				position = sideBarPosition;
				break;
			case ViewContainerLocation.Panel:
				position = panelPosition;
				break;
			default:
				position = sideBarPosition === Position.LEFT ? Position.RIGHT : Position.LEFT;
				break;
		}

		this.viewPaneContainer?.classList.toggle('chat-view-location-auxiliarybar', viewLocation === ViewContainerLocation.AuxiliaryBar);
		this.viewPaneContainer?.classList.toggle('chat-view-location-sidebar', viewLocation === ViewContainerLocation.Sidebar);
		this.viewPaneContainer?.classList.toggle('chat-view-location-panel', viewLocation === ViewContainerLocation.Panel);

		this.viewPaneContainer?.classList.toggle('chat-view-position-left', position === Position.LEFT);
		this.viewPaneContainer?.classList.toggle('chat-view-position-right', position === Position.RIGHT);

		if (fromEvent) {
			this.relayout();
		}
	}

	private registerListeners(): void {

		// Agent changes
		this._register(this.chatAgentService.onDidChangeAgents(() => this.onDidChangeAgents()));

		// Layout changes
		this._register(Event.any(
			Event.filter(this.configurationService.onDidChangeConfiguration, e => e.affectsConfiguration('workbench.sideBar.location')),
			this.layoutService.onDidChangePanelPosition,
			Event.filter(this.viewDescriptorService.onDidChangeContainerLocation, e => e.viewContainer === this.viewDescriptorService.getViewContainerByViewId(this.id))
		)(() => {
			this.updateContextKeys();
			this.updateViewPaneClasses(true /* layout here */);
		}));

		// Settings changes
		this._register(Event.filter(this.configurationService.onDidChangeConfiguration, e => {
			return e.affectsConfiguration(LayoutSettings.ACTIVITY_BAR_LOCATION);
		})(() => this.updateViewPaneClasses(true)));
	}

	private onDidChangeAgents(): void {
		if (this.chatAgentService.getDefaultAgent(ChatAgentLocation.Chat)) {
			if (!this._widget?.viewModel && !this.restoringSession) {
				const sessionResource = this.getTransferredOrPersistedSessionInfo();
				this.restoringSession =
					(sessionResource ? this.chatService.getOrRestoreSession(sessionResource) : Promise.resolve(undefined)).then(async modelRef => {
						if (!this._widget) {
							return; // renderBody has not been called yet
						}

						// The widget may be hidden at this point, because welcome views were allowed. Use setVisible to
						// avoid doing a render while the widget is hidden. This is changing the condition in `shouldShowWelcome`
						// so it should fire onDidChangeViewWelcomeState.
						const wasVisible = this._widget.visible;
						try {
							this._widget.setVisible(false);

							await this.showModel(modelRef);
						} finally {
							this._widget.setVisible(wasVisible);
						}
					});

				this.restoringSession.finally(() => this.restoringSession = undefined);
			}
		}

		this._onDidChangeViewWelcomeState.fire();
	}

	private getTransferredOrPersistedSessionInfo(): URI | undefined {
		if (this.chatService.transferredSessionResource) {
			return this.chatService.transferredSessionResource;
		}

		return this.viewState.sessionId ? LocalChatSessionUri.forSession(this.viewState.sessionId) : undefined;
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);

		this.telemetryService.publicLog2<{}, ChatViewPaneOpenedClassification>('chatViewPaneOpened');

		this.viewPaneContainer = parent;
		this.viewPaneContainer.classList.add('chat-viewpane');
		this.updateViewPaneClasses(false);

		this.createControls(parent);

		this.setupContextMenu(parent);

		this.applyModel();
	}

	private createControls(parent: HTMLElement): void {

		// Welcome Control (used to show chat specific extension provided welcome views via `chatViewsWelcome` contribution point)
		const welcomeController = this.welcomeController = this._register(this.instantiationService.createInstance(ChatViewWelcomeController, parent, this, ChatAgentLocation.Chat));

		// Chat Control
		const chatWidget = this.createChatControl(parent);

		// Controls Listeners
		this.registerControlsListeners(chatWidget, welcomeController);
	}

	//#region Chat Control

	private _widget!: ChatWidget;
	get widget(): ChatWidget { return this._widget; }

	private createChatControl(parent: HTMLElement): ChatWidget {
		const chatControlsContainer = append(parent, $('.chat-controls-container'));

		const locationBasedColors = this.getLocationBasedColors();

		const editorOverflowWidgetsDomNode = this.layoutService.getContainer(getWindow(chatControlsContainer)).appendChild($('.chat-editor-overflow.monaco-editor'));
		this._register(toDisposable(() => editorOverflowWidgetsDomNode.remove()));

		// Chat Widget
		const scopedInstantiationService = this._register(this.instantiationService.createChild(new ServiceCollection([IContextKeyService, this.scopedContextKeyService])));
		this._widget = this._register(scopedInstantiationService.createInstance(
			ChatWidget,
			ChatAgentLocation.Chat,
			{ viewId: this.id },
			{
				autoScroll: mode => mode !== ChatModeKind.Ask,
				renderFollowups: true,
				supportsFileReferences: true,
				clear: () => this.clear(),
				rendererOptions: {
					renderTextEditsAsSummary: (uri) => {
						return true;
					},
					referencesExpandedWhenEmptyResponse: false,
					progressMessageAtBottomOfResponse: mode => mode !== ChatModeKind.Ask,
				},
				editorOverflowWidgetsDomNode,
				enableImplicitContext: true,
				enableWorkingSet: 'explicit',
				supportsChangingModes: true,
				dndContainer: parent,
			},
			{
				listForeground: SIDE_BAR_FOREGROUND,
				listBackground: locationBasedColors.background,
				overlayBackground: locationBasedColors.overlayBackground,
				inputEditorBackground: locationBasedColors.background,
				resultEditorBackground: editorBackground,
			}));
		this._widget.render(chatControlsContainer);

		const updateWidgetVisibility = (reader?: IReader) => this._widget.setVisible(this.isBodyVisible() && !this.welcomeController?.isShowingWelcome.read(reader));
		this._register(this.onDidChangeBodyVisibility(() => updateWidgetVisibility()));
		this._register(autorun(reader => updateWidgetVisibility(reader)));

		return this._widget;
	}

	//#endregion

	private updatePartTitle(model: IChatModel | undefined): void {
		this._modelTitleDisposable.value = model?.onDidChange(e => {
			if (e.kind === 'setCustomTitle' || e.kind === 'addRequest') {
				this.setSessionTitle(model);
			}
		});

		this.setSessionTitle(model);
	}

	private setSessionTitle(model: IChatModel | undefined): void {
		const markdownTitle = new MarkdownString(model?.title ?? '');
		const newTitle = renderAsPlaintext(markdownTitle) || localize('chat.newChat', "New Chat");
		const newDescription = this.getSessionDescription(model);
		if (this._currentSessionTitle !== newTitle || this._currentSessionDescription !== newDescription) {
			this._currentSessionTitle = newTitle;
			this._currentSessionDescription = newDescription;
			this._onDidChangeTitleArea.fire();
		}
	}

	private getSessionDescription(model: IChatModel | undefined): string | undefined {
		if (!model) {
			return undefined;
		}

		const parts: string[] = [];

		// Provider icon + name
		const providerType = getAgentSessionProvider(model.sessionResource);
		const provider = providerType ?? AgentSessionProviders.Local;
		const providerIcon = getAgentSessionProviderIcon(provider);
		const providerName = getAgentSessionProviderName(provider);
		if (provider === AgentSessionProviders.Background) {
			parts.push(`$(${providerIcon.id}) ${providerName} · Copilot CLI`);
		} else {
			parts.push(`$(${providerIcon.id}) ${providerName}`);
		}

		// File count
		const agentSession = this.agentSessionsService.getSession(model.sessionResource);
		if (agentSession) {
			const diff = getAgentChangesSummary(agentSession.changes);
			if (diff && hasValidDiff(agentSession.changes)) {
				if (diff.files > 0) {
					parts.push('·');
					parts.push(diff.files === 1 ? localize('description.file', "1 file") : localize('description.files', "{0} files", diff.files));
				}
				// Insertions/deletions are rendered as colored elements in renderSingleViewPaneContainerDescription
				if (diff.insertions > 0 || diff.deletions > 0) {
					parts.push(`+${diff.insertions} -${diff.deletions}`);
				}
			}
		}

		return parts.join(' ');
	}

	override renderSingleViewPaneContainerDescription(container: HTMLElement): boolean {
		const model = this.widget?.viewModel?.model;
		if (!model) {
			return false;
		}

		// Provider icon + name (matches hover widget structure)
		const providerType = getAgentSessionProvider(model.sessionResource);
		const provider = providerType ?? AgentSessionProviders.Local;
		const providerIcon = getAgentSessionProviderIcon(provider);
		container.append(renderIcon(providerIcon));
		container.append($('span', undefined, getAgentSessionProviderName(provider)));
		if (provider === AgentSessionProviders.Background) {
			const suffix = $('span', undefined, ` · Copilot CLI`);
			suffix.style.color = asCssVariable(disabledForeground);
			container.append(suffix);
		}

		// Diff info
		const agentSession = this.agentSessionsService.getSession(model.sessionResource);
		if (agentSession) {
			const diff = getAgentChangesSummary(agentSession.changes);
			if (diff && hasValidDiff(agentSession.changes)) {
				container.append($('span.separator', undefined, '\u2022'));
				const diffContainer = append(container, $('.diff'));
				if (diff.files > 0) {
					diffContainer.append($('span', undefined, diff.files === 1 ? localize('description.file', "1 file") : localize('description.files', "{0} files", diff.files)));
				}
				if (diff.insertions > 0) {
					diffContainer.append($('span.insertions', undefined, `+${diff.insertions}`));
				}
				if (diff.deletions > 0) {
					diffContainer.append($('span.deletions', undefined, `-${diff.deletions}`));
				}
			}
		}

		return true;
	}

	private registerControlsListeners(chatWidget: ChatWidget, welcomeController: ChatViewWelcomeController): void {

		// Show progress badge when the current session is in progress
		const progressBadgeDisposables = this._register(new MutableDisposable<DisposableStore>());
		const updateProgressBadge = () => {
			progressBadgeDisposables.value = new DisposableStore();

			if (!this.configurationService.getValue<boolean>(ChatConfiguration.ChatViewProgressBadgeEnabled)) {
				this.activityBadge.clear();
				return;
			}

			const model = chatWidget.viewModel?.model;
			if (model) {
				progressBadgeDisposables.value.add(autorun(reader => {
					if (model.requestInProgress.read(reader)) {
						this.activityBadge.value = this.activityService.showViewActivity(this.id, {
							badge: new ProgressBadge(() => localize('sessionInProgress', "Agent Session in Progress"))
						});
					} else {
						this.activityBadge.clear();
					}
				}));
			} else {
				this.activityBadge.clear();
			}
		};
		this._register(chatWidget.onDidChangeViewModel(() => updateProgressBadge()));
		this._register(Event.filter(this.configurationService.onDidChangeConfiguration, e => e.affectsConfiguration(ChatConfiguration.ChatViewProgressBadgeEnabled))(() => updateProgressBadge()));
		updateProgressBadge();
	}

	private setupContextMenu(parent: HTMLElement): void {
		this._register(addDisposableListener(parent, EventType.CONTEXT_MENU, e => {
			EventHelper.stop(e, true);

			this.contextMenuService.showContextMenu({
				menuId: MenuId.ChatWelcomeContext,
				contextKeyService: this.contextKeyService,
				getAnchor: () => new StandardMouseEvent(getWindow(parent), e)
			});
		}));
	}

	//#region Model Management

	private async applyModel(): Promise<void> {
		const sessionResource = this.getTransferredOrPersistedSessionInfo();
		const modelRef = sessionResource ? await this.chatService.getOrRestoreSession(sessionResource) : undefined;
		await this.showModel(modelRef);
	}

	private async showModel(modelRef?: IChatModelReference | undefined, startNewSession = true): Promise<IChatModel | undefined> {
		const oldModelResource = this.modelRef.value?.object.sessionResource;
		this.modelRef.value = undefined;

		let ref: IChatModelReference | undefined;
		if (startNewSession) {
			ref = modelRef ?? (this.chatService.transferredSessionResource
				? await this.chatService.getOrRestoreSession(this.chatService.transferredSessionResource)
				: this.chatService.startSession(ChatAgentLocation.Chat));
			if (!ref) {
				throw new Error('Could not start chat session');
			}
		}

		this.modelRef.value = ref;
		const model = ref?.object;

		if (model) {
			await this.updateWidgetLockState(model.sessionResource); // Update widget lock state based on session type

			this.viewState.sessionId = model.sessionId; // remember as model to restore in view state
		}

		this._widget.setModel(model);

		// Update the Part title with the session title
		this.updatePartTitle(model);

		// Update the toolbar context with new sessionId
		this.updateActions();

		// Mark the old model as read when closing
		if (oldModelResource) {
			this.agentSessionsService.model.getSession(oldModelResource)?.setRead(true);
		}

		return model;
	}

	private async updateWidgetLockState(sessionResource: URI): Promise<void> {
		const sessionType = getChatSessionType(sessionResource);
		if (sessionType === localChatSessionType) {
			this._widget.unlockFromCodingAgent();
			return;
		}

		let canResolve = false;
		try {
			canResolve = await this.chatSessionsService.canResolveChatSession(sessionResource);
		} catch (error) {
			this.logService.warn(`Failed to resolve chat session '${sessionResource.toString()}' for locking`, error);
		}

		if (!canResolve) {
			this._widget.unlockFromCodingAgent();
			return;
		}

		const contribution = this.chatSessionsService.getChatSessionContribution(sessionType);
		if (contribution) {
			this._widget.lockToCodingAgent(contribution.name, contribution.displayName, contribution.type);
		} else {
			this._widget.unlockFromCodingAgent();
		}
	}

	private async clear(): Promise<void> {

		// Grab the widget's latest view state because it will be loaded back into the widget
		this.updateViewState();
		await this.showModel(undefined);

		// Update the toolbar context with new sessionId
		this.updateActions();
	}

	async loadSession(sessionResource: URI): Promise<IChatModel | undefined> {
		return this.progressService.withProgress({ location: ChatViewId, delay: 200 }, async () => {
			let queue: Promise<void> = Promise.resolve();

			// A delay here to avoid blinking because only Cloud sessions are slow, most others are fast
			const clearWidget = disposableTimeout(() => {
				// clear current model without starting a new one
				queue = this.showModel(undefined, false).then(() => { });
			}, 100);

			const sessionType = getChatSessionType(sessionResource);
			if (sessionType !== localChatSessionType) {
				await this.chatSessionsService.canResolveChatSession(sessionResource);
			}

			const newModelRef = await this.chatService.loadSessionForResource(sessionResource, ChatAgentLocation.Chat, CancellationToken.None);
			clearWidget.dispose();
			await queue;

			return this.showModel(newModelRef);
		});
	}

	//#endregion

	override focus(): void {
		super.focus();

		this.focusInput();
	}

	focusInput(): void {
		this._widget.focusInput();
	}

	//#region Layout

	private layoutingBody = false;

	private relayout(): void {
		if (this.lastDimensions) {
			this.layoutBody(this.lastDimensions.height, this.lastDimensions.width);
		}
	}

	protected override layoutBody(height: number, width: number): void {
		if (this.layoutingBody) {
			return; // prevent re-entrancy
		}

		this.layoutingBody = true;
		try {
			this.doLayoutBody(height, width);
		} finally {
			this.layoutingBody = false;
		}
	}

	private doLayoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		this.lastDimensions = { height, width };

		let remainingHeight = height;

		// Chat Widget
		this._widget.layout(remainingHeight, width);
	}

	//#endregion

	override saveState(): void {

		// Don't do saveState when no widget, or no viewModel in which case
		// the state has not yet been restored - in that case the default
		// state would overwrite the real state
		if (this._widget?.viewModel) {
			this._widget.saveState();

			this.updateViewState();
			this.memento.saveMemento();
		}

		super.saveState();
	}

	private updateViewState(viewState?: IChatModelInputState): void {
		const newViewState = viewState ?? this._widget.getViewState();
		if (newViewState) {
			for (const [key, value] of Object.entries(newViewState)) {
				(this.viewState as Record<string, unknown>)[key] = value; // Assign all props to the memento so they get saved
			}
		}
	}

	override shouldShowWelcome(): boolean {
		const noPersistedSessions = !this.chatService.hasSessions();
		const hasCoreAgent = this.chatAgentService.getAgents().some(agent => agent.isCore && agent.locations.includes(ChatAgentLocation.Chat));
		const hasDefaultAgent = this.chatAgentService.getDefaultAgent(ChatAgentLocation.Chat) !== undefined; // only false when Hide AI Features has run and unregistered the setup agents
		const shouldShow = !hasCoreAgent && (!hasDefaultAgent || !this._widget?.viewModel && noPersistedSessions);

		this.logService.trace(`ChatViewPane#shouldShowWelcome() = ${shouldShow}: hasCoreAgent=${hasCoreAgent} hasDefaultAgent=${hasDefaultAgent} || noViewModel=${!this._widget?.viewModel} && noPersistedSessions=${noPersistedSessions}`);

		return !!shouldShow;
	}

	getMatchingWelcomeView(): IChatViewsWelcomeDescriptor | undefined {
		return this.welcomeController?.getMatchingWelcomeView();
	}

	override getActionsContext(): IChatViewTitleActionContext | undefined {
		return this._widget?.viewModel ? {
			sessionResource: this._widget.viewModel.sessionResource,
			$mid: MarshalledId.ChatViewContext
		} : undefined;
	}
}
