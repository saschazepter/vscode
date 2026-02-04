/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatFullWelcomePart.css';
import { $, append, clearNode, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IAgentSessionsService } from '../agentSessions/agentSessionsService.js';
import { AgentSessionsControl } from '../agentSessions/agentSessionsControl.js';
import { IChatFullWelcomeOptions } from '../chat.js';
import { ChatQuickStartPart, IQuickStartDelegate, IQuickStartOption, QuickStartType } from './chatQuickStartPart.js';
import { AgentSessionProviders } from '../agentSessions/agentSessions.js';
import { ChatAgentLocation, ChatModeKind } from '../../common/constants.js';
import { IChatSessionProviderOptionGroup, IChatSessionProviderOptionItem, IChatSessionsService } from '../../common/chatSessionsService.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../common/languageModels.js';
import { IModelPickerDelegate, ModelPickerActionItem } from '../widget/input/modelPickerActionItem.js';
import { ChatSessionPickerActionItem, IChatSessionPickerDelegate } from '../chatSessions/chatSessionPickerActionItem.js';
import { SearchableOptionPickerActionItem } from '../chatSessions/searchableOptionPickerActionItem.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { IAction } from '../../../../../base/common/actions.js';
import { IChatInputPickerOptions } from '../widget/input/chatInputPickerActionItem.js';

// Re-export for convenience
export { QuickStartType } from './chatQuickStartPart.js';

const MAX_SESSIONS = 6;

/**
 * Event fired when a quick-start option is selected.
 */
export interface IQuickStartSelectionEvent {
	readonly option: IQuickStartOption;
	readonly sessionProvider: AgentSessionProviders;
	readonly modeKind: ChatModeKind;
	readonly lockMode: boolean;
}

export interface IChatFullWelcomePartOptions {
	/**
	 * The product name to display in the header.
	 */
	readonly productName: string;

	/**
	 * Configuration options from the widget.
	 */
	readonly fullWelcomeOptions?: IChatFullWelcomeOptions;

	/**
	 * Initial quick-start selection type.
	 */
	readonly initialQuickStartType?: QuickStartType;

	/**
	 * Callback to set the input prefix decoration content (e.g., '> ').
	 * Called by the welcome part to control the input prefix display.
	 */
	readonly setInputPrefixContent?: (content: string | undefined) => void;
}

/**
 * A self-contained full welcome part that renders provider buttons with
 * an expandable configuration area that slides open when a provider is selected.
 */
export class ChatFullWelcomePart extends Disposable {

	public readonly element: HTMLElement;

	/**
	 * Container where the chat input should be inserted by ChatWidget.
	 */
	public readonly inputSlot: HTMLElement;

	private readonly _onDidSelectQuickStart = this._register(new Emitter<IQuickStartSelectionEvent>());
	public readonly onDidSelectQuickStart: Event<IQuickStartSelectionEvent> = this._onDidSelectQuickStart.event;

	private quickStartPart: ChatQuickStartPart | undefined;
	private sessionsControl: AgentSessionsControl | undefined;
	private sessionsControlContainer: HTMLElement | undefined;
	private readonly sessionsControlDisposables = this._register(new DisposableStore());
	private readonly contentDisposables = this._register(new DisposableStore());

	private _selectedQuickStartType: QuickStartType | undefined;
	private _selectedOption: IQuickStartOption | undefined;

	// UI elements
	private configToolbar: HTMLElement | undefined;
	private collapsedModeButton: HTMLElement | undefined;
	private toolbarSeparator: HTMLElement | undefined;
	private pickersContainer: HTMLElement | undefined;
	private descriptionElement: HTMLElement | undefined;

