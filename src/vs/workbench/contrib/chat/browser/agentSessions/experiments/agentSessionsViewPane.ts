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
import { ModelsManagementEditorInput } from '../../chatManagement/chatManagementEditorInput.js';
import { agentIcon, instructionsIcon, promptIcon, skillIcon } from '../../aiCustomizationTreeView/aiCustomizationTreeViewIcons.js';
import { IPromptsService, PromptsStorage } from '../../../common/promptSyntax/service/promptsService.js';
import { PromptsType } from '../../../common/promptSyntax/promptTypes.js';
import { ILanguageModelsService } from '../../../common/languageModels.js';
import { IMcpService } from '../../../../mcp/common/mcpTypes.js';
import { McpManagementEditorInput } from '../../aiCustomizationManagement/mcpManagementEditorInput.js';

interface IShortcutItem {
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly action: () => Promise<void>;
	readonly getCount?: () => Promise<number>;
	countElement?: HTMLElement;
}

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// Initialize shortcuts
		this.shortcuts = [
			{ label: localize('agents', "Agents"), icon: agentIcon, action: () => this.openAICustomizationSection(AICustomizationManagementSection.Agents), getCount: () => this.getPromptCount(PromptsType.agent) },
			{ label: localize('skills', "Skills"), icon: skillIcon, action: () => this.openAICustomizationSection(AICustomizationManagementSection.Skills), getCount: () => this.getSkillCount() },
			{ label: localize('instructions', "Instructions"), icon: instructionsIcon, action: () => this.openAICustomizationSection(AICustomizationManagementSection.Instructions), getCount: () => this.getPromptCount(PromptsType.instructions) },
			{ label: localize('prompts', "Prompts"), icon: promptIcon, action: () => this.openAICustomizationSection(AICustomizationManagementSection.Prompts), getCount: () => this.getPromptCount(PromptsType.prompt) },
			{ label: localize('models', "Models"), icon: Codicon.sparkle, action: () => this.openModelsEditor(), getCount: () => Promise.resolve(this.languageModelsService.getLanguageModelIds().length) },
			{ label: localize('mcpServers', "MCP Servers"), icon: Codicon.server, action: () => this.openMcpServersEditor(), getCount: () => Promise.resolve(this.mcpService.servers.get().length) },
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

		// Sessions header
		const sessionsHeader = append(sessionsSection, $('.agent-sessions-header'));
		sessionsHeader.textContent = localize('sessions', "SESSIONS");

		// New Session Button
		const newSessionButtonContainer = this.newSessionButtonContainer = append(sessionsSection, $('.agent-sessions-new-button-container'));
		const newSessionButton = this._register(new Button(newSessionButtonContainer, { ...defaultButtonStyles, secondary: true }));
		newSessionButton.label = localize('newSession', "New Session");
		this._register(newSessionButton.onDidClick(() => this.commandService.executeCommand(ACTION_ID_NEW_CHAT)));

		// Sessions Control
		this.sessionsControlContainer = append(sessionsSection, $('.agent-sessions-control-container'));
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
		// Header
		const header = DOM.append(container, $('.ai-customization-header'));
		header.textContent = localize('customizations', "CUSTOMIZATIONS");

		// Links container
		const linksContainer = DOM.append(container, $('.ai-customization-links'));

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

	private async openModelsEditor(): Promise<void> {
		await this.editorGroupsService.activeGroup.openEditor(new ModelsManagementEditorInput(), { pinned: true });
	}

	private async openMcpServersEditor(): Promise<void> {
		await this.editorGroupsService.activeGroup.openEditor(new McpManagementEditorInput(), { pinned: true });
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
