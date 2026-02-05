/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationMemory.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IListVirtualDelegate, IListRenderer } from '../../../../../base/browser/ui/list/list.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IMemorySuggestion, MemorySuggestionMode, SuggestionTargetType } from '../../common/chatMemory/chatMemory.js';
import { IChatMemorySuggestionService } from '../../common/chatMemory/chatMemorySuggestionService.js';
import { IChatMemoryExtractionService } from '../../common/chatMemory/chatMemoryExtractionService.js';
import { ChatMemoryCommandIds, memoryIcon } from './aiCustomizationMemory.js';
import { agentIcon, instructionsIcon, promptIcon, skillIcon, hookIcon } from '../aiCustomizationTreeView/aiCustomizationTreeViewIcons.js';

const $ = DOM.$;

const ITEM_HEIGHT = 72;

/**
 * Item representing a memory suggestion in the list.
 */
interface IMemorySuggestionListItem {
	readonly suggestion: IMemorySuggestion;
}

/**
 * Delegate for the memory suggestion list.
 */
class MemorySuggestionListDelegate implements IListVirtualDelegate<IMemorySuggestionListItem> {
	getHeight(): number {
		return ITEM_HEIGHT;
	}

	getTemplateId(): string {
		return 'memorySuggestionItem';
	}
}

interface IMemorySuggestionItemTemplateData {
	readonly container: HTMLElement;
	readonly iconElement: HTMLElement;
	readonly contentElement: HTMLElement;
	readonly targetElement: HTMLElement;
	readonly actionsContainer: HTMLElement;
	readonly disposables: DisposableStore;
	readonly elementDisposables: DisposableStore;
}

/**
 * Renderer for memory suggestion list items.
 */
class MemorySuggestionItemRenderer implements IListRenderer<IMemorySuggestionListItem, IMemorySuggestionItemTemplateData> {
	readonly templateId = 'memorySuggestionItem';

	constructor(
		private readonly onApply: (item: IMemorySuggestionListItem) => void,
		private readonly onDismiss: (item: IMemorySuggestionListItem) => void,
		@IHoverService private readonly hoverService: IHoverService,
	) { }

	renderTemplate(container: HTMLElement): IMemorySuggestionItemTemplateData {
		const disposables = new DisposableStore();
		const elementDisposables = new DisposableStore();

		container.classList.add('memory-suggestion-item');

		const leftSection = DOM.append(container, $('.suggestion-left'));
		const iconElement = DOM.append(leftSection, $('.suggestion-icon'));

		const textSection = DOM.append(leftSection, $('.suggestion-text'));
		const contentElement = DOM.append(textSection, $('.suggestion-content'));
		const targetElement = DOM.append(textSection, $('.suggestion-target'));

		const actionsContainer = DOM.append(container, $('.suggestion-actions'));

		return {
			container,
			iconElement,
			contentElement,
			targetElement,
			actionsContainer,
			disposables,
			elementDisposables,
		};
	}

	renderElement(element: IMemorySuggestionListItem, _index: number, templateData: IMemorySuggestionItemTemplateData): void {
		templateData.elementDisposables.clear();

		const suggestion = element.suggestion;

		// Icon based on target type
		const icon = this.getIconForTargetType(suggestion.targetType);
		templateData.iconElement.className = 'suggestion-icon';
		templateData.iconElement.classList.add(...ThemeIcon.asClassNameArray(icon));

		// Content (the fact)
		templateData.contentElement.textContent = `"${suggestion.content}"`;
		templateData.elementDisposables.add(this.hoverService.setupManagedHover(
			getDefaultHoverDelegate('element'),
			templateData.contentElement,
			suggestion.reason
		));

		// Target description
		const targetText = this.getTargetDescription(suggestion);
		templateData.targetElement.textContent = targetText;

		// Actions container
		DOM.clearNode(templateData.actionsContainer);

		const applyButton = templateData.elementDisposables.add(new Button(templateData.actionsContainer, {
			...defaultButtonStyles,
			supportIcons: true,
			title: localize('apply', "Apply"),
		}));
		applyButton.element.classList.add('suggestion-action-button');
		applyButton.label = `$(${Codicon.check.id})`;
		templateData.elementDisposables.add(applyButton.onDidClick(() => this.onApply(element)));

		const dismissButton = templateData.elementDisposables.add(new Button(templateData.actionsContainer, {
			...defaultButtonStyles,
			supportIcons: true,
			secondary: true,
			title: localize('dismiss', "Dismiss"),
		}));
		dismissButton.element.classList.add('suggestion-action-button');
		dismissButton.label = `$(${Codicon.x.id})`;
		templateData.elementDisposables.add(dismissButton.onDidClick(() => this.onDismiss(element)));
	}