	// Picker widgets
	private readonly pickerWidgetsDisposables = this._register(new DisposableStore());
	private modelPickerWidget: ModelPickerActionItem | undefined;
	private readonly _currentLanguageModel = observableValue<ILanguageModelChatMetadataAndIdentifier | undefined>('currentLanguageModel', undefined);
	private readonly _optionEmitters = new Map<string, Emitter<IChatSessionProviderOptionItem>>();
	private readonly _selectedOptions = new Map<string, IChatSessionProviderOptionItem>();
	private sessionOptionPickers = new Map<string, ChatSessionPickerActionItem | SearchableOptionPickerActionItem>();
	// For welcome view, always show full labels (not compact mode)
	private readonly _onlyShowIconsForDefaultActions = observableValue('onlyShowIconsForDefaultActions', false);

	// Input connection for type-to-search
	private readonly _inputConnectionDisposables = this._register(new MutableDisposable<IDisposable>());
	private _isFiltering = false;

	constructor(
		private readonly options: IChatFullWelcomePartOptions,
		@IProductService private readonly productService: IProductService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
	) {
		super();

		this.element = $('.chat-full-welcome');
		this.inputSlot = $('.chat-full-welcome-inputSlot');
		// Don't auto-select a type - let users choose
		this._selectedQuickStartType = options.initialQuickStartType;

		this.buildContent();

		// Set the input prefix decoration for the welcome view
		this.options.setInputPrefixContent?.('> ');
	}

	/**
	 * Gets the currently selected quick-start type.
	 */
	public getSelectedQuickStartType(): QuickStartType | undefined {
		return this._selectedQuickStartType;
	}

	/**
	 * Gets the currently selected option with its configuration.
	 */
	public getSelectedOption(): IQuickStartOption | undefined {
		return this._selectedOption;
	}

	private buildContent(): void {
		this.contentDisposables.clear();
		this.sessionsControlDisposables.clear();
		this.sessionsControl = undefined;
		this.quickStartPart = undefined;
		clearNode(this.element);

		// Header with product name
		const header = append(this.element, $('.chat-full-welcome-header'));
		append(header, $('h1.product-name', {}, this.options.productName || this.productService.nameShort));

		// Quick-start buttons
		const quickStartDelegate: IQuickStartDelegate = {
			onQuickStartSelected: (option: IQuickStartOption) => {
				this._selectedQuickStartType = option.type;
				this._selectedOption = option;
				// Collapse the quick-start buttons and show config toolbar
				this.expandConfig(option);

				// Fire the selection event
				this._onDidSelectQuickStart.fire({
					option,
					sessionProvider: option.sessionProvider,
					modeKind: option.modeKind,
					lockMode: option.lockMode,
				});
			},
			getSelectedQuickStart: () => this._selectedQuickStartType,
		};
		this.quickStartPart = this.contentDisposables.add(new ChatQuickStartPart(quickStartDelegate, this.chatSessionsService));
		append(this.element, this.quickStartPart.element);

		// Configuration toolbar (shows collapsed mode icon + separator + pickers)
		// Initially hidden until a mode is selected and collapsed
		this.configToolbar = append(this.element, $('.chat-full-welcome-config-toolbar'));
		this.configToolbar.style.display = 'none';

		// Collapsed mode button (icon only) - will be populated when a mode is selected
		this.collapsedModeButton = append(this.configToolbar, $('button.chat-full-welcome-collapsed-mode-button'));
		this.collapsedModeButton.setAttribute('type', 'button');

		// Separator between mode icon and pickers
		this.toolbarSeparator = append(this.configToolbar, $('.chat-full-welcome-toolbar-separator'));

		// Pickers container inside toolbar (after the separator)
		this.pickersContainer = append(this.configToolbar, $('.chat-full-welcome-pickers'));

		// Input slot - ChatWidget will insert the input part here
		append(this.element, this.inputSlot);

		// Description below the input (always visible)
		this.descriptionElement = append(this.element, $('.chat-full-welcome-description'));

		// Don't auto-select - let users choose their mode first
		this._selectedQuickStartType = undefined;
		this._selectedOption = undefined;
	}

