/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationManagement.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { basename, dirname } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IListVirtualDelegate, IListRenderer } from '../../../../../base/browser/ui/list/list.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IPromptsService, PromptsStorage, IPromptPath } from '../../common/promptSyntax/service/promptsService.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { agentIcon, instructionsIcon, promptIcon, skillIcon, userIcon, workspaceIcon, extensionIcon } from '../aiCustomizationTreeView/aiCustomizationTreeViewIcons.js';
import { AICustomizationManagementSection } from './aiCustomizationManagement.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { Delayer } from '../../../../../base/common/async.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { HighlightedLabel } from '../../../../../base/browser/ui/highlightedlabel/highlightedLabel.js';
import { matchesFuzzy, IMatch } from '../../../../../base/common/filters.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';

const $ = DOM.$;

const ITEM_HEIGHT = 44;

/**
 * Represents an AI customization item in the list.
 */
export interface IAICustomizationListItem {
	readonly id: string;
	readonly uri: URI;
	readonly name: string;
	readonly filename: string;
	readonly description?: string;
	readonly storage: PromptsStorage;
	readonly promptType: PromptsType;
	nameMatches?: IMatch[];
	descriptionMatches?: IMatch[];
}

/**
 * Delegate for the AI Customization list.
 */
class AICustomizationListDelegate implements IListVirtualDelegate<IAICustomizationListItem> {
	getHeight(): number {
		return ITEM_HEIGHT;
	}

	getTemplateId(): string {
		return 'aiCustomizationItem';
	}
}

interface IAICustomizationItemTemplateData {
	readonly container: HTMLElement;
	readonly actionsContainer: HTMLElement;
	readonly nameLabel: HighlightedLabel;
	readonly description: HighlightedLabel;
	readonly storageBadge: HTMLElement;
	readonly disposables: DisposableStore;
	readonly elementDisposables: DisposableStore;
}

/**
 * Renderer for AI customization list items.
 */
class AICustomizationItemRenderer implements IListRenderer<IAICustomizationListItem, IAICustomizationItemTemplateData> {
	readonly templateId = 'aiCustomizationItem';

	constructor(
		@IHoverService private readonly hoverService: IHoverService,
	) { }

	renderTemplate(container: HTMLElement): IAICustomizationItemTemplateData {
		const disposables = new DisposableStore();
		const elementDisposables = new DisposableStore();

		container.classList.add('ai-customization-list-item');

		const leftSection = DOM.append(container, $('.item-left'));
		// Storage badge on left (shows workspace/user/extension)
		const storageBadge = DOM.append(leftSection, $('.storage-badge'));
		const textContainer = DOM.append(leftSection, $('.item-text'));
		const nameLabel = disposables.add(new HighlightedLabel(DOM.append(textContainer, $('.item-name'))));
		const description = disposables.add(new HighlightedLabel(DOM.append(textContainer, $('.item-description'))));

		// Right section for actions (hover-visible)
		const actionsContainer = DOM.append(container, $('.item-right'));

		return {
			container,
			actionsContainer,
			nameLabel,
			description,
			storageBadge,
			disposables,
			elementDisposables,
		};
	}

	renderElement(element: IAICustomizationListItem, index: number, templateData: IAICustomizationItemTemplateData): void {
		templateData.elementDisposables.clear();

		// Name with highlights
		templateData.nameLabel.set(element.name, element.nameMatches);

		// Description - show either description or filename as secondary text
		const secondaryText = element.description || element.filename;
		if (secondaryText) {
			templateData.description.set(secondaryText, element.description ? element.descriptionMatches : undefined);
			templateData.description.element.style.display = '';
			// Style differently for filename vs description
			templateData.description.element.classList.toggle('is-filename', !element.description);
		} else {
			templateData.description.set('', undefined);
			templateData.description.element.style.display = 'none';
		}

		// Storage badge
		let storageBadgeIcon: ThemeIcon;
		let storageBadgeLabel: string;
		switch (element.storage) {
			case PromptsStorage.local:
				storageBadgeIcon = workspaceIcon;
				storageBadgeLabel = localize('workspace', "Workspace");
				break;
			case PromptsStorage.user:
				storageBadgeIcon = userIcon;
				storageBadgeLabel = localize('user', "User");
				break;
			case PromptsStorage.extension:
				storageBadgeIcon = extensionIcon;
				storageBadgeLabel = localize('extension', "Extension");
				break;
		}

		templateData.storageBadge.className = 'storage-badge';
		templateData.storageBadge.classList.add(...ThemeIcon.asClassNameArray(storageBadgeIcon));
		templateData.storageBadge.title = storageBadgeLabel;

		// Build rich tooltip content
		const tooltipLines: string[] = [element.name];
		if (element.description) {
			tooltipLines.push(element.description);
		}
		tooltipLines.push('');
		tooltipLines.push(`${storageBadgeLabel} \u2022 ${element.filename}`);

		templateData.elementDisposables.add(this.hoverService.setupDelayedHoverAtMouse(templateData.container, () => ({
			content: tooltipLines.join('\n'),
			appearance: {
				compact: true,
				skipFadeInAnimation: true,
			}
		})));
	}

