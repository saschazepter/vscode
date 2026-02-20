/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../browser/media/sidebarActionButton.css';
import './media/customizationsToolbar.css';
import './media/sessionsViewPane.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../workbench/common/views.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { localize, localize2 } from '../../../../nls.js';
import { AgentSessionsControl } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsControl.js';
import { AgentSessionsFilter, AgentSessionsGrouping } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsFilter.js';
import { IPromptsService } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { IMcpService } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { ISessionsManagementService } from './sessionsManagementService.js';
import { Action2, ISubmenuItem, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ACTION_ID_NEW_CHAT } from '../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { Menus } from '../../../browser/menus.js';
import { getCustomizationTotalCount } from './customizationCounts.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { ICopilotSdkService, type ICopilotSessionMetadata } from '../../../../platform/copilotSdk/common/copilotSdkService.js';
import { SdkChatViewPane, SdkChatViewId } from '../../../browser/widget/sdkChatViewPane.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';

const $ = DOM.$;
export const SessionsViewId = 'agentic.workbench.view.sessionsView';
const SessionsViewFilterSubMenu = new MenuId('AgentSessionsViewFilterSubMenu');

const CUSTOMIZATIONS_COLLAPSED_KEY = 'agentSessions.customizationsCollapsed';

export class AgenticSessionsViewPane extends ViewPane {

	private viewPaneContainer: HTMLElement | undefined;
	private sessionsControlContainer: HTMLElement | undefined;
	sessionsControl: AgentSessionsControl | undefined;
	private aiCustomizationContainer: HTMLElement | undefined;