	private expandConfig(option: IQuickStartOption): void {
		if (!this.configToolbar || !this.pickersContainer || !this.descriptionElement || !this.quickStartPart || !this.collapsedModeButton || !this.toolbarSeparator) {
			return;
		}

		// Dispose any existing picker widgets
		this.disposePickerWidgets();

		// Get the clicked button's position BEFORE any layout changes
		const clickedButton = this.quickStartPart.getButtonElement(option.type);
		let startWidth = 80; // Default fallback
		let buttonRect: DOMRect | undefined;

		if (clickedButton) {
			buttonRect = clickedButton.getBoundingClientRect();
			startWidth = buttonRect.width;
		}

		// Disable animation BEFORE any display changes to prevent it from auto-starting
		this.collapsedModeButton.style.animation = 'none';
		this.pickersContainer.style.animation = 'none';
		this.toolbarSeparator.style.animation = 'none';

		// Hide the expanded quick-start buttons FIRST
		this.quickStartPart.element.style.display = 'none';

		// Now show toolbar temporarily (invisible) to measure where the collapsed button will be
		// This gives accurate position since buttons are hidden
		this.configToolbar.style.display = 'flex';
		this.configToolbar.style.opacity = '0';
		this.configToolbar.style.pointerEvents = 'none';

		// Force a reflow to get accurate measurements
		void this.configToolbar.offsetHeight;

		let offsetX = 0;
		let offsetY = 0;

		if (buttonRect) {
			const targetRect = this.collapsedModeButton.getBoundingClientRect();

			// Calculate offset from target position back to original button position
			offsetX = buttonRect.left - targetRect.left;
			offsetY = buttonRect.top - targetRect.top;
		}

		// Set animation properties BEFORE re-enabling animation
		this.collapsedModeButton.style.setProperty('--collapse-from-width', `${startWidth}px`);
		this.collapsedModeButton.style.setProperty('--slide-from-x', `${offsetX}px`);
		this.collapsedModeButton.style.setProperty('--slide-from-y', `${offsetY}px`);

		// Update the collapsed mode button with the selected option's icon
		clearNode(this.collapsedModeButton);
		const iconElement = append(this.collapsedModeButton, $('.chat-full-welcome-collapsed-mode-icon'));
		iconElement.appendChild(renderIcon(option.icon));
		this.collapsedModeButton.setAttribute('aria-label', localize('quickStart.changeMode', "Change mode: {0}", option.label));
		this.collapsedModeButton.title = option.label;
		this.collapsedModeButton.onclick = () => this.showExpandedMode();

		// Update pickers BEFORE making toolbar visible
		clearNode(this.pickersContainer);

		const { showModelPicker } = option.pickerConfig;
		// Get dynamic option groups for this session type
		const sessionType = option.sessionProvider;
		const optionGroups = this.chatSessionsService.getOptionGroupsForSessionType(sessionType) ?? [];

		const hasPickers = showModelPicker || optionGroups.length > 0;

		if (hasPickers) {
			// Create model picker if configured
			if (showModelPicker) {
				this.createModelPicker(this.pickersContainer);
			}

			// Create session option pickers based on option groups
			for (const optionGroup of optionGroups) {
				this.createSessionOptionPicker(this.pickersContainer, optionGroup, sessionType);
			}
		}

		// Update description (below the input)
		clearNode(this.descriptionElement);
		append(this.descriptionElement, $('span.chat-full-welcome-description-text', {}, option.description));

		// Show/hide separator based on whether there are pickers
		this.toolbarSeparator.style.display = hasPickers ? 'block' : 'none';

		// Make toolbar visible (it was already display:flex but opacity:0)
		this.configToolbar.style.opacity = '';
		this.configToolbar.style.pointerEvents = '';

		// Re-enable animations after a frame to restart them with correct values
		getWindow(this.element).requestAnimationFrame(() => {
			if (this.collapsedModeButton) {
				this.collapsedModeButton.style.animation = '';
			}
			if (this.pickersContainer) {
				this.pickersContainer.style.animation = '';
			}
			if (this.toolbarSeparator) {
				this.toolbarSeparator.style.animation = '';
			}
		});
	}

