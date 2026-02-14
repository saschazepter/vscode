/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sessionsViewPane.css';
import * as DOM from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActiveSessionService } from './activeSessionService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { AICustomizationManagementSection } from '../../aiCustomizationManagement/browser/aiCustomizationManagement.js';
import { AICustomizationManagementEditorInput } from '../../aiCustomizationManagement/browser/aiCustomizationManagementEditorInput.js';
import { AICustomizationManagementEditor } from '../../aiCustomizationManagement/browser/aiCustomizationManagementEditor.js';
import { agentIcon, instructionsIcon, promptIcon, skillIcon, hookIcon, workspaceIcon, userIcon, extensionIcon } from '../../aiCustomizationTreeView/browser/aiCustomizationTreeViewIcons.js';
import { IPromptsService, PromptsStorage } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { PromptsType } from '../../../../workbench/contrib/chat/common/promptSyntax/promptTypes.js';
import { ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { IMcpService } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { ICopilotSdkService, type ICopilotSessionMetadata } from '../../../../platform/copilotSdk/common/copilotSdkService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { SdkChatViewPane, SdkChatViewId } from '../../../browser/widget/sdkChatViewPane.js';

const $ = DOM.$;
export const SessionsViewId = 'agentic.workbench.view.sessionsView';

interface ISourceCounts {
	readonly workspace: number;
	readonly user: number;
	readonly extension: number;
}

interface IShortcutItem {
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly action: () => Promise<void>;
	readonly getSourceCounts?: () => Promise<ISourceCounts>;
	readonly getCount?: () => Promise<number>;
	countContainer?: HTMLElement;
}

const CUSTOMIZATIONS_COLLAPSED_KEY = 'agentSessions.customizationsCollapsed';
const NEW_SDK_SESSION_ID = 'sdkSessions.newSession';

export class AgenticSessionsViewPane extends ViewPane {

	private viewPaneContainer: HTMLElement | undefined;
	private sessionsListContainer: HTMLElement | undefined;
	private aiCustomizationContainer: HTMLElement | undefined;
	private readonly shortcuts: IShortcutItem[] = [];

	private _sdkSessions: ICopilotSessionMetadata[] = [];
	private _selectedSessionId: string | undefined;
	private readonly _sessionListDisposables = new DisposableStore();

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
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IPromptsService private readonly promptsService: IPromptsService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IMcpService private readonly mcpService: IMcpService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IActiveSessionService private readonly activeSessionService: IActiveSessionService,
		@ICopilotSdkService private readonly copilotSdkService: ICopilotSdkService,
		@ILogService private readonly logService: ILogService,
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this.shortcuts = [
			{ label: localize('agents', "Agents"), icon: agentIcon, action: () => this.openAICustomizationSection(AICustomizationManagementSection.Agents), getSourceCounts: () => this.getPromptSourceCounts(PromptsType.agent) },
			{ label: localize('skills', "Skills"), icon: skillIcon, action: () => this.openAICustomizationSection(AICustomizationManagementSection.Skills), getSourceCounts: () => this.getSkillSourceCounts() },
			{ label: localize('instructions', "Instructions"), icon: instructionsIcon, action: () => this.openAICustomizationSection(AICustomizationManagementSection.Instructions), getSourceCounts: () => this.getPromptSourceCounts(PromptsType.instructions) },
			{ label: localize('prompts', "Prompts"), icon: promptIcon, action: () => this.openAICustomizationSection(AICustomizationManagementSection.Prompts), getSourceCounts: () => this.getPromptSourceCounts(PromptsType.prompt) },
			{ label: localize('hooks', "Hooks"), icon: hookIcon, action: () => this.openAICustomizationSection(AICustomizationManagementSection.Hooks), getSourceCounts: () => this.getPromptSourceCounts(PromptsType.hook) },
			{ label: localize('mcpServers', "MCP Servers"), icon: Codicon.server, action: () => this.openAICustomizationSection(AICustomizationManagementSection.McpServers), getCount: () => Promise.resolve(this.mcpService.servers.get().length) },
			{ label: localize('models', "Models"), icon: Codicon.vm, action: () => this.openAICustomizationSection(AICustomizationManagementSection.Models), getCount: () => Promise.resolve(this.languageModelsService.getLanguageModelIds().length) },
		];

		this._register(this.promptsService.onDidChangeCustomAgents(() => this.updateCounts()));
		this._register(this.promptsService.onDidChangeSlashCommands(() => this.updateCounts()));
		this._register(this.languageModelsService.onDidChangeLanguageModels(() => this.updateCounts()));
		this._register(autorun(reader => { this.mcpService.servers.read(reader); this.updateCounts(); }));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.updateCounts()));
		this._register(autorun(reader => { this.activeSessionService.activeSession.read(reader); this.updateCounts(); }));
		this._register(this.copilotSdkService.onSessionLifecycle(() => { this.refreshSessionList(); }));
		this._register(this._sessionListDisposables);
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		this.viewPaneContainer = parent;
		this.viewPaneContainer.classList.add('agent-sessions-viewpane');
		this.createControls(parent);
	}

	private createControls(parent: HTMLElement): void {
		const sessionsContainer = DOM.append(parent, $('.agent-sessions-container'));
		const sessionsSection = DOM.append(sessionsContainer, $('.agent-sessions-section'));
		const sessionsContent = DOM.append(sessionsSection, $('.agent-sessions-content'));

		// New Session Button
		const newSessionButtonContainer = DOM.append(sessionsContent, $('.agent-sessions-new-button-container'));
		const newSessionButton = this._register(new Button(newSessionButtonContainer, { ...defaultButtonStyles, secondary: true }));
		newSessionButton.label = localize('newSession', "New Session");
		this._register(newSessionButton.onDidClick(() => this.createNewSdkSession()));

		const keybinding = this.keybindingService.lookupKeybinding(NEW_SDK_SESSION_ID);
		if (keybinding) {
			const keybindingHint = DOM.append(newSessionButton.element, $('span.new-session-keybinding-hint'));
			keybindingHint.textContent = keybinding.getLabel() ?? '';
		}

		// Sessions list (SDK-powered)
		this.sessionsListContainer = DOM.append(sessionsContent, $('.agent-sessions-control-container'));
		this.renderSessionList();

		// AI Customization shortcuts
		this.aiCustomizationContainer = DOM.append(sessionsContainer, $('.ai-customization-shortcuts'));
		this.createAICustomizationShortcuts(this.aiCustomizationContainer);

		this.refreshSessionList();
	}

	private async refreshSessionList(): Promise<void> {
		try {
			this._sdkSessions = await this.copilotSdkService.listSessions();
		} catch (err) {
			this.logService.error('[SessionsViewPane] Failed to list SDK sessions:', err);
			this._sdkSessions = [];
		}
		this.renderSessionList();
	}

	private renderSessionList(): void {
		if (!this.sessionsListContainer) {
			return;
		}

		this._sessionListDisposables.clear();
		DOM.clearNode(this.sessionsListContainer);

		if (this._sdkSessions.length === 0) {
			const empty = DOM.append(this.sessionsListContainer, $('.sdk-session-list-empty'));
			empty.textContent = localize('noSessions', "No sessions yet");
			return;
		}

		for (const session of this._sdkSessions) {
			const item = DOM.append(this.sessionsListContainer, $('.sdk-session-item'));
			item.tabIndex = 0;
			item.setAttribute('role', 'listitem');
			item.setAttribute('data-session-id', session.sessionId);

			if (session.sessionId === this._selectedSessionId) {
				item.classList.add('selected');
			}

			const icon = DOM.append(item, $('span.sdk-session-icon'));
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.commentDiscussion));

			const details = DOM.append(item, $('span.sdk-session-details'));
			const label = DOM.append(details, $('span.sdk-session-label'));
			label.textContent = session.summary || localize('untitledSession', "Untitled Session");

			// Subtitle: repo/branch or workspace path or session ID
			const subtitle = session.repository
				? (session.branch ? `${session.repository} (${session.branch})` : session.repository)
				: session.workspacePath ?? session.sessionId.substring(0, 8);
			const pathEl = DOM.append(details, $('span.sdk-session-path'));
			pathEl.textContent = subtitle;

			// Relative time
			if (session.modifiedTime || session.startTime) {
				const timeStr = session.modifiedTime ?? session.startTime;
				const timeEl = DOM.append(item, $('span.sdk-session-time'));
				const date = new Date(timeStr!);
				const ago = this._relativeTime(date);
				timeEl.textContent = ago;
			}

			this._sessionListDisposables.add(DOM.addDisposableListener(item, 'click', () => {
				this.selectSession(session.sessionId);
			}));
			this._sessionListDisposables.add(DOM.addDisposableListener(item, 'keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					this.selectSession(session.sessionId);
				}
			}));
		}
	}

	private selectSession(sessionId: string): void {
		this._selectedSessionId = sessionId;

		if (this.sessionsListContainer) {
			for (const child of this.sessionsListContainer.children) {
				child.classList.toggle('selected', (child as HTMLElement).getAttribute('data-session-id') === sessionId);
			}
		}

		const chatPane = this.viewsService.getViewWithId<SdkChatViewPane>(SdkChatViewId);
		if (chatPane?.widget) {
			chatPane.widget.loadSession(sessionId);
		}
	}

	private async createNewSdkSession(): Promise<void> {
		const chatPane = this.viewsService.getViewWithId<SdkChatViewPane>(SdkChatViewId);
		if (chatPane?.widget) {
			await chatPane.widget.newSession();
			this._selectedSessionId = undefined;
			this.renderSessionList();
		}
	}

	private _relativeTime(date: Date): string {
		const now = Date.now();
		const diffMs = now - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		if (diffMins < 1) { return localize('justNow', "just now"); }
		if (diffMins < 60) { return localize('minutesAgo', "{0}m ago", diffMins); }
		const diffHours = Math.floor(diffMins / 60);
		if (diffHours < 24) { return localize('hoursAgo', "{0}h ago", diffHours); }
		const diffDays = Math.floor(diffHours / 24);
		if (diffDays < 7) { return localize('daysAgo', "{0}d ago", diffDays); }
		return date.toLocaleDateString();
	}

	private createAICustomizationShortcuts(container: HTMLElement): void {
		const isCollapsed = this.storageService.getBoolean(CUSTOMIZATIONS_COLLAPSED_KEY, StorageScope.PROFILE, false);

		const header = DOM.append(container, $('.ai-customization-header'));
		header.tabIndex = 0;
		header.setAttribute('role', 'button');
		header.setAttribute('aria-expanded', String(!isCollapsed));

		const headerText = DOM.append(header, $('span'));
		headerText.textContent = localize('customizations', "CUSTOMIZATIONS");

		const chevron = DOM.append(header, $('.ai-customization-chevron'));
		chevron.classList.add(...ThemeIcon.asClassNameArray(isCollapsed ? Codicon.chevronRight : Codicon.chevronDown));

		const linksContainer = DOM.append(container, $('.ai-customization-links'));
		if (isCollapsed) {
			linksContainer.classList.add('collapsed');
		}

		const toggleCollapse = () => {
			const collapsed = linksContainer.classList.toggle('collapsed');
			this.storageService.store(CUSTOMIZATIONS_COLLAPSED_KEY, collapsed, StorageScope.PROFILE, StorageTarget.USER);
			header.setAttribute('aria-expanded', String(!collapsed));
			chevron.classList.remove(...ThemeIcon.asClassNameArray(Codicon.chevronRight), ...ThemeIcon.asClassNameArray(Codicon.chevronDown));
			chevron.classList.add(...ThemeIcon.asClassNameArray(collapsed ? Codicon.chevronRight : Codicon.chevronDown));

			const onTransitionEnd = () => {
				linksContainer.removeEventListener('transitionend', onTransitionEnd);
				if (this.viewPaneContainer) {
					const { offsetHeight, offsetWidth } = this.viewPaneContainer;
					this.layoutBody(offsetHeight, offsetWidth);
				}
			};
			linksContainer.addEventListener('transitionend', onTransitionEnd);
		};

		this._register(DOM.addDisposableListener(header, 'click', toggleCollapse));
		this._register(DOM.addDisposableListener(header, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				toggleCollapse();
			}
		}));

		for (const shortcut of this.shortcuts) {
			const link = DOM.append(linksContainer, $('a.ai-customization-link'));
			link.tabIndex = 0;
			link.setAttribute('role', 'button');
			link.setAttribute('aria-label', shortcut.label);

			const iconElement = DOM.append(link, $('.link-icon'));
			iconElement.classList.add(...ThemeIcon.asClassNameArray(shortcut.icon));

			const labelElement = DOM.append(link, $('.link-label'));
			labelElement.textContent = shortcut.label;

			const countContainer = DOM.append(link, $('.link-counts'));
			shortcut.countContainer = countContainer;

			this._register(DOM.addDisposableListener(link, 'click', (e) => {
				DOM.EventHelper.stop(e);
				shortcut.action();
			}));

			this._register(DOM.addDisposableListener(link, 'keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					shortcut.action();
				}
			}));
		}

		this.updateCounts();
	}

	private async updateCounts(): Promise<void> {
		for (const shortcut of this.shortcuts) {
			if (!shortcut.countContainer) { continue; }
			if (shortcut.getSourceCounts) {
				const counts = await shortcut.getSourceCounts();
				this.renderSourceCounts(shortcut.countContainer, counts);
			} else if (shortcut.getCount) {
				const count = await shortcut.getCount();
				this.renderSimpleCount(shortcut.countContainer, count);
			}
		}
	}

	private renderSourceCounts(container: HTMLElement, counts: ISourceCounts): void {
		DOM.clearNode(container);
		const total = counts.workspace + counts.user + counts.extension;
		container.classList.toggle('hidden', total === 0);
		if (total === 0) { return; }

		const sources: { count: number; icon: ThemeIcon; title: string }[] = [
			{ count: counts.workspace, icon: workspaceIcon, title: localize('workspaceCount', "{0} from workspace", counts.workspace) },
			{ count: counts.user, icon: userIcon, title: localize('userCount', "{0} from user", counts.user) },
			{ count: counts.extension, icon: extensionIcon, title: localize('extensionCount', "{0} from extensions", counts.extension) },
		];

		for (const source of sources) {
			if (source.count === 0) { continue; }
			const badge = DOM.append(container, $('.source-count-badge'));
			badge.title = source.title;
			const badgeIcon = DOM.append(badge, $('.source-count-icon'));
			badgeIcon.classList.add(...ThemeIcon.asClassNameArray(source.icon));
			const num = DOM.append(badge, $('.source-count-num'));
			num.textContent = `${source.count}`;
		}
	}

	private renderSimpleCount(container: HTMLElement, count: number): void {
		DOM.clearNode(container);
		container.classList.toggle('hidden', count === 0);
		if (count > 0) {
			const badge = DOM.append(container, $('.source-count-badge'));
			const num = DOM.append(badge, $('.source-count-num'));
			num.textContent = `${count}`;
		}
	}

	private async getPromptSourceCounts(promptType: PromptsType): Promise<ISourceCounts> {
		const [workspaceItems, userItems, extensionItems] = await Promise.all([
			this.promptsService.listPromptFilesForStorage(promptType, PromptsStorage.local, CancellationToken.None),
			this.promptsService.listPromptFilesForStorage(promptType, PromptsStorage.user, CancellationToken.None),
			this.promptsService.listPromptFilesForStorage(promptType, PromptsStorage.extension, CancellationToken.None),
		]);
		return { workspace: workspaceItems.length, user: userItems.length, extension: extensionItems.length };
	}

	private async getSkillSourceCounts(): Promise<ISourceCounts> {
		const skills = await this.promptsService.findAgentSkills(CancellationToken.None);
		if (!skills || skills.length === 0) { return { workspace: 0, user: 0, extension: 0 }; }
		return {
			workspace: skills.filter(s => s.storage === PromptsStorage.local).length,
			user: skills.filter(s => s.storage === PromptsStorage.user).length,
			extension: skills.filter(s => s.storage === PromptsStorage.extension).length,
		};
	}

	private async openAICustomizationSection(sectionId: AICustomizationManagementSection): Promise<void> {
		const input = AICustomizationManagementEditorInput.getOrCreate();
		const editor = await this.editorGroupsService.activeGroup.openEditor(input, { pinned: true });
		if (editor instanceof AICustomizationManagementEditor) {
			editor.selectSectionById(sectionId);
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	override focus(): void {
		super.focus();
	}

	refresh(): void {
		this.refreshSessionList();
	}
}

// Register Cmd+N / Ctrl+N keybinding for new session
KeybindingsRegistry.registerKeybindingRule({
	id: NEW_SDK_SESSION_ID,
	weight: KeybindingWeight.WorkbenchContrib + 1,
	primary: KeyMod.CtrlCmd | KeyCode.KeyN,
});

registerAction2(class NewSdkSessionAction extends Action2 {
	constructor() {
		super({ id: NEW_SDK_SESSION_ID, title: localize2('newSdkSession', "New Session"), icon: Codicon.add, f1: true });
	}
	override async run(accessor: ServicesAccessor) {
		const viewsService = accessor.get(IViewsService);
		const chatPane = viewsService.getViewWithId<SdkChatViewPane>(SdkChatViewId);
		if (chatPane?.widget) { await chatPane.widget.newSession(); }
	}
});

registerAction2(class RefreshAgentSessionsViewerAction extends Action2 {
	constructor() {
		super({
			id: 'sessionsView.refresh',
			title: localize2('refresh', "Refresh Agent Sessions"),
			icon: Codicon.refresh,
			menu: [{ id: MenuId.ViewTitle, group: 'navigation', order: 1, when: ContextKeyExpr.equals('view', SessionsViewId) }],
		});
	}
	override run(accessor: ServicesAccessor) {
		const viewsService = accessor.get(IViewsService);
		const view = viewsService.getViewWithId<AgenticSessionsViewPane>(SessionsViewId);
		return view?.refresh();
	}
});
