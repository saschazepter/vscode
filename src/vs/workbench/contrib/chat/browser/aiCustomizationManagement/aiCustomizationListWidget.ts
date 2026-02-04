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
import { defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { Delayer } from '../../../../../base/common/async.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { HighlightedLabel } from '../../../../../base/browser/ui/highlightedlabel/highlightedLabel.js';
import { matchesFuzzy, IMatch } from '../../../../../base/common/filters.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';

const $ = DOM.$;

const ITEM_HEIGHT = 32;

/**
 * Represents an AI customization item in the list.
 */
export interface IAICustomizationListItem {
	readonly id: string;
	readonly uri: URI;
	readonly name: string;
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
	readonly icon: HTMLElement;
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
		const icon = DOM.append(leftSection, $('.item-icon'));
		const textContainer = DOM.append(leftSection, $('.item-text'));
		const nameLabel = disposables.add(new HighlightedLabel(DOM.append(textContainer, $('.item-name'))));
		const description = disposables.add(new HighlightedLabel(DOM.append(textContainer, $('.item-description'))));

		const rightSection = DOM.append(container, $('.item-right'));
		const storageBadge = DOM.append(rightSection, $('.storage-badge'));

		return {
			container,
			icon,
			nameLabel,
			description,
			storageBadge,
			disposables,
			elementDisposables,
		};
	}

	renderElement(element: IAICustomizationListItem, index: number, templateData: IAICustomizationItemTemplateData): void {
		templateData.elementDisposables.clear();

		// Set icon based on prompt type
		let icon: ThemeIcon;
		switch (element.promptType) {
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

		templateData.icon.className = 'item-icon';
		templateData.icon.classList.add(...ThemeIcon.asClassNameArray(icon));

		// Name with highlights
		templateData.nameLabel.set(element.name, element.nameMatches);

		// Description with highlights
		if (element.description) {
			templateData.description.set(element.description, element.descriptionMatches);
			templateData.description.element.style.display = '';
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

		// Hover tooltip
		const tooltip = element.description
			? `${element.name}\n${element.description}\n\n${storageBadgeLabel}`
			: `${element.name}\n\n${storageBadgeLabel}`;

		templateData.elementDisposables.add(this.hoverService.setupDelayedHoverAtMouse(templateData.container, () => ({
			content: tooltip,
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
			return PromptsType.prompt;
	}
}

/**
 * Widget that displays a searchable list of AI customization items.
 */
export class AICustomizationListWidget extends Disposable {

	readonly element: HTMLElement;

	private searchContainer!: HTMLElement;
	private searchInput!: InputBox;
	private listContainer!: HTMLElement;
	private list!: WorkbenchList<IAICustomizationListItem>;
	private emptyMessage!: HTMLElement;
	private infoBox!: HTMLElement;
	private infoBoxText!: HTMLElement;
	private infoBoxLink!: HTMLAnchorElement;

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
	) {
		super();
		this.element = $('.ai-customization-list-widget');
		this.create();
	}

	private create(): void {
		// Search container
		this.searchContainer = DOM.append(this.element, $('.list-search-container'));
		this.searchInput = this._register(new InputBox(this.searchContainer, this.contextViewService, {
			placeholder: localize('searchPlaceholder', "Search customizations..."),
			inputBoxStyles: defaultInputBoxStyles,
		}));

		this._register(this.searchInput.onDidChange(() => {
			this.searchQuery = this.searchInput.value;
			this.delayedFilter.trigger(() => this.filterItems());
		}));

		// List container
		this.listContainer = DOM.append(this.element, $('.list-container'));

		// Empty message
		this.emptyMessage = DOM.append(this.element, $('.list-empty-message'));
		this.emptyMessage.textContent = localize('noItems', "No items found");
		this.emptyMessage.style.display = 'none';

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

		// Info box at the bottom
		this.infoBox = DOM.append(this.element, $('.list-info-box'));
		const infoIcon = DOM.append(this.infoBox, $('.info-icon'));
		infoIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.info));
		const infoContent = DOM.append(this.infoBox, $('.info-content'));
		this.infoBoxText = DOM.append(infoContent, $('.info-text'));
		this.infoBoxLink = DOM.append(infoContent, $('a.info-link')) as HTMLAnchorElement;
		this.infoBoxLink.textContent = localize('learnMore', "Learn more");
		this._register(DOM.addDisposableListener(this.infoBoxLink, 'click', (e) => {
			e.preventDefault();
			const href = this.infoBoxLink.href;
			if (href) {
				this.openerService.open(URI.parse(href));
			}
		}));
		this.updateInfoBoxText();
	}

	/**
	 * Sets the current section and loads items for that section.
	 */
	async setSection(section: AICustomizationManagementSection): Promise<void> {
		this.currentSection = section;
		this.updateInfoBoxText();
		await this.loadItems();
	}

	/**
	 * Updates the info box text based on the current section.
	 */
	private updateInfoBoxText(): void {
		let text: string;
		let docsUrl: string;
		switch (this.currentSection) {
			case AICustomizationManagementSection.Agents:
				text = localize('agentsInfo', "Agents are AI assistants with custom instructions, tools, and behaviors. Create an agent to automate complex tasks or provide specialized assistance.");
				docsUrl = 'https://code.visualstudio.com/docs/copilot/customization/custom-agents';
				break;
			case AICustomizationManagementSection.Skills:
				text = localize('skillsInfo', "Skills are reusable capabilities that can be added to agents. They define specific tasks an agent can perform, like searching documentation or running tests.");
				docsUrl = 'https://code.visualstudio.com/docs/copilot/customization/skills';
				break;
			case AICustomizationManagementSection.Instructions:
				text = localize('instructionsInfo', "Instructions are guidelines that apply to specific files or folders. Use them to teach the AI about coding conventions, project structure, or domain-specific rules.");
				docsUrl = 'https://code.visualstudio.com/docs/copilot/customization/instructions';
				break;
			case AICustomizationManagementSection.Prompts:
				text = localize('promptsInfo', "Prompts are reusable message templates you can quickly insert in chat. Create prompts for common questions, code reviews, or repetitive tasks.");
				docsUrl = 'https://code.visualstudio.com/docs/copilot/customization/prompts';
				break;
		}
		this.infoBoxText.textContent = text;
		this.infoBoxLink.href = docsUrl;
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

		// For skills, use findAgentSkills which has the proper names from frontmatter
		if (promptType === PromptsType.skill) {
			const skills = await this.promptsService.findAgentSkills(CancellationToken.None);
			for (const skill of skills || []) {
				const skillName = skill.name || basename(dirname(skill.uri)) || basename(skill.uri);
				items.push({
					id: skill.uri.toString(),
					uri: skill.uri,
					name: skillName,
					description: skill.description,
					storage: skill.storage,
					promptType,
				});
			}
		} else {
			// For other types, fetch all storage locations
			const [workspaceItems, userItems, extensionItems] = await Promise.all([
				this.promptsService.listPromptFilesForStorage(promptType, PromptsStorage.local, CancellationToken.None),
				this.promptsService.listPromptFilesForStorage(promptType, PromptsStorage.user, CancellationToken.None),
				this.promptsService.listPromptFilesForStorage(promptType, PromptsStorage.extension, CancellationToken.None),
			]);

			const mapToListItem = (item: IPromptPath): IAICustomizationListItem => ({
				id: item.uri.toString(),
				uri: item.uri,
				name: item.name || basename(item.uri),
				description: item.description,
				storage: item.storage,
				promptType,
			});

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

				if (nameMatches || descriptionMatches) {
					this.filteredItems.push({
						...item,
						nameMatches: nameMatches || undefined,
						descriptionMatches: descriptionMatches || undefined,
					});
				}
			}
		}

		this.list.splice(0, this.list.length, this.filteredItems);
		this.updateEmptyMessage();
	}

	private updateEmptyMessage(): void {
		if (this.filteredItems.length === 0) {
			this.emptyMessage.style.display = '';
			if (this.searchQuery.trim()) {
				this.emptyMessage.textContent = localize('noMatchingItems', "No items match '{0}'", this.searchQuery);
			} else {
				this.emptyMessage.textContent = localize('noItems', "No items found");
			}
		} else {
			this.emptyMessage.style.display = 'none';
		}
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
		const searchHeight = this.searchContainer.offsetHeight || 32;
		const infoBoxHeight = this.infoBox.offsetHeight || 80;
		const listHeight = height - searchHeight - infoBoxHeight - 24; // Extra padding

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