	// SDK session list (used when --sessions-utility-process is active)
	private readonly _useSdk: boolean;
	private _sdkSessions: ICopilotSessionMetadata[] = [];
	private _sdkSelectedSessionId: string | undefined;
	private _sdkListContainer: HTMLElement | undefined;
	private readonly _sdkListDisposables = this._register(new DisposableStore());

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
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
		@IPromptsService private readonly promptsService: IPromptsService,
		@IMcpService private readonly mcpService: IMcpService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISessionsManagementService private readonly activeSessionService: ISessionsManagementService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@ICopilotSdkService private readonly copilotSdkService: ICopilotSdkService,
		@IViewsService private readonly viewsService: IViewsService,
		@ILogService private readonly logService: ILogService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._useSdk = environmentService.isSessionsUtilityProcess;
		// SDK session lifecycle updates
		if (this._useSdk) {
			this._register(this.copilotSdkService.onSessionLifecycle(() => this._refreshSdkSessionList()));
		}

	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);

		this.viewPaneContainer = parent;
		this.viewPaneContainer.classList.add('agent-sessions-viewpane');

		this.createControls(parent);
	}

	private createControls(parent: HTMLElement): void {
		const sessionsContainer = DOM.append(parent, $('.agent-sessions-container'));

		if (this._useSdk) {
			this._createSdkControls(sessionsContainer);
		} else {
			this._createDefaultControls(sessionsContainer);
		}

		// AI Customization shortcuts (always shown)
		this.aiCustomizationContainer = DOM.append(sessionsContainer, $('.ai-customization-shortcuts'));
		this.createAICustomizationShortcuts(this.aiCustomizationContainer);
	}

	private _createSdkControls(sessionsContainer: HTMLElement): void {
		const sessionsSection = DOM.append(sessionsContainer, $('.agent-sessions-section'));
		const sessionsContent = DOM.append(sessionsSection, $('.agent-sessions-content'));

		// New Session Button
		const newSessionButtonContainer = DOM.append(sessionsContent, $('.agent-sessions-new-button-container'));
		const newSessionButton = this._register(new Button(newSessionButtonContainer, { ...defaultButtonStyles, secondary: true }));
		newSessionButton.label = localize('newSession', "New Session");
		this._register(newSessionButton.onDidClick(() => {
			const chatPane = this.viewsService.getViewWithId<SdkChatViewPane>(SdkChatViewId);
			if (chatPane?.widget) {
				chatPane.widget.newSession();
				this._sdkSelectedSessionId = undefined;
				this._renderSdkSessionList();
			}
		}));

		const keybinding = this.keybindingService.lookupKeybinding(ACTION_ID_NEW_CHAT);
		if (keybinding) {
			const keybindingHint = DOM.append(newSessionButton.element, $('span.new-session-keybinding-hint'));
			keybindingHint.textContent = keybinding.getLabel() ?? '';
		}

		// SDK Sessions list
		this._sdkListContainer = DOM.append(sessionsContent, $('.agent-sessions-control-container'));
		this._refreshSdkSessionList();
	}

	private async _refreshSdkSessionList(): Promise<void> {
		try {
			this._sdkSessions = await this.copilotSdkService.listSessions();
		} catch (err) {
			this.logService.error('[SessionsViewPane] Failed to list SDK sessions:', err);
			this._sdkSessions = [];
		}
		this._renderSdkSessionList();
	}

	private _renderSdkSessionList(): void {
		if (!this._sdkListContainer) { return; }
		this._sdkListDisposables.clear();
		DOM.clearNode(this._sdkListContainer);

		if (this._sdkSessions.length === 0) {
			const empty = DOM.append(this._sdkListContainer, $('.sdk-session-list-empty'));
			empty.textContent = localize('noSessions', "No sessions yet");
			return;
		}

		for (const session of this._sdkSessions) {
			const item = DOM.append(this._sdkListContainer, $('.sdk-session-item'));
			item.tabIndex = 0;
			item.setAttribute('role', 'listitem');
			item.setAttribute('data-session-id', session.sessionId);
			if (session.sessionId === this._sdkSelectedSessionId) { item.classList.add('selected'); }

			const icon = DOM.append(item, $('span.sdk-session-icon'));
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.commentDiscussion));

			const details = DOM.append(item, $('span.sdk-session-details'));
			const label = DOM.append(details, $('span.sdk-session-label'));
			label.textContent = session.summary || localize('untitledSession', "Untitled Session");

			if (session.workspacePath || session.repository) {
				const pathEl = DOM.append(details, $('span.sdk-session-path'));
				pathEl.textContent = session.repository
					? (session.branch ? `${session.repository} (${session.branch})` : session.repository)
					: session.workspacePath ?? '';
			}

			if (session.modifiedTime || session.startTime) {
				const timeEl = DOM.append(item, $('span.sdk-session-time'));
				const date = new Date((session.modifiedTime ?? session.startTime)!);
				timeEl.textContent = this._relativeTime(date);
			}

			// Delete button
			const actions = DOM.append(item, $('span.sdk-session-actions'));
			const deleteBtn = DOM.append(actions, $('button.sdk-session-action-btn')) as HTMLButtonElement;
			deleteBtn.title = localize('deleteSession', "Delete Session");
			DOM.append(deleteBtn, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.trash));
			this._sdkListDisposables.add(DOM.addDisposableListener(deleteBtn, 'click', (e) => {
				DOM.EventHelper.stop(e);
				this._deleteSdkSession(session.sessionId);
			}));

			this._sdkListDisposables.add(DOM.addDisposableListener(item, 'click', () => this._selectSdkSession(session.sessionId)));
			this._sdkListDisposables.add(DOM.addDisposableListener(item, 'keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._selectSdkSession(session.sessionId); }
			}));
		}
	}

	private _selectSdkSession(sessionId: string): void {
		this._sdkSelectedSessionId = sessionId;
		if (this._sdkListContainer) {
			for (const child of this._sdkListContainer.children) {
				child.classList.toggle('selected', (child as HTMLElement).getAttribute('data-session-id') === sessionId);
			}
		}
		const chatPane = this.viewsService.getViewWithId<SdkChatViewPane>(SdkChatViewId);
		chatPane?.widget?.loadSession(sessionId);
	}

	private async _deleteSdkSession(sessionId: string): Promise<void> {
		const session = this._sdkSessions.find(s => s.sessionId === sessionId);
		const confirmation = await this.dialogService.confirm({
			message: localize('deleteSdkSession.confirm', "Delete this session?"),
			detail: session?.summary ?? session?.workspacePath ?? sessionId,
			primaryButton: localize('deleteSession.confirm.button', "Delete"),
			cancelButton: localize('cancel', "Cancel")
		});
		if (!confirmation.confirmed) {
			return;
		}
		try { await this.copilotSdkService.deleteSession(sessionId); } catch { /* best-effort */ }
		if (this._sdkSelectedSessionId === sessionId) {
			this._sdkSelectedSessionId = undefined;
			const chatPane = this.viewsService.getViewWithId<SdkChatViewPane>(SdkChatViewId);
			chatPane?.widget?.newSession();
		}
		this._refreshSdkSessionList();
	}

	private _relativeTime(date: Date): string {
		const diffMs = Date.now() - date.getTime();
		if (diffMs <= 0) { return localize('justNow', "just now"); }
		const diffMins = Math.floor(diffMs / 60000);
		if (diffMins < 1) { return localize('justNow', "just now"); }
		if (diffMins < 60) { return localize('minutesAgo', "{0}m ago", diffMins); }
		const diffHours = Math.floor(diffMins / 60);
		if (diffHours < 24) { return localize('hoursAgo', "{0}h ago", diffHours); }
		const diffDays = Math.floor(diffHours / 24);
		if (diffDays < 7) { return localize('daysAgo', "{0}d ago", diffDays); }
		return date.toLocaleDateString();
	}

	private _createDefaultControls(sessionsContainer: HTMLElement): void {

		// Sessions Filter (actions go to view title bar via menu registration)
		const sessionsFilter = this._register(this.instantiationService.createInstance(AgentSessionsFilter, {
			filterMenuId: SessionsViewFilterSubMenu,
			groupResults: () => AgentSessionsGrouping.Date
		}));

		// Sessions section (top, fills available space)
		const sessionsSection = DOM.append(sessionsContainer, $('.agent-sessions-section'));

		// Sessions content container
		const sessionsContent = DOM.append(sessionsSection, $('.agent-sessions-content'));

		// New Session Button
		const newSessionButtonContainer = DOM.append(sessionsContent, $('.agent-sessions-new-button-container'));
		const newSessionButton = this._register(new Button(newSessionButtonContainer, { ...defaultButtonStyles, secondary: true }));
		newSessionButton.label = localize('newSession', "New Session");
		this._register(newSessionButton.onDidClick(() => this.activeSessionService.openNewSession()));

		// Keybinding hint inside the button
		const keybinding = this.keybindingService.lookupKeybinding(ACTION_ID_NEW_CHAT);
		if (keybinding) {
			const keybindingHint = DOM.append(newSessionButton.element, $('span.new-session-keybinding-hint'));
			keybindingHint.textContent = keybinding.getLabel() ?? '';
		}

		// Sessions Control
		const sessionsControlContainer = DOM.append(sessionsContent, $('.agent-sessions-control-container'));
		const sessionsControl = this.sessionsControl = this._register(this.instantiationService.createInstance(AgentSessionsControl, sessionsControlContainer, {
			source: 'agentSessionsViewPane',
			filter: sessionsFilter,
			overrideStyles: this.getLocationBasedColors().listOverrideStyles,
			disableHover: true,
			getHoverPosition: () => this.getSessionHoverPosition(),
			trackActiveEditorSession: () => true,
			collapseOlderSections: () => true,
			overrideSessionOpen: (resource, openOptions) => this.activeSessionService.openSession(resource, openOptions),
		}));
		this._register(this.onDidChangeBodyVisibility(visible => sessionsControl.setVisible(visible)));

		// Listen to tree updates and restore selection if nothing is selected
		this._register(sessionsControl.onDidUpdate(() => {
			if (!sessionsControl.hasFocusOrSelection()) {
				this.restoreLastSelectedSession();
			}
		}));

		// When the active session changes, select it in the tree
		this._register(autorun(reader => {
			const activeSession = this.activeSessionService.activeSession.read(reader);
			if (activeSession) {
				if (!sessionsControl.reveal(activeSession.resource)) {
					sessionsControl.clearFocus();
				}
			} else {
				sessionsControl.clearFocus(); // clear selection when a new session is created
			}
		}));

		// AI Customization toolbar (bottom, fixed height)
		this.aiCustomizationContainer = DOM.append(sessionsContainer, $('div'));
		this.createAICustomizationShortcuts(this.aiCustomizationContainer);
	}

	private restoreLastSelectedSession(): void {
		const activeSession = this.activeSessionService.getActiveSession();
		if (activeSession && this.sessionsControl) {
			this.sessionsControl.reveal(activeSession.resource);
		}
	}

	private createAICustomizationShortcuts(container: HTMLElement): void {
		// Get initial collapsed state
		const isCollapsed = this.storageService.getBoolean(CUSTOMIZATIONS_COLLAPSED_KEY, StorageScope.PROFILE, false);

		container.classList.add('ai-customization-toolbar');
		if (isCollapsed) {
			container.classList.add('collapsed');
		}

		// Header (clickable to toggle)
		const header = DOM.append(container, $('.ai-customization-header'));
		header.classList.toggle('collapsed', isCollapsed);

		const headerButtonContainer = DOM.append(header, $('.customization-link-button-container'));
		const headerButton = this._register(new Button(headerButtonContainer, {
			...defaultButtonStyles,
			secondary: true,
			title: false,
			supportIcons: true,
			buttonSecondaryBackground: 'transparent',
			buttonSecondaryHoverBackground: undefined,
			buttonSecondaryForeground: undefined,
			buttonSecondaryBorder: undefined,
		}));
		headerButton.element.classList.add('customization-link-button', 'sidebar-action-button');
		headerButton.element.setAttribute('aria-expanded', String(!isCollapsed));
		headerButton.label = localize('customizations', "CUSTOMIZATIONS");

		const chevronContainer = DOM.append(headerButton.element, $('span.customization-link-counts'));
		const chevron = DOM.append(chevronContainer, $('.ai-customization-chevron'));
		const headerTotalCount = DOM.append(chevronContainer, $('span.ai-customization-header-total.hidden'));
		chevron.classList.add(...ThemeIcon.asClassNameArray(isCollapsed ? Codicon.chevronRight : Codicon.chevronDown));

		// Toolbar container
		const toolbarContainer = DOM.append(container, $('.ai-customization-toolbar-content.sidebar-action-list'));

		this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, toolbarContainer, Menus.SidebarCustomizations, {
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
			toolbarOptions: { primaryGroup: () => true },
			telemetrySource: 'sidebarCustomizations',
		}));

		let updateCountRequestId = 0;
		const updateHeaderTotalCount = async () => {
			const requestId = ++updateCountRequestId;
			const totalCount = await getCustomizationTotalCount(this.promptsService, this.mcpService);
			if (requestId !== updateCountRequestId) {
				return;
			}

			headerTotalCount.classList.toggle('hidden', totalCount === 0);
			headerTotalCount.textContent = `${totalCount}`;
		};

		this._register(this.promptsService.onDidChangeCustomAgents(() => updateHeaderTotalCount()));
		this._register(this.promptsService.onDidChangeSlashCommands(() => updateHeaderTotalCount()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => updateHeaderTotalCount()));
		this._register(autorun(reader => {
			this.mcpService.servers.read(reader);
			updateHeaderTotalCount();
		}));
		updateHeaderTotalCount();

		// Toggle collapse on header click
		const transitionListener = this._register(new MutableDisposable());
		const toggleCollapse = () => {
			const collapsed = container.classList.toggle('collapsed');
			header.classList.toggle('collapsed', collapsed);
			this.storageService.store(CUSTOMIZATIONS_COLLAPSED_KEY, collapsed, StorageScope.PROFILE, StorageTarget.USER);
			headerButton.element.setAttribute('aria-expanded', String(!collapsed));
			chevron.classList.remove(...ThemeIcon.asClassNameArray(Codicon.chevronRight), ...ThemeIcon.asClassNameArray(Codicon.chevronDown));
			chevron.classList.add(...ThemeIcon.asClassNameArray(collapsed ? Codicon.chevronRight : Codicon.chevronDown));

			// Re-layout after the transition so sessions control gets the right height
			transitionListener.value = DOM.addDisposableListener(toolbarContainer, 'transitionend', () => {
				transitionListener.clear();
				if (this.viewPaneContainer) {
					const { offsetHeight, offsetWidth } = this.viewPaneContainer;
					this.layoutBody(offsetHeight, offsetWidth);
				}
			});
		};

		this._register(headerButton.onDidClick(() => toggleCollapse()));
	}

	private getSessionHoverPosition(): HoverPosition {
		const viewLocation = this.viewDescriptorService.getViewLocationById(this.id);
		const sideBarPosition = this.layoutService.getSideBarPosition();

		return {
			[ViewContainerLocation.Sidebar]: sideBarPosition === 0 ? HoverPosition.RIGHT : HoverPosition.LEFT,
			[ViewContainerLocation.AuxiliaryBar]: sideBarPosition === 0 ? HoverPosition.LEFT : HoverPosition.RIGHT,
			[ViewContainerLocation.ChatBar]: HoverPosition.RIGHT,
			[ViewContainerLocation.Panel]: HoverPosition.ABOVE
		}[viewLocation ?? ViewContainerLocation.AuxiliaryBar];
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		if (!this.sessionsControl || !this.sessionsControlContainer) {
			return;
		}

		this.sessionsControl.layout(this.sessionsControlContainer.offsetHeight, width);
	}

	override focus(): void {
		super.focus();

		this.sessionsControl?.focus();
	}
}

