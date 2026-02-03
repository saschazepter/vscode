/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomization.css';
import * as dom from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, dirname } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { getContextMenuActions } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenuService, MenuId } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchAsyncDataTree } from '../../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IPromptsService, PromptsStorage, IAgentSkill } from '../../common/promptSyntax/service/promptsService.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { agentIcon, extensionIcon, instructionsIcon, promptIcon, skillIcon, userIcon, workspaceIcon } from './aiCustomizationIcons.js';
import { AgentsViewItemMenuId, InstructionsViewItemMenuId, PromptsViewItemMenuId, SkillsViewItemMenuId } from './aiCustomization.js';
import { IAsyncDataSource, ITreeNode, ITreeRenderer, ITreeContextMenuEvent } from '../../../../../base/browser/ui/tree/tree.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';

//#region Tree Item Types

/**
 * Represents a group header in the tree (e.g., "Workspace", "User", "Extensions").
 */
interface IAICustomizationGroupItem {
	readonly type: 'group';
	readonly id: string;
	readonly label: string;
	readonly storage: PromptsStorage;
	readonly icon: ThemeIcon;
}

/**
 * Represents an individual AI customization item (agent, skill, instruction, or prompt).
 */
interface IAICustomizationFileItem {
	readonly type: 'file';
	readonly id: string;
	readonly uri: URI;
	readonly name: string;
	readonly description?: string;
	readonly storage: PromptsStorage;
	readonly promptType: PromptsType;
}

type AICustomizationTreeItem = IAICustomizationGroupItem | IAICustomizationFileItem;

//#endregion

//#region Tree Infrastructure

class AICustomizationTreeDelegate implements IListVirtualDelegate<AICustomizationTreeItem> {
	getHeight(_element: AICustomizationTreeItem): number {
		return 22;
	}

	getTemplateId(element: AICustomizationTreeItem): string {
		return element.type === 'group' ? 'group' : 'file';
	}
}

interface IGroupTemplateData {
	readonly container: HTMLElement;
	readonly label: HTMLElement;
}

interface IFileTemplateData {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
	readonly description: HTMLElement;
}

class AICustomizationGroupRenderer implements ITreeRenderer<IAICustomizationGroupItem, FuzzyScore, IGroupTemplateData> {
	readonly templateId = 'group';

	renderTemplate(container: HTMLElement): IGroupTemplateData {
		const element = dom.append(container, dom.$('.ai-customization-group-header'));
		const label = dom.append(element, dom.$('.label'));
		return { container: element, label };
	}

	renderElement(node: ITreeNode<IAICustomizationGroupItem, FuzzyScore>, _index: number, templateData: IGroupTemplateData): void {
		templateData.label.textContent = node.element.label;
	}

	disposeTemplate(_templateData: IGroupTemplateData): void { }
}

class AICustomizationFileRenderer implements ITreeRenderer<IAICustomizationFileItem, FuzzyScore, IFileTemplateData> {
	readonly templateId = 'file';

	renderTemplate(container: HTMLElement): IFileTemplateData {
		const element = dom.append(container, dom.$('.ai-customization-tree-item'));
		const icon = dom.append(element, dom.$('.icon'));
		const name = dom.append(element, dom.$('.name'));
		const description = dom.append(element, dom.$('.description'));
		return { container: element, icon, name, description };
	}

	renderElement(node: ITreeNode<IAICustomizationFileItem, FuzzyScore>, _index: number, templateData: IFileTemplateData): void {
		const item = node.element;

		// Set icon based on prompt type
		let icon: ThemeIcon;
		switch (item.promptType) {
			case PromptsType.agent:
				icon = agentIcon;
				break;
			case PromptsType.skill:
				icon = skillIcon;
				break;
			case PromptsType.instructions:
				icon = instructionsIcon;
				break;
			case PromptsType.prompt:
			default:
				icon = promptIcon;
				break;
		}

		templateData.icon.className = 'icon';
		templateData.icon.classList.add(...ThemeIcon.asClassNameArray(icon));

		templateData.name.textContent = item.name;
		templateData.description.textContent = item.description || '';

		// Set tooltip with name and description
		const tooltip = item.description ? `${item.name} - ${item.description}` : item.name;
		templateData.container.title = tooltip;
	}

	disposeTemplate(_templateData: IFileTemplateData): void { }
}

class AICustomizationDataSource implements IAsyncDataSource<PromptsType, AICustomizationTreeItem> {
	private cachedSkills: IAgentSkill[] | undefined;

	constructor(
		private readonly promptsService: IPromptsService,
		private readonly promptType: PromptsType,
	) { }

	hasChildren(element: PromptsType | AICustomizationTreeItem): boolean {
		if (typeof element === 'string') {
			// Root element (the PromptsType)
			return true;
		}
		return element.type === 'group';
	}