	disposeTemplate(templateData: IAICustomizationItemTemplateData): void {
		templateData.elementDisposables.dispose();
		templateData.disposables.dispose();
	}
}

/**
 * Maps section ID to prompt type.
 */
function sectionToPromptType(section: AICustomizationManagementSection): PromptsType {
	switch (section) {
		case AICustomizationManagementSection.Agents:
			return PromptsType.agent;
		case AICustomizationManagementSection.Skills:
			return PromptsType.skill;
		case AICustomizationManagementSection.Instructions:
			return PromptsType.instructions;
		case AICustomizationManagementSection.Prompts:
		default:
			return PromptsType.prompt;
	}
}

/**
 * Widget that displays a searchable list of AI customization items.
 */
export class AICustomizationListWidget extends Disposable {

	readonly element: HTMLElement;

	private sectionHeader!: HTMLElement;
	private sectionDescription!: HTMLElement;
	private sectionLink!: HTMLAnchorElement;
	private searchAndButtonContainer!: HTMLElement;
	private searchContainer!: HTMLElement;
	private searchInput!: InputBox;
	private addButton!: Button;
	private listContainer!: HTMLElement;
	private list!: WorkbenchList<IAICustomizationListItem>;
	private emptyStateContainer!: HTMLElement;
	private emptyStateIcon!: HTMLElement;
	private emptyStateText!: HTMLElement;
	private emptyStateSubtext!: HTMLElement;
	private emptyStateButton!: Button;

	private currentSection: AICustomizationManagementSection = AICustomizationManagementSection.Agents;
	private allItems: IAICustomizationListItem[] = [];
	private filteredItems: IAICustomizationListItem[] = [];
	private searchQuery: string = '';

	private readonly delayedFilter = new Delayer<void>(200);

	private readonly _onDidSelectItem = this._register(new Emitter<IAICustomizationListItem>());
	readonly onDidSelectItem: Event<IAICustomizationListItem> = this._onDidSelectItem.event;

