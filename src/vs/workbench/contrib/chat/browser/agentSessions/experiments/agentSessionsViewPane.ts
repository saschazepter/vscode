/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentSessionsViewPane.css';
import * as DOM from '../../../../../../base/browser/dom.js';
import { $, append } from '../../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { autorun } from '../../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../../common/views.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { localize } from '../../../../../../nls.js';
import { AgentSessionsControl } from '../agentSessionsControl.js';
import { AgentSessionsFilter, AgentSessionsGrouping } from '../agentSessionsFilter.js';
import { MenuId } from '../../../../../../platform/actions/common/actions.js';
import { HoverPosition } from '../../../../../../base/browser/ui/hover/hoverWidget.js';
import { IWorkbenchLayoutService } from '../../../../../services/layout/browser/layoutService.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ACTION_ID_NEW_CHAT } from '../../actions/chatActions.js';
import { IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { AICustomizationManagementSection } from '../../aiCustomizationManagement/aiCustomizationManagement.js';
import { AICustomizationManagementEditorInput } from '../../aiCustomizationManagement/aiCustomizationManagementEditorInput.js';
import { AICustomizationManagementEditor } from '../../aiCustomizationManagement/aiCustomizationManagementEditor.js';
import { agentIcon, instructionsIcon, promptIcon, skillIcon, hookIcon } from '../../aiCustomizationTreeView/aiCustomizationTreeViewIcons.js';
import { IPromptsService, PromptsStorage } from '../../../common/promptSyntax/service/promptsService.js';
import { PromptsType } from '../../../common/promptSyntax/promptTypes.js';
import { ILanguageModelsService } from '../../../common/languageModels.js';
import { IMcpService } from '../../../../mcp/common/mcpTypes.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';

interface IShortcutItem {
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly action: () => Promise<void>;
	readonly getCount?: () => Promise<number>;
	countElement?: HTMLElement;
}

const CUSTOMIZATIONS_COLLAPSED_KEY = 'agentSessions.customizationsCollapsed';
const SESSIONS_COLLAPSED_KEY = 'agentSessions.sessionsCollapsed';

export class AgentSessionsViewPane extends ViewPane {

	private viewPaneContainer: HTMLElement | undefined;
	private newSessionButtonContainer: HTMLElement | undefined;
	private sessionsControlContainer: HTMLElement | undefined;
	private sessionsControl: AgentSessionsControl | undefined;
	private readonly shortcuts: IShortcutItem[] = [];

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
		@ICommandService private readonly commandService: ICommandService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IPromptsService private readonly promptsService: IPromptsService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IMcpService private readonly mcpService: IMcpService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// Initialize shortcuts
		this.shortcuts = [
			{ label: localize('agents', "Agents"), icon: agentIcon, action: () => this.openAICustomizationSection(AICustomizationManagementSection.Agents), getCount: () => this.getPromptCount(PromptsType.agent) },
			{ label: localize('skills', "Skills"), icon: skillIcon, action: () => this.openAICustomizationSection(AICustomizationManagementSection.Skills), getCount: () => this.getSkillCount() },
			{ label: localize('instructions', "Instructions"), icon: instructionsIcon, action: () => this.openAICustomizationSection(AICustomizationManagementSection.Instructions), getCount: () => this.getPromptCount(PromptsType.instructions) },
			{ label: localize('prompts', "Prompts"), icon: promptIcon, action: () => this.openAICustomizationSection(AICustomizationManagementSection.Prompts), getCount: () => this.getPromptCount(PromptsType.prompt) },
			{ label: localize('hooks', "Hooks"), icon: hookIcon, action: () => this.openAICustomizationSection(AICustomizationManagementSection.Hooks), getCount: () => this.getPromptCount(PromptsType.hook) },
			{ label: localize('mcpServers', "MCP Servers"), icon: Codicon.server, action: () => this.openAICustomizationSection(AICustomizationManagementSection.McpServers), getCount: () => Promise.resolve(this.mcpService.servers.get().length) },
			{ label: localize('models', "Models"), icon: Codicon.sparkle, action: () => this.openAICustomizationSection(AICustomizationManagementSection.Models), getCount: () => Promise.resolve(this.languageModelsService.getLanguageModelIds().length) },
		];

		// Listen to changes to update counts
		this._register(this.promptsService.onDidChangeCustomAgents(() => this.updateCounts()));
		this._register(this.promptsService.onDidChangeSlashCommands(() => this.updateCounts()));
		this._register(this.languageModelsService.onDidChangeLanguageModels(() => this.updateCounts()));
		this._register(autorun(reader => {
			this.mcpService.servers.read(reader);
			this.updateCounts();
		}));
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);

		this.viewPaneContainer = parent;
		this.viewPaneContainer.classList.add('agent-sessions-viewpane');

		this.createControls(parent);
	}

	private createControls(parent: HTMLElement): void {
		const sessionsContainer = append(parent, $('.agent-sessions-container'));

		// Sessions Filter (actions go to view title bar via menu registration)
		const sessionsFilter = this._register(this.instantiationService.createInstance(AgentSessionsFilter, {
			filterMenuId: MenuId.AgentSessionsViewFilterSubMenu,
			groupResults: () => AgentSessionsGrouping.Date
		}));

		// AI Customization shortcuts (compact row of links)
		const aiCustomizationContainer = append(sessionsContainer, $('.ai-customization-shortcuts'));
		this.createAICustomizationShortcuts(aiCustomizationContainer);

		// Sessions section
		const sessionsSection = append(sessionsContainer, $('.agent-sessions-section'));

		// Sessions header (collapsible)
		const sessionsCollapsed = this.storageService.getBoolean(SESSIONS_COLLAPSED_KEY, StorageScope.PROFILE, false);
		const sessionsHeader = append(sessionsSection, $('.agent-sessions-header'));
		sessionsHeader.tabIndex = 0;
		sessionsHeader.setAttribute('role', 'button');
		sessionsHeader.setAttribute('aria-expanded', String(!sessionsCollapsed));

		const sessionsHeaderText = DOM.append(sessionsHeader, $('span'));
		sessionsHeaderText.textContent = localize('sessions', "SESSIONS");

		const sessionsChevron = DOM.append(sessionsHeader, $('.agent-sessions-chevron'));
		sessionsChevron.classList.add(...ThemeIcon.asClassNameArray(sessionsCollapsed ? Codicon.chevronRight : Codicon.chevronDown));

		// Sessions content container (for collapse)
		const sessionsContent = append(sessionsSection, $('.agent-sessions-content'));
		if (sessionsCollapsed) {
			sessionsContent.classList.add('collapsed');
		}

		// Toggle collapse on sessions header click
		const toggleSessionsCollapse = () => {
			const collapsed = sessionsContent.classList.toggle('collapsed');
			this.storageService.store(SESSIONS_COLLAPSED_KEY, collapsed, StorageScope.PROFILE, StorageTarget.USER);
			sessionsHeader.setAttribute('aria-expanded', String(!collapsed));
			sessionsChevron.classList.remove(...ThemeIcon.asClassNameArray(Codicon.chevronRight), ...ThemeIcon.asClassNameArray(Codicon.chevronDown));
			sessionsChevron.classList.add(...ThemeIcon.asClassNameArray(collapsed ? Codicon.chevronRight : Codicon.chevronDown));
		};

		this._register(DOM.addDisposableListener(sessionsHeader, 'click', toggleSessionsCollapse));
		this._register(DOM.addDisposableListener(sessionsHeader, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				toggleSessionsCollapse();
			}
		}));

		// New Session Button
		const newSessionButtonContainer = this.newSessionButtonContainer = append(sessionsContent, $('.agent-sessions-new-button-container'));
		const newSessionButton = this._register(new Button(newSessionButtonContainer, { ...defaultButtonStyles, secondary: true }));
		newSessionButton.label = localize('newSession', "New Session");
		this._register(newSessionButton.onDidClick(() => this.commandService.executeCommand(ACTION_ID_NEW_CHAT)));

		// Sessions Control
		this.sessionsControlContainer = append(sessionsContent, $('.agent-sessions-control-container'));
		const sessionsControl = this.sessionsControl = this._register(this.instantiationService.createInstance(AgentSessionsControl, this.sessionsControlContainer, {
			source: 'agentSessionsViewPane',
			filter: sessionsFilter,
			overrideStyles: this.getLocationBasedColors().listOverrideStyles,
			getHoverPosition: () => this.getSessionHoverPosition(),
			trackActiveEditorSession: () => true,
			collapseOlderSections: () => true,
		}));
		this._register(this.onDidChangeBodyVisibility(visible => sessionsControl.setVisible(visible)));
	}

	private createAICustomizationShortcuts(container: HTMLElement): void {
		// Get initial collapsed state
		const isCollapsed = this.storageService.getBoolean(CUSTOMIZATIONS_COLLAPSED_KEY, StorageScope.PROFILE, false);

		// Header (clickable to toggle)
		const header = DOM.append(container, $('.ai-customization-header'));
		header.tabIndex = 0;
		header.setAttribute('role', 'button');
		header.setAttribute('aria-expanded', String(!isCollapsed));

		// Header text
		const headerText = DOM.append(header, $('span'));
		headerText.textContent = localize('customizations', "CUSTOMIZATIONS");

		// Chevron icon (right-aligned, shown on hover)
		const chevron = DOM.append(header, $('.ai-customization-chevron'));
		chevron.classList.add(...ThemeIcon.asClassNameArray(isCollapsed ? Codicon.chevronRight : Codicon.chevronDown));

		// Links container
		const linksContainer = DOM.append(container, $('.ai-customization-links'));
		if (isCollapsed) {
			linksContainer.classList.add('collapsed');
		}

		// Toggle collapse on header click
		const toggleCollapse = () => {
			const collapsed = linksContainer.classList.toggle('collapsed');
			this.storageService.store(CUSTOMIZATIONS_COLLAPSED_KEY, collapsed, StorageScope.PROFILE, StorageTarget.USER);
			header.setAttribute('aria-expanded', String(!collapsed));
			chevron.classList.remove(...ThemeIcon.asClassNameArray(Codicon.chevronRight), ...ThemeIcon.asClassNameArray(Codicon.chevronDown));
			chevron.classList.add(...ThemeIcon.asClassNameArray(collapsed ? Codicon.chevronRight : Codicon.chevronDown));
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

			// Icon
			const iconElement = DOM.append(link, $('.link-icon'));
			iconElement.classList.add(...ThemeIcon.asClassNameArray(shortcut.icon));

			// Label
			const labelElement = DOM.append(link, $('.link-label'));
			labelElement.textContent = shortcut.label;

			// Count badge (right-aligned)
			const countElement = DOM.append(link, $('.link-count'));
			shortcut.countElement = countElement;

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

		// Load initial counts
		this.updateCounts();
	}

	private async updateCounts(): Promise<void> {
		for (const shortcut of this.shortcuts) {
			if (!shortcut.getCount || !shortcut.countElement) {
				continue;
			}

			const count = await shortcut.getCount();
			shortcut.countElement.textContent = count > 0 ? `${count}` : '';
			shortcut.countElement.classList.toggle('hidden', count === 0);
		}
	}

	private async getPromptCount(promptType: PromptsType): Promise<number> {
		const [workspaceItems, userItems, extensionItems] = await Promise.all([
			this.promptsService.listPromptFilesForStorage(promptType, PromptsStorage.local, CancellationToken.None),
			this.promptsService.listPromptFilesForStorage(promptType, PromptsStorage.user, CancellationToken.None),
			this.promptsService.listPromptFilesForStorage(promptType, PromptsStorage.extension, CancellationToken.None),
		]);
		return workspaceItems.length + userItems.length + extensionItems.length;
	}

	private async getSkillCount(): Promise<number> {
		const skills = await this.promptsService.findAgentSkills(CancellationToken.None);
		return skills?.length || 0;
	}

	private async openAICustomizationSection(sectionId: AICustomizationManagementSection): Promise<void> {
		const input = AICustomizationManagementEditorInput.getOrCreate();
		const editor = await this.editorGroupsService.activeGroup.openEditor(input, { pinned: true });

		if (editor instanceof AICustomizationManagementEditor) {
			editor.selectSectionById(sectionId);
		}
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

		if (!this.sessionsControl || !this.newSessionButtonContainer) {
			return;
		}

		const buttonHeight = this.newSessionButtonContainer.offsetHeight;
		const availableSessionsHeight = height - buttonHeight;
		this.sessionsControl.layout(availableSessionsHeight, width);
	}

	override focus(): void {
		super.focus();

		this.sessionsControl?.focus();
	}

	refresh(): void {
		this.sessionsControl?.refresh();
	}

	openFind(): void {
		this.sessionsControl?.openFind();
	}
}