	async getChildren(element: PromptsType | AICustomizationTreeItem): Promise<AICustomizationTreeItem[]> {
		if (typeof element === 'string') {
			// Root: return grouped items
			return this.getGroupedItems();
		}

		if (element.type === 'group') {
			// Get files for this storage type
			return this.getFilesForStorage(element.storage);
		}

		return [];
	}

	private async getGroupedItems(): Promise<IAICustomizationGroupItem[]> {
		const groups: IAICustomizationGroupItem[] = [];

		// For skills, use findAgentSkills which has the proper names
		if (this.promptType === PromptsType.skill) {
			const skills = await this.promptsService.findAgentSkills(CancellationToken.None);
			this.cachedSkills = skills || [];

			const workspaceSkills = this.cachedSkills.filter(s => s.storage === PromptsStorage.local);
			const userSkills = this.cachedSkills.filter(s => s.storage === PromptsStorage.user);
			const extensionSkills = this.cachedSkills.filter(s => s.storage === PromptsStorage.extension);

			if (workspaceSkills.length > 0) {
				groups.push({
					type: 'group',
					id: 'workspace',
					label: localize('workspace', "Workspace"),
					storage: PromptsStorage.local,
					icon: workspaceIcon,
				});
			}

			if (userSkills.length > 0) {
				groups.push({
					type: 'group',
					id: 'user',
					label: localize('user', "User"),
					storage: PromptsStorage.user,
					icon: userIcon,
				});
			}

			if (extensionSkills.length > 0) {
				groups.push({
					type: 'group',
					id: 'extensions',
					label: localize('extensions', "Extensions"),
					storage: PromptsStorage.extension,
					icon: extensionIcon,
				});
			}

			return groups;
		}

		// For other types, use listPromptFilesForStorage
		const [workspaceItems, userItems, extensionItems] = await Promise.all([
			this.promptsService.listPromptFilesForStorage(this.promptType, PromptsStorage.local, CancellationToken.None),
			this.promptsService.listPromptFilesForStorage(this.promptType, PromptsStorage.user, CancellationToken.None),
			this.promptsService.listPromptFilesForStorage(this.promptType, PromptsStorage.extension, CancellationToken.None),
		]);

		if (workspaceItems.length > 0) {
			groups.push({
				type: 'group',
				id: 'workspace',
				label: localize('workspace', "Workspace"),
				storage: PromptsStorage.local,
				icon: workspaceIcon,
			});
		}

		if (userItems.length > 0) {
			groups.push({
				type: 'group',
				id: 'user',
				label: localize('user', "User"),
				storage: PromptsStorage.user,
				icon: userIcon,
			});
		}

		if (extensionItems.length > 0) {
			groups.push({
				type: 'group',
				id: 'extensions',
				label: localize('extensions', "Extensions"),
				storage: PromptsStorage.extension,
				icon: extensionIcon,
			});
		}

		return groups;
	}

	private async getFilesForStorage(storage: PromptsStorage): Promise<IAICustomizationFileItem[]> {
		// For skills, use findAgentSkills which has proper names from frontmatter
		if (this.promptType === PromptsType.skill) {
			// Ensure we have cached skills, fetch if needed
			if (!this.cachedSkills) {
				const skills = await this.promptsService.findAgentSkills(CancellationToken.None);
				this.cachedSkills = skills || [];
			}

			return this.cachedSkills
				.filter(skill => skill.storage === storage)
				.map(skill => {
					// Use skill name from frontmatter, or fallback to parent folder name
					// Skills are stored as skill-name/SKILL.md, so the parent folder is the skill name
					const skillName = skill.name || basename(dirname(skill.uri)) || basename(skill.uri);
					return {
						type: 'file' as const,
						id: skill.uri.toString(),
						uri: skill.uri,
						name: skillName,
						description: skill.description,
						storage: skill.storage,
						promptType: this.promptType,
					};
				});
		}

		const items = await this.promptsService.listPromptFilesForStorage(this.promptType, storage, CancellationToken.None);

		return items.map(item => ({
			type: 'file' as const,
			id: item.uri.toString(),
			uri: item.uri,
			name: item.name || basename(item.uri),
			description: item.description,
			storage: item.storage,
			promptType: this.promptType,
		}));
	}
}

//#endregion

//#region Base View Pane

/**
 * Base class for AI Customization view panes that display tree views.
 */
export abstract class AICustomizationTreeViewPane extends ViewPane {

	protected tree: WorkbenchAsyncDataTree<PromptsType, AICustomizationTreeItem, FuzzyScore> | undefined;
	protected treeContainer: HTMLElement | undefined;
	protected readonly treeDisposables = this._register(new DisposableStore());
	protected readonly refreshScheduler = this._register(new MutableDisposable());