	private getIconForTargetType(targetType: SuggestionTargetType): ThemeIcon {
		switch (targetType) {
			case 'agent': return agentIcon;
			case 'skill': return skillIcon;
			case 'instructions': return instructionsIcon;
			case 'prompt': return promptIcon;
			case 'hook': return hookIcon;
			case 'newFile': return Codicon.newFile;
			default: return memoryIcon;
		}
	}

	private getTargetDescription(suggestion: IMemorySuggestion): string {
		if (suggestion.targetUri) {
			const filename = suggestion.targetUri.path.split('/').pop() || '';
			return localize('mergeInto', "→ Merge into {0}", filename);
		}
		if (suggestion.suggestedFileName) {
			return localize('createNew', "→ Create {0}", suggestion.suggestedFileName);
		}
		return localize('unknownTarget', "→ Unknown target");
	}

	disposeTemplate(templateData: IMemorySuggestionItemTemplateData): void {
		templateData.elementDisposables.dispose();
		templateData.disposables.dispose();
	}
}

/**
 * Widget that displays memory suggestions for merging into AI customizations.
 */
export class MemoryListWidget extends Disposable {

	readonly element: HTMLElement;

	private headerContainer!: HTMLElement;
	private modeLabel!: HTMLElement;
	private lastRunLabel!: HTMLElement;
	private reconcileButton!: Button;
	private listContainer!: HTMLElement;
	private list!: WorkbenchList<IMemorySuggestionListItem>;
	private emptyStateContainer!: HTMLElement;

	private items: IMemorySuggestionListItem[] = [];

	private readonly _onDidApply = this._register(new Emitter<IMemorySuggestion>());
	readonly onDidApply: Event<IMemorySuggestion> = this._onDidApply.event;

	private readonly _onDidDismiss = this._register(new Emitter<IMemorySuggestion>());
	readonly onDidDismiss: Event<IMemorySuggestion> = this._onDidDismiss.event;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatMemorySuggestionService private readonly suggestionService: IChatMemorySuggestionService,
		@IChatMemoryExtractionService private readonly extractionService: IChatMemoryExtractionService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.element = $('.memory-list-widget');
		this.create();
		this.loadSuggestions();