	/**
	 * Creates a model picker widget.
	 */
	private createModelPicker(container: HTMLElement): void {
		const pickerRow = append(container, $('.chat-full-welcome-picker-row'));
		append(pickerRow, $('label.chat-full-welcome-picker-label', {}, localize('model', "Model")));
		const pickerSlot = append(pickerRow, $('.chat-full-welcome-picker-slot.model-picker-slot'));

		// Initialize current model if not set
		if (!this._currentLanguageModel.get()) {
			const models = this.getModels();
			const defaultModel = models.find(m => m.metadata.isDefaultForLocation?.[ChatAgentLocation.Chat]) || models[0];
			if (defaultModel) {
				this._currentLanguageModel.set(defaultModel, undefined);
			}
		}

		// Create model picker delegate
		const modelDelegate: IModelPickerDelegate = {
			currentModel: this._currentLanguageModel,
			setModel: (model: ILanguageModelChatMetadataAndIdentifier) => {
				this._currentLanguageModel.set(model, undefined);
			},
			getModels: () => this.getModels()
		};

		// Create a dummy action for the picker
		const action: IAction = {
			id: 'chatFullWelcome.modelPicker',
			label: localize('selectModel', "Select Model"),
			tooltip: localize('selectModel', "Select Model"),
			class: undefined,
			enabled: true,
			run: () => Promise.resolve()
		};

		const pickerOptions: IChatInputPickerOptions = {
			onlyShowIconsForDefaultActions: this._onlyShowIconsForDefaultActions,
			hoverPosition: {
				forcePosition: true,
				hoverPosition: HoverPosition.ABOVE
			}
		};

		this.modelPickerWidget = this.pickerWidgetsDisposables.add(
			this.instantiationService.createInstance(ModelPickerActionItem, action, undefined, modelDelegate, pickerOptions)
		);
		this.modelPickerWidget.render(pickerSlot);
	}

	/**
	 * Creates a session option picker widget for an option group.
	 */
	private createSessionOptionPicker(container: HTMLElement, optionGroup: IChatSessionProviderOptionGroup, sessionType: string): void {
		const pickerRow = append(container, $('.chat-full-welcome-picker-row'));
		append(pickerRow, $('label.chat-full-welcome-picker-label', {}, optionGroup.name));
		const pickerSlot = append(pickerRow, $('.chat-full-welcome-picker-slot'));

		// Get or create emitter for this option group
		let emitter = this._optionEmitters.get(optionGroup.id);
		if (!emitter) {
			emitter = new Emitter<IChatSessionProviderOptionItem>();
			this._optionEmitters.set(optionGroup.id, emitter);
			this.pickerWidgetsDisposables.add(emitter);
		}

		// Get current option or use default
		const currentOption = this._selectedOptions.get(optionGroup.id)
			?? optionGroup.items.find(item => item.default)
			?? optionGroup.items[0];

		// Create picker delegate
		const delegate: IChatSessionPickerDelegate = {
			getCurrentOption: () => this._selectedOptions.get(optionGroup.id) ?? currentOption,
			onDidChangeOption: emitter.event,
			setOption: (option: IChatSessionProviderOptionItem) => {
				this._selectedOptions.set(optionGroup.id, option);
				emitter!.fire(option);
			},
			getOptionGroup: () => {
				return this.chatSessionsService.getOptionGroupsForSessionType(sessionType)?.find(g => g.id === optionGroup.id);
			},
			getSessionResource: () => undefined // No session resource in welcome view
		};

		// Create a dummy action for the picker
		const action: IAction = {
			id: `chatFullWelcome.${optionGroup.id}`,
			label: optionGroup.name,
			tooltip: optionGroup.description ?? optionGroup.name,
			class: undefined,
			enabled: true,
			run: () => Promise.resolve()
		};

		const initialState = { group: optionGroup, item: currentOption };
		const PickerClass = optionGroup.searchable ? SearchableOptionPickerActionItem : ChatSessionPickerActionItem;
		const picker = this.pickerWidgetsDisposables.add(
			this.instantiationService.createInstance(PickerClass, action, initialState, delegate)
		);
		picker.render(pickerSlot);
		this.sessionOptionPickers.set(optionGroup.id, picker);
	}