	private readonly _onDidChangeTreeData = this._register(new Emitter<void>());
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		protected readonly promptType: PromptsType,
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
		@IPromptsService protected readonly promptsService: IPromptsService,
		@IEditorService protected readonly editorService: IEditorService,
		@IMenuService protected readonly menuService: IMenuService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// Subscribe to prompt service events to refresh tree
		this._register(this.promptsService.onDidChangeCustomAgents(() => this.onPromptDataChanged()));
		this._register(this.promptsService.onDidChangeSlashCommands(() => this.onPromptDataChanged()));
	}

	private onPromptDataChanged(): void {
		// Refresh the tree when data changes
		this.refresh();
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.classList.add('ai-customization-view');
		this.treeContainer = dom.append(container, dom.$('.tree-container'));

		this.createTree();
	}

	private createTree(): void {
		if (!this.treeContainer) {
			return;
		}

		const dataSource = new AICustomizationDataSource(this.promptsService, this.promptType);

		this.tree = this.treeDisposables.add(this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<PromptsType, AICustomizationTreeItem, FuzzyScore>,
			`AICustomization-${this.promptType}`,
			this.treeContainer,
			new AICustomizationTreeDelegate(),
			[
				new AICustomizationGroupRenderer(),
				new AICustomizationFileRenderer(),
			],
			dataSource,
			{
				identityProvider: {
					getId: (element: AICustomizationTreeItem) => element.id,
				},
				accessibilityProvider: {
					getAriaLabel: (element: AICustomizationTreeItem) => {
						if (element.type === 'group') {
							return element.label;
						}
						return element.name;
					},
					getWidgetAriaLabel: () => this.getAriaLabel(),
				},
			}
		));

		// Handle double-click to open file
		this.treeDisposables.add(this.tree.onDidOpen(e => {
			if (e.element && e.element.type === 'file') {
				this.editorService.openEditor({ resource: e.element.uri });
			}
		}));

		// Handle context menu
		this.treeDisposables.add(this.tree.onContextMenu(e => this.onContextMenu(e)));

		// Initial load
		this.tree.setInput(this.promptType);
	}

	protected getAriaLabel(): string {
		return this.title;
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree?.layout(height, width);
	}

	public refresh(): void {
		this.tree?.setInput(this.promptType);
		this._onDidChangeTreeData.fire();
	}

	private onContextMenu(e: ITreeContextMenuEvent<AICustomizationTreeItem | null>): void {
		// Only show context menu for file items
		if (!e.element || e.element.type !== 'file') {
			return;
		}

		const element = e.element;
		const menuId = this.getContextMenuId();

		// Get menu actions from the menu service
		const context = {
			uri: element.uri.toString(),
			name: element.name,
			promptType: element.promptType,
		};
		const menu = this.menuService.getMenuActions(menuId, this.contextKeyService, { arg: context, shouldForwardArgs: true });
		const { secondary } = getContextMenuActions(menu, 'inline');

		// Show the context menu
		if (secondary.length > 0) {
			this.contextMenuService.showContextMenu({
				getAnchor: () => e.anchor,
				getActions: () => secondary,
				getActionsContext: () => element,
			});
		}
	}

	protected getContextMenuId(): MenuId {
		switch (this.promptType) {
			case PromptsType.agent:
				return AgentsViewItemMenuId;
			case PromptsType.skill:
				return SkillsViewItemMenuId;
			case PromptsType.instructions:
				return InstructionsViewItemMenuId;
			case PromptsType.prompt:
				return PromptsViewItemMenuId;
		}
	}
}

//#endregion

//#region Specific View Panes

/**
 * View pane for custom agents (.agent.md files).
 */
export class CustomAgentsViewPane extends AICustomizationTreeViewPane {
	static readonly ID = 'aiCustomization.agents';

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
		@IPromptsService promptsService: IPromptsService,
		@IEditorService editorService: IEditorService,
		@IMenuService menuService: IMenuService,
	) {
		super(PromptsType.agent, options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService, promptsService, editorService, menuService);
	}
}

/**
 * View pane for skills (SKILL.md files).
 */
export class SkillsViewPane extends AICustomizationTreeViewPane {
	static readonly ID = 'aiCustomization.skills';

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
		@IPromptsService promptsService: IPromptsService,
		@IEditorService editorService: IEditorService,
		@IMenuService menuService: IMenuService,
	) {
		super(PromptsType.skill, options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService, promptsService, editorService, menuService);
	}
}

/**
 * View pane for instruction files (.instructions.md).
 */
export class InstructionsViewPane extends AICustomizationTreeViewPane {
	static readonly ID = 'aiCustomization.instructions';

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
		@IPromptsService promptsService: IPromptsService,
		@IEditorService editorService: IEditorService,
		@IMenuService menuService: IMenuService,
	) {
		super(PromptsType.instructions, options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService, promptsService, editorService, menuService);
	}
}

/**
 * View pane for prompt files (.prompt.md).
 */
export class PromptsViewPane extends AICustomizationTreeViewPane {
	static readonly ID = 'aiCustomization.prompts';

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
		@IPromptsService promptsService: IPromptsService,
		@IEditorService editorService: IEditorService,
		@IMenuService menuService: IMenuService,
	) {
		super(PromptsType.prompt, options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService, promptsService, editorService, menuService);
	}
}

//#endregion