	private readonly _onDidChangeItemCount = this._register(new Emitter<number>());
	readonly onDidChangeItemCount: Event<number> = this._onDidChangeItemCount.event;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IPromptsService private readonly promptsService: IPromptsService,
		@IHoverService hoverService: IHoverService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.element = $('.ai-customization-list-widget');
		this.create();
	}

	private create(): void {
		// Section header at top with description and link
		this.sectionHeader = DOM.append(this.element, $('.section-header'));
		this.sectionDescription = DOM.append(this.sectionHeader, $('p.section-header-description'));
		this.sectionLink = DOM.append(this.sectionHeader, $('a.section-header-link')) as HTMLAnchorElement;
		this._register(DOM.addDisposableListener(this.sectionLink, 'click', (e) => {
			e.preventDefault();
			const href = this.sectionLink.href;
			if (href) {
				this.openerService.open(URI.parse(href));
			}
		}));
		this.updateSectionHeader();

		// Search and button container
		this.searchAndButtonContainer = DOM.append(this.element, $('.list-search-and-button-container'));

		// Search container
		this.searchContainer = DOM.append(this.searchAndButtonContainer, $('.list-search-container'));
		this.searchInput = this._register(new InputBox(this.searchContainer, this.contextViewService, {
			placeholder: localize('searchPlaceholder', "Type to search..."),
			inputBoxStyles: defaultInputBoxStyles,
		}));

		this._register(this.searchInput.onDidChange(() => {
			this.searchQuery = this.searchInput.value;
			this.delayedFilter.trigger(() => this.filterItems());
		}));

		// Add button next to search
		const addButtonContainer = DOM.append(this.searchAndButtonContainer, $('.list-add-button-container'));
		this.addButton = this._register(new Button(addButtonContainer, { ...defaultButtonStyles, supportIcons: true }));
		this.addButton.element.classList.add('list-add-button');
		this._register(this.addButton.onDidClick(() => this.executeCreateAction()));
		this.updateAddButton();

		// List container
		this.listContainer = DOM.append(this.element, $('.list-container'));

		// Empty state container
		this.emptyStateContainer = DOM.append(this.element, $('.list-empty-state'));
		this.emptyStateIcon = DOM.append(this.emptyStateContainer, $('.empty-state-icon'));
		this.emptyStateText = DOM.append(this.emptyStateContainer, $('.empty-state-text'));
		this.emptyStateSubtext = DOM.append(this.emptyStateContainer, $('.empty-state-subtext'));
		this.emptyStateButton = this._register(new Button(this.emptyStateContainer, { ...defaultButtonStyles, supportIcons: true }));
		this.emptyStateButton.element.classList.add('empty-state-button');
		this._register(this.emptyStateButton.onDidClick(() => this.executeCreateAction()));
		this.emptyStateContainer.style.display = 'none';

		// Create list
		this.list = this._register(this.instantiationService.createInstance(
			WorkbenchList<IAICustomizationListItem>,
			'AICustomizationManagementList',
			this.listContainer,
			new AICustomizationListDelegate(),
			[this.instantiationService.createInstance(AICustomizationItemRenderer)],
			{
				identityProvider: {
					getId: (item: IAICustomizationListItem) => item.id,
				},
				accessibilityProvider: {
					getAriaLabel: (item: IAICustomizationListItem) => {
						return item.description
							? localize('itemAriaLabel', "{0}, {1}", item.name, item.description)
							: item.name;
					},
					getWidgetAriaLabel: () => localize('listAriaLabel', "AI Customizations"),
				},
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: (item: IAICustomizationListItem) => item.name,
				},
				multipleSelectionSupport: false,
				openOnSingleClick: true,
			}
		));

		// Handle item selection (single click opens item)
		this._register(this.list.onDidOpen(e => {
			if (e.element) {
				this._onDidSelectItem.fire(e.element);
			}
		}));

		// Subscribe to prompt service changes
		this._register(this.promptsService.onDidChangeCustomAgents(() => this.refresh()));
		this._register(this.promptsService.onDidChangeSlashCommands(() => this.refresh()));
	}

	/**
	 * Sets the current section and loads items for that section.
	 */
	async setSection(section: AICustomizationManagementSection): Promise<void> {
		this.currentSection = section;
		this.updateSectionHeader();
		this.updateAddButton();
		await this.loadItems();
	}

	/**
	 * Updates the section header based on the current section.
	 */
	private updateSectionHeader(): void {
		let description: string;
		let docsUrl: string;
		let learnMoreLabel: string;
		switch (this.currentSection) {
			case AICustomizationManagementSection.Agents:
				description = localize('agentsDescription', "Configure the AI to adopt different personas tailored to specific development tasks. Each agent has its own instructions, tools, and behavior.");
				docsUrl = 'https://code.visualstudio.com/docs/copilot/customization/custom-agents';
				learnMoreLabel = localize('learnMoreAgents', "Learn more about custom agents");
				break;
			case AICustomizationManagementSection.Skills:
				description = localize('skillsDescription', "Folders of instructions, scripts, and resources that Copilot loads when relevant to perform specialized tasks.");
				docsUrl = 'https://code.visualstudio.com/docs/copilot/customization/agent-skills';
				learnMoreLabel = localize('learnMoreSkills', "Learn more about agent skills");
				break;
			case AICustomizationManagementSection.Instructions:
				description = localize('instructionsDescription', "Define common guidelines and rules that automatically influence how AI generates code and handles development tasks.");
				docsUrl = 'https://code.visualstudio.com/docs/copilot/customization/custom-instructions';
				learnMoreLabel = localize('learnMoreInstructions', "Learn more about custom instructions");
				break;
			case AICustomizationManagementSection.Prompts:
			default:
				description = localize('promptsDescription', "Reusable prompts for common development tasks like generating code, performing reviews, or scaffolding components.");
				docsUrl = 'https://code.visualstudio.com/docs/copilot/customization/prompt-files';
				learnMoreLabel = localize('learnMorePrompts', "Learn more about prompt files");
				break;
		}
		this.sectionDescription.textContent = description;
		this.sectionLink.textContent = learnMoreLabel;
		this.sectionLink.href = docsUrl;
	}

	/**
	 * Updates the add button label based on the current section.
	 */
	private updateAddButton(): void {
		let buttonLabel: string;
		switch (this.currentSection) {
			case AICustomizationManagementSection.Agents:
				buttonLabel = localize('newAgent', "New Agent");
				break;
			case AICustomizationManagementSection.Skills:
				buttonLabel = localize('newSkill', "New Skill");
				break;
			case AICustomizationManagementSection.Instructions:
				buttonLabel = localize('newInstructions', "New Instructions");
				break;
			case AICustomizationManagementSection.Prompts:
			default:
				buttonLabel = localize('newPrompt', "New Prompt");
				break;
		}
		this.addButton.label = `$(${Codicon.add.id}) ${buttonLabel}`;
	}

	/**
	 * Refreshes the current section's items.
	 */
	async refresh(): Promise<void> {
		await this.loadItems();
	}

	/**
	 * Loads items for the current section.
	 */
	private async loadItems(): Promise<void> {
		const promptType = sectionToPromptType(this.currentSection);
		const items: IAICustomizationListItem[] = [];

		if (promptType === PromptsType.agent) {
			// Use getCustomAgents which has parsed name/description from frontmatter
			const agents = await this.promptsService.getCustomAgents(CancellationToken.None);
			for (const agent of agents) {
				const filename = basename(agent.uri);
				items.push({
					id: agent.uri.toString(),
					uri: agent.uri,
					name: agent.name,
					filename,
					description: agent.description,
					storage: agent.source.storage,
					promptType,
				});
			}
		} else if (promptType === PromptsType.skill) {
			// Use findAgentSkills which has parsed name/description from frontmatter
			const skills = await this.promptsService.findAgentSkills(CancellationToken.None);
			for (const skill of skills || []) {
				const filename = basename(skill.uri);
				const skillName = skill.name || basename(dirname(skill.uri)) || filename;
				items.push({
					id: skill.uri.toString(),
					uri: skill.uri,
					name: skillName,
					filename,
					description: skill.description,
					storage: skill.storage,
					promptType,
				});
			}
		} else if (promptType === PromptsType.prompt) {
			// Use getPromptSlashCommands which has parsed name/description from frontmatter
			const commands = await this.promptsService.getPromptSlashCommands(CancellationToken.None);
			for (const command of commands) {
				const filename = basename(command.promptPath.uri);
				items.push({
					id: command.promptPath.uri.toString(),
					uri: command.promptPath.uri,
					name: command.name,
					filename,
					description: command.description,
					storage: command.promptPath.storage,
					promptType,
				});
			}
		} else {
			// For instructions, fetch all storage locations
			const [workspaceItems, userItems, extensionItems] = await Promise.all([
				this.promptsService.listPromptFilesForStorage(promptType, PromptsStorage.local, CancellationToken.None),
				this.promptsService.listPromptFilesForStorage(promptType, PromptsStorage.user, CancellationToken.None),
				this.promptsService.listPromptFilesForStorage(promptType, PromptsStorage.extension, CancellationToken.None),
			]);

			const mapToListItem = (item: IPromptPath): IAICustomizationListItem => {
				const filename = basename(item.uri);
				// For instructions, derive a friendly name from filename
				const friendlyName = item.name || this.getFriendlyName(filename);
				return {
					id: item.uri.toString(),
					uri: item.uri,
					name: friendlyName,
					filename,
					description: item.description,
					storage: item.storage,
					promptType,
				};
			};

			items.push(...workspaceItems.map(mapToListItem));
			items.push(...userItems.map(mapToListItem));
			items.push(...extensionItems.map(mapToListItem));
		}

		// Sort items by name
		items.sort((a, b) => a.name.localeCompare(b.name));

		this.allItems = items;
		this.filterItems();
		this._onDidChangeItemCount.fire(items.length);
	}

	/**
	 * Derives a friendly name from a filename by removing extension suffixes.
	 */
	private getFriendlyName(filename: string): string {
		// Remove common prompt file extensions like .instructions.md, .prompt.md, etc.
		let name = filename
			.replace(/\.instructions\.md$/i, '')
			.replace(/\.prompt\.md$/i, '')
			.replace(/\.agent\.md$/i, '')
			.replace(/\.md$/i, '');

		// Convert kebab-case or snake_case to Title Case
		name = name
			.replace(/[-_]/g, ' ')
			.replace(/\b\w/g, c => c.toUpperCase());

		return name || filename;
	}

	/**
	 * Filters items based on the current search query.
	 */
	private filterItems(): void {
		if (!this.searchQuery.trim()) {
			this.filteredItems = this.allItems.map(item => ({ ...item, nameMatches: undefined, descriptionMatches: undefined }));
		} else {
			const query = this.searchQuery.toLowerCase();
			this.filteredItems = [];

			for (const item of this.allItems) {
				const nameMatches = matchesFuzzy(query, item.name, true);
				const descriptionMatches = item.description ? matchesFuzzy(query, item.description, true) : null;
				const filenameMatches = matchesFuzzy(query, item.filename, true);

				if (nameMatches || descriptionMatches || filenameMatches) {
					this.filteredItems.push({
						...item,
						nameMatches: nameMatches || undefined,
						descriptionMatches: descriptionMatches || undefined,
					});
				}
			}
		}

		this.list.splice(0, this.list.length, this.filteredItems);
		this.updateEmptyState();
	}

	private updateEmptyState(): void {
		if (this.filteredItems.length === 0) {
			this.emptyStateContainer.style.display = 'flex';
			this.listContainer.style.display = 'none';

			// Update icon based on section
			this.emptyStateIcon.className = 'empty-state-icon';
			const sectionIcon = this.getSectionIcon();
			this.emptyStateIcon.classList.add(...ThemeIcon.asClassNameArray(sectionIcon));

			if (this.searchQuery.trim()) {
				// Search with no results
				this.emptyStateText.textContent = localize('noMatchingItems', "No items match '{0}'", this.searchQuery);
				this.emptyStateSubtext.textContent = localize('tryDifferentSearch', "Try a different search term");
				this.emptyStateButton.element.style.display = 'none';
			} else {
				// No items at all - show create action
				const emptyInfo = this.getEmptyStateInfo();
				this.emptyStateText.textContent = emptyInfo.title;
				this.emptyStateSubtext.textContent = emptyInfo.description;
				this.emptyStateButton.label = emptyInfo.buttonLabel;
				this.emptyStateButton.element.style.display = '';
			}
		} else {
			this.emptyStateContainer.style.display = 'none';
			this.listContainer.style.display = '';
		}
	}

	private getSectionIcon(): ThemeIcon {
		switch (this.currentSection) {
			case AICustomizationManagementSection.Agents:
				return agentIcon;
			case AICustomizationManagementSection.Skills:
				return skillIcon;
			case AICustomizationManagementSection.Instructions:
				return instructionsIcon;
			case AICustomizationManagementSection.Prompts:
			default:
				return promptIcon;
		}
	}

	private getEmptyStateInfo(): { title: string; description: string; buttonLabel: string; command: string } {
		switch (this.currentSection) {
			case AICustomizationManagementSection.Agents:
				return {
					title: localize('noAgents', "No agents yet"),
					description: localize('createFirstAgent', "Create your first custom agent to get started"),
					buttonLabel: localize('createAgent', "Create Agent"),
					command: 'workbench.action.aiCustomization.newAgent'
				};
			case AICustomizationManagementSection.Skills:
				return {
					title: localize('noSkills', "No skills yet"),
					description: localize('createFirstSkill', "Create your first skill to extend agent capabilities"),
					buttonLabel: localize('createSkill', "Create Skill"),
					command: 'workbench.action.aiCustomization.newSkill'
				};
			case AICustomizationManagementSection.Instructions:
				return {
					title: localize('noInstructions', "No instructions yet"),
					description: localize('createFirstInstructions', "Add instructions to teach Copilot about your codebase"),
					buttonLabel: localize('createInstructions', "Create Instructions"),
					command: 'workbench.action.aiCustomization.newInstructions'
				};
			case AICustomizationManagementSection.Prompts:
			default:
				return {
					title: localize('noPrompts', "No prompts yet"),
					description: localize('createFirstPrompt', "Create reusable prompts for common tasks"),
					buttonLabel: localize('createPrompt', "Create Prompt"),
					command: 'workbench.action.aiCustomization.newPrompt'
				};
		}
	}

	private executeCreateAction(): void {
		const emptyInfo = this.getEmptyStateInfo();
		this.commandService.executeCommand(emptyInfo.command);
	}

	/**
	 * Sets the search query programmatically.
	 */
	setSearchQuery(query: string): void {
		this.searchInput.value = query;
	}

	/**
	 * Clears the search query.
	 */
	clearSearch(): void {
		this.searchInput.value = '';
	}

	/**
	 * Focuses the search input.
	 */
	focusSearch(): void {
		this.searchInput.focus();
	}

	/**
	 * Focuses the list.
	 */
	focusList(): void {
		this.list.domFocus();
		if (this.filteredItems.length > 0) {
			this.list.setFocus([0]);
		}
	}

	/**
	 * Layouts the widget.
	 */
	layout(height: number, width: number): void {
		const sectionHeaderHeight = this.sectionHeader.offsetHeight || 100;
		const searchBarHeight = this.searchAndButtonContainer.offsetHeight || 40;
		const listHeight = height - sectionHeaderHeight - searchBarHeight - 24; // Extra padding

		this.searchInput.layout();
		this.listContainer.style.height = `${listHeight}px`;
		this.list.layout(listHeight, width);
	}

	/**
	 * Gets the total item count (before filtering).
	 */
	get itemCount(): number {
		return this.allItems.length;
	}
}