// Register Cmd+N / Ctrl+N keybinding for new session in the agent sessions window
KeybindingsRegistry.registerKeybindingRule({
	id: ACTION_ID_NEW_CHAT,
	weight: KeybindingWeight.WorkbenchContrib + 1,
	primary: KeyMod.CtrlCmd | KeyCode.KeyN,
});

MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	submenu: SessionsViewFilterSubMenu,
	title: localize2('filterAgentSessions', "Filter Agent Sessions"),
	group: 'navigation',
	order: 3,
	icon: Codicon.filter,
	when: ContextKeyExpr.equals('view', SessionsViewId)
} satisfies ISubmenuItem);

registerAction2(class RefreshAgentSessionsViewerAction extends Action2 {
	constructor() {
		super({
			id: 'sessionsView.refresh',
			title: localize2('refresh', "Refresh Agent Sessions"),
			icon: Codicon.refresh,
			f1: true,
			category: localize2('sessionsViewCategory', "Agent Sessions"),
		});
	}
	override run(accessor: ServicesAccessor) {
		const viewsService = accessor.get(IViewsService);
		const view = viewsService.getViewWithId<AgenticSessionsViewPane>(SessionsViewId);
		return view?.sessionsControl?.refresh();
	}
});

registerAction2(class FindAgentSessionInViewerAction extends Action2 {

	constructor() {
		super({
			id: 'sessionsView.find',
			title: localize2('find', "Find Agent Session"),
			icon: Codicon.search,
			menu: [{
				id: MenuId.ViewTitle,
				group: 'navigation',
				order: 2,
				when: ContextKeyExpr.equals('view', SessionsViewId),
			}]
		});
	}

	override run(accessor: ServicesAccessor) {
		const viewsService = accessor.get(IViewsService);
		const view = viewsService.getViewWithId<AgenticSessionsViewPane>(SessionsViewId);
		return view?.sessionsControl?.openFind();
	}
});