	/**
	 * Gets available language models.
	 */
	private getModels(): ILanguageModelChatMetadataAndIdentifier[] {
		return Array.from(this.languageModelsService.getLanguageModelIds())
			.map(id => ({ identifier: id, metadata: this.languageModelsService.lookupLanguageModel(id)! }))
			.filter(m => m.metadata && m.metadata.isUserSelectable !== false)
			.sort((a, b) => {
				const orderA = a.metadata.modelPickerCategory?.order ?? 100;
				const orderB = b.metadata.modelPickerCategory?.order ?? 100;
				return orderA - orderB;
			});
	}

	/**
	 * Disposes all picker widgets.
	 */
	private disposePickerWidgets(): void {
		this.pickerWidgetsDisposables.clear();
		this.modelPickerWidget = undefined;
		this.sessionOptionPickers.clear();
		// Note: Don't clear _optionEmitters or _selectedOptions to preserve state
	}

	/**
	 * Gets the currently selected language model.
	 */
	public getSelectedModel(): ILanguageModelChatMetadataAndIdentifier | undefined {
		return this._currentLanguageModel.get();
	}

	/**
	 * Gets the selected session options.
	 */
	public getSelectedSessionOptions(): Map<string, IChatSessionProviderOptionItem> {
		return new Map(this._selectedOptions);
	}

	/**
	 * Connects an input editor to enable type-to-search mode filtering.
	 * When no mode is selected and the user types, the quick-start options
	 * will be filtered to show matching modes.
	 *
	 * @param inputEditor The code editor widget to connect
	 * @returns A disposable to disconnect the input
	 */
	public connectInputEditor(inputEditor: { onDidChangeModelContent: Event<unknown>; getValue: () => string }): IDisposable {
		const disposables = new DisposableStore();

		disposables.add(inputEditor.onDidChangeModelContent(() => {
			this.handleInputChange(inputEditor.getValue());
		}));

		this._inputConnectionDisposables.value = disposables;
		return disposables;
	}

	/**
	 * Handles input text changes for type-to-search filtering.
	 */
	private handleInputChange(text: string): void {
		// Only filter when no mode is selected
		if (this._selectedQuickStartType !== undefined || !this.quickStartPart) {
			return;
		}

		const trimmedText = text.trim();

		if (trimmedText.length === 0) {
			// Clear filter when input is empty
			if (this._isFiltering) {
				this._isFiltering = false;
				this.quickStartPart.clearFilter();
				this.updateDescriptionForFilter([]);
			}
			return;
		}

		// Filter the options
		const matchingOptions = this.quickStartPart.filterByText(trimmedText);

		// If no matches found, clear the filter and leave no mode selected
		if (matchingOptions.length === 0) {
			if (this._isFiltering) {
				this._isFiltering = false;
				this.quickStartPart.clearFilter();
				this.updateDescriptionForFilter([]);
			}
			return;
		}

		this._isFiltering = true;
		this.updateDescriptionForFilter(matchingOptions);
	}