		// Listen for changes
		this._register(this.suggestionService.onDidChangeSuggestions(() => this.loadSuggestions()));
		this._register(this.extractionService.onDidChangeSuggestionMode(() => this.updateHeader()));
	}

	private create(): void {
		// Header section
		this.headerContainer = DOM.append(this.element, $('.memory-header'));

		const headerLeft = DOM.append(this.headerContainer, $('.memory-header-left'));
		const headerTitle = DOM.append(headerLeft, $('.memory-header-title'));
		headerTitle.textContent = localize('memorySuggestions', "Memory Suggestions");

		const headerInfo = DOM.append(headerLeft, $('.memory-header-info'));
		this.modeLabel = DOM.append(headerInfo, $('.memory-mode-label'));
		this.lastRunLabel = DOM.append(headerInfo, $('.memory-last-run'));

		const headerRight = DOM.append(this.headerContainer, $('.memory-header-right'));
		this.reconcileButton = this._register(new Button(headerRight, {
			...defaultButtonStyles,
			supportIcons: true,
		}));
		this.reconcileButton.label = `$(${Codicon.sync.id}) ${localize('reconcile', "Reconcile")}`;
		this._register(this.reconcileButton.onDidClick(() => {
			this.commandService.executeCommand(ChatMemoryCommandIds.Reconcile);
		}));

		this.updateHeader();

		// Description
		const descriptionContainer = DOM.append(this.element, $('.memory-description'));
		descriptionContainer.textContent = localize('memoryDescription',
			"Copilot learns from your conversations and suggests improvements to your AI customizations. Review and apply suggestions below.");

		// List container
		this.listContainer = DOM.append(this.element, $('.memory-list-container'));

		// Empty state
		this.emptyStateContainer = DOM.append(this.element, $('.memory-empty-state'));
		this.emptyStateContainer.style.display = 'none';

		// Create list
		const renderer = this.instantiationService.createInstance(
			MemorySuggestionItemRenderer,
			(item) => this.handleApply(item),
			(item) => this.handleDismiss(item)
		);

		this.list = this._register(this.instantiationService.createInstance(
			WorkbenchList<IMemorySuggestionListItem>,
			'MemorySuggestionsList',
			this.listContainer,
			new MemorySuggestionListDelegate(),
			[renderer],
			{
				identityProvider: {
					getId: (item: IMemorySuggestionListItem) => item.suggestion.id,
				},
				accessibilityProvider: {
					getAriaLabel: (item: IMemorySuggestionListItem) => {
						return localize('suggestionAriaLabel', "{0}, merge into {1}",
							item.suggestion.content,
							item.suggestion.targetType);
					},
					getWidgetAriaLabel: () => localize('memorySuggestionsAriaLabel', "Memory Suggestions"),
				},
				multipleSelectionSupport: false,
			}
		));
	}

	private updateHeader(): void {
		const mode = this.extractionService.suggestionMode;
		const modeLabels: Record<MemorySuggestionMode, string> = {
			[MemorySuggestionMode.Off]: localize('modeOff', "Off"),
			[MemorySuggestionMode.Eager]: localize('modeEager', "Eager"),
			[MemorySuggestionMode.Occasional]: localize('modeOccasional', "Occasional"),
			[MemorySuggestionMode.Manual]: localize('modeManual', "Manual"),
		};

		this.modeLabel.textContent = localize('mode', "Mode: {0}", modeLabels[mode]);

		// Update last run label
		this.lastRunLabel.textContent = localize('pendingSuggestions', "{0} pending", this.items.length);

		// Show/hide reconcile button based on mode
		this.reconcileButton.element.style.display =
			mode === MemorySuggestionMode.Off ? 'none' : '';
	}

	private async loadSuggestions(): Promise<void> {
		const suggestions = await this.suggestionService.listSuggestions('pending');
		this.items = suggestions.map(s => ({ suggestion: s }));
		this.list.splice(0, this.list.length, this.items);

		// Show empty state if no suggestions
		const isEmpty = this.items.length === 0;
		this.listContainer.style.display = isEmpty ? 'none' : '';
		this.emptyStateContainer.style.display = isEmpty ? '' : 'none';

		if (isEmpty) {
			this.updateEmptyState();
		}
	}

	private updateEmptyState(): void {
		DOM.clearNode(this.emptyStateContainer);

		const mode = this.extractionService.suggestionMode;

		const icon = DOM.append(this.emptyStateContainer, $('.empty-state-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(memoryIcon));

		const text = DOM.append(this.emptyStateContainer, $('.empty-state-text'));

		if (mode === MemorySuggestionMode.Off) {
			text.textContent = localize('memoryDisabled', "Memory is disabled");
			const subtext = DOM.append(this.emptyStateContainer, $('.empty-state-subtext'));
			subtext.textContent = localize('enableMemory', "Enable memory in settings to get suggestions from your chat history.");
		} else if (mode === MemorySuggestionMode.Manual) {
			text.textContent = localize('noSuggestionsManual', "No suggestions yet");
			const subtext = DOM.append(this.emptyStateContainer, $('.empty-state-subtext'));
			subtext.textContent = localize('runReconcile', "Run 'Reconcile' to analyze your chat history.");
		} else {
			text.textContent = localize('allCaughtUp', "All caught up!");
			const subtext = DOM.append(this.emptyStateContainer, $('.empty-state-subtext'));
			subtext.textContent = localize('noNewSuggestions', "Keep chatting with Copilot to get more suggestions.");
		}
	}

	private async handleApply(item: IMemorySuggestionListItem): Promise<void> {
		const result = await this.suggestionService.applySuggestion(item.suggestion.id);
		if (result.success) {
			this._onDidApply.fire(item.suggestion);
		}
	}

	private async handleDismiss(item: IMemorySuggestionListItem): Promise<void> {
		await this.suggestionService.dismissSuggestion(item.suggestion.id);
		this._onDidDismiss.fire(item.suggestion);
	}

	layout(height: number, width: number): void {
		const headerHeight = this.headerContainer.offsetHeight || 60;
		const descriptionHeight = 40; // Approximate
		const listHeight = height - headerHeight - descriptionHeight - 16; // padding

		this.listContainer.style.height = `${Math.max(listHeight, 100)}px`;
		this.list.layout(Math.max(listHeight, 100), width);
	}

	focus(): void {
		this.list.domFocus();
	}
}