	/**
	 * Updates the description area based on filter results.
	 */
	private updateDescriptionForFilter(matchingOptions: IQuickStartOption[]): void {
		if (!this.descriptionElement || !this.quickStartPart) {
			return;
		}

		clearNode(this.descriptionElement);

		if (!this._isFiltering) {
			// No filter active, show default hint
			return;
		}

		// Get the best match based on intent scoring
		const bestMatch = this.quickStartPart.getBestMatch();
		if (bestMatch) {
			// Show the two-step flow hint
			const container = append(this.descriptionElement, $('span.chat-full-welcome-description-text.single-match'));

			// First part: "Press Enter to use"
			append(container, document.createTextNode(localize('quickStart.pressEnter', "Press Enter to use ")));

			// Bold the mode name
			const strong = append(container, $('strong'));
			strong.textContent = bestMatch.label;

			// Second part: explain the two-step flow
			append(container, document.createTextNode(localize('quickStart.thenSend', ", then Enter again to send.")));
		}
	}

	/**
	 * Gets whether the welcome part is currently in filtering mode (user typing without mode selected).
	 */
	public isFiltering(): boolean {
		return this._isFiltering;
	}

	/**
	 * Gets the currently matching quick-start options when filtering.
	 * Returns undefined if not filtering.
	 */
	public getMatchingOptions(): IQuickStartOption[] | undefined {
		if (!this._isFiltering || !this.quickStartPart) {
			return undefined;
		}
		const matchingTypes = this.quickStartPart.getMatchingTypes();
		return this.quickStartPart.getOptions().filter(o => matchingTypes.has(o.type));
	}

	/**
	 * Selects the best matching option based on intent (used when user presses Enter while filtering).
	 * @returns true if an option was selected, false otherwise
	 */
	public selectFirstMatchingOption(): boolean {
		if (!this.quickStartPart) {
			return false;
		}

		// Use the smart intent-based best match
		const bestOption = this.quickStartPart.getBestMatch();
		if (!bestOption) {
			return false;
		}

		this._selectedQuickStartType = bestOption.type;
		this._selectedOption = bestOption;
		this._isFiltering = false;
		this.quickStartPart.clearFilter();
		this.expandConfig(bestOption);

		this._onDidSelectQuickStart.fire({
			option: bestOption,
			sessionProvider: bestOption.sessionProvider,
			modeKind: bestOption.modeKind,
			lockMode: bestOption.lockMode,
		});

		return true;
	}

	/**
	 * Shows the expanded mode with all quick-start buttons visible.
	 */
	private showExpandedMode(): void {
		if (!this.quickStartPart || !this.configToolbar) {
			return;
		}

		// Clear the selection - user needs to pick again
		this.quickStartPart.setSelectedType(undefined);
		this._selectedQuickStartType = undefined;
		this._selectedOption = undefined;

		// Dispose picker widgets
		this.disposePickerWidgets();

		// Clear the description
		if (this.descriptionElement) {
			clearNode(this.descriptionElement);
		}

		// Add expanding class for animation
		this.quickStartPart.element.classList.add('expanding');

		// Show the expanded quick-start buttons
		this.quickStartPart.element.style.display = 'flex';

		// Hide the config toolbar (pickers will be shown again when a mode is selected)
		this.configToolbar.style.display = 'none';

		// Remove animation class after it completes
		setTimeout(() => {
			this.quickStartPart?.element.classList.remove('expanding');
		}, 350);
	}

	/**
	 * Layout the sessions control within the available width.
	 */
	public layout(width: number): void {
		this.layoutSessionsControl(width);
	}

	private layoutSessionsControl(width: number): void {
		if (!this.sessionsControl || !this.sessionsControlContainer) {
			return;
		}

		const maxSessions = this.options.fullWelcomeOptions?.maxSessions ?? MAX_SESSIONS;
		const sessionsWidth = Math.min(800, width - 80);
		const visibleSessions = Math.min(
			this.agentSessionsService.model.sessions.filter(s => !s.isArchived()).length,
			maxSessions
		);
		const sessionsHeight = visibleSessions * 52;
		this.sessionsControl.layout(sessionsHeight, sessionsWidth);

		const marginOffset = Math.floor(visibleSessions / 2) * 52;
		this.sessionsControl.element!.style.marginBottom = `-${marginOffset}px`;
	}
}
