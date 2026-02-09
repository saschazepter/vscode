/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatFullWelcomePart.css';
import * as dom from '../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../base/common/event.js';
import { toAction } from '../../../../../base/common/actions.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { IContextKeyService, ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';


import { IAgentSessionsService } from '../agentSessions/agentSessionsService.js';
import { AgentSessionsControl } from '../agentSessions/agentSessionsControl.js';
import { IChatFullWelcomeOptions, ISessionTypePickerDelegate } from '../chat.js';
import { ChatSessionPickerActionItem, IChatSessionPickerDelegate } from '../chatSessions/chatSessionPickerActionItem.js';
import { SearchableOptionPickerActionItem } from '../chatSessions/searchableOptionPickerActionItem.js';
import { IChatSessionProviderOptionGroup, IChatSessionProviderOptionItem, IChatSessionsService, isModelOptionGroup } from '../../common/chatSessionsService.js';
import { IChatService } from '../../common/chatService/chatService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../common/languageModels.js';
import { asCSSUrl } from '../../../../../base/browser/cssValue.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { AgentSessionProviders, getAgentSessionProviderName } from '../agentSessions/agentSessions.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { WorkspaceFolderCountContext } from '../../../../common/contextkeys.js';
import { localize } from '../../../../../nls.js';

const MAX_SESSIONS = 6;

export interface IChatFullWelcomePartOptions {
	/**
	 * Configuration options from the widget.
	 */
	readonly fullWelcomeOptions?: IChatFullWelcomeOptions;

	/**
	 * Delegate for the session type picker.
	 * Provides the active session provider so we know which option groups to show.
	 */
	readonly sessionTypePickerDelegate?: ISessionTypePickerDelegate;

	/**
	 * Returns the current session resource, if a session has been created.
	 */
	readonly getSessionResource?: () => URI | undefined;
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

	private sessionsControl: AgentSessionsControl | undefined;
	private sessionsControlContainer: HTMLElement | undefined;
	private readonly sessionsControlDisposables = this._register(new DisposableStore());
	private readonly contentDisposables = this._register(new DisposableStore());
	// Option group pickers
	private pickersContainer: HTMLElement | undefined;
	private targetButtonsContainer: HTMLElement | undefined;
	private targetButtons: { element: HTMLElement; sessionType: AgentSessionProviders }[] = [];
	private targetIndicator: HTMLElement | undefined;
	private separatorElement: HTMLElement | undefined;
	private extensionPickersContainer: HTMLElement | undefined;
	private readonly pickerWidgets = new Map<string, ChatSessionPickerActionItem | SearchableOptionPickerActionItem>();
	private readonly pickerWidgetDisposables = this._register(new DisposableStore());
	private readonly optionEmitters = new Map<string, Emitter<IChatSessionProviderOptionItem>>();

	// Picker widgets
	private readonly _currentLanguageModel = observableValue<ILanguageModelChatMetadataAndIdentifier | undefined>('currentLanguageModel', undefined);
	private readonly _selectedOptions = new Map<string, IChatSessionProviderOptionItem>();
	private _revealed = false;
	// For welcome view, always show full labels (not compact mode)

	constructor(
		private readonly options: IChatFullWelcomePartOptions,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IProductService private readonly productService: IProductService,
		@IChatService private readonly chatService: IChatService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this.element = dom.$('.chat-full-welcome');
		this.inputSlot = dom.$('.chat-full-welcome-inputSlot');

		// Listen for option group changes to re-render pickers
		// Registered BEFORE buildContent so we don't miss events that fire
		// while the initial UI is being constructed.
		this._register(this.chatSessionsService.onDidChangeOptionGroups(() => {
			this.renderExtensionPickers();
			this.tryReveal();
		}));

		// React to chat session option changes for the active session
		this._register(this.chatSessionsService.onDidChangeSessionOptions(e => {
			const sessionResource = this.options.getSessionResource?.();
			if (sessionResource && isEqual(sessionResource, e)) {
				// Sync selected options from the session service so pickers reflect
				// extension-provided values, then refresh pickers.
				this.syncOptionsFromSession(sessionResource);
				this.renderExtensionPickers();
			}
		}));

		const workspaceFolderCountKey = new Set([WorkspaceFolderCountContext.key]);
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(workspaceFolderCountKey)) {
				this.renderExtensionPickers();
				this.tryReveal();
			}
		}));

		// Listen for session type changes from the delegate
		if (this.options.sessionTypePickerDelegate?.onDidChangeActiveSessionProvider) {
			this._register(this.options.sessionTypePickerDelegate.onDidChangeActiveSessionProvider(() => {
				this.updateTargetButtonStates();
				this.renderExtensionPickers();
			}));
		}

		this.buildContent();
	}

	private buildContent(): void {
		this.contentDisposables.clear();
		this.sessionsControlDisposables.clear();
		this.sessionsControl = undefined;
		dom.clearNode(this.element);

		// Header with product name
		const header = dom.append(this.element, dom.$('.chat-full-welcome-header'));

		// Mascot
		const quality = this.productService.quality ?? 'stable';
		const mascot = dom.append(header, dom.$('.chat-full-welcome-mascot'));
		const mascotUrl = asCSSUrl(FileAccess.asBrowserUri(`vs/workbench/contrib/chat/browser/viewsWelcome/media/code-icon-agent-sessions-${quality}.svg`));
		mascot.style.backgroundImage = mascotUrl;



		// Option group pickers container (between header and input)
		this.pickersContainer = dom.append(this.element, dom.$('.chat-full-welcome-pickers-container'));

		// Input slot - ChatWidget will insert the input part here
		dom.append(this.element, this.inputSlot);

		// Render option group pickers initially
		this.renderOptionGroupPickers();

		// Try reveal (with brief delay for mascot bounce)
		this.tryReveal();
	}

	/**
	 * Transition from the centered-mascot loading state to the full UI.
	 * Only triggers once; waits until at least one option group is registered
	 * for the active session type before revealing.
	 */
	private tryReveal(): void {
		if (this._revealed) {
			return;
		}

		// Check for option groups on the active session type (default: Background)
		const activeType = this.options.sessionTypePickerDelegate?.getActiveSessionProvider?.() ?? AgentSessionProviders.Background;
		const optionGroups = this.chatSessionsService.getOptionGroupsForSessionType(activeType);
		const hasGroups = optionGroups && optionGroups.length > 0;

		if (hasGroups) {
			this.doReveal();
		}
		// again when groups become available.
	}

	private doReveal(): void {
		if (this._revealed) {
			return;
		}
		this._revealed = true;
		this.element.classList.add('revealed');

		// Position the indicator now that the element is visible and has layout
		dom.getWindow(this.element).requestAnimationFrame(() => this.updateTargetIndicatorPosition());
	}

	/**
	 * Render option group picker widgets above the input.
	 * Queries the session service for available option groups and creates picker widgets.
	 */
	private renderOptionGroupPickers(): void {
		if (!this.pickersContainer) {
			return;
		}

		// Clean up existing picker widgets
		this.disposePickerWidgets();
		dom.clearNode(this.pickersContainer);

		const pickersRow = dom.append(this.pickersContainer, dom.$('.chat-full-welcome-pickers'));

		// Stable target buttons
		this.targetButtonsContainer = dom.append(pickersRow, dom.$('.chat-full-welcome-target-group'));
		this.renderTargetButtons(this.targetButtonsContainer);

		// Separator (hidden when no extension pickers)
		this.separatorElement = dom.append(pickersRow, dom.$('.chat-full-welcome-pickers-separator'));

		// Extension pickers container (dynamic)
		this.extensionPickersContainer = dom.append(pickersRow, dom.$('.chat-full-welcome-extension-pickers'));

		// Render the extension pickers
		this.renderExtensionPickers();
	}

	/**
	 * Update active states of existing target buttons without recreating them.
	 */
	private updateTargetButtonStates(): void {
		const activeType = this.options.sessionTypePickerDelegate?.getActiveSessionProvider?.() ?? AgentSessionProviders.Background;
		let hasActive = false;
		for (const { element, sessionType } of this.targetButtons) {
			const isActive = sessionType === activeType;
			element.classList.toggle('active', isActive);
			if (isActive) {
				hasActive = true;
			}
		}
		this.targetButtonsContainer?.classList.toggle('has-selection', hasActive);
		this.updateTargetIndicatorPosition();
	}

	/**
	 * Render only the extension-contributed pickers (not the target buttons).
	 */
	private renderExtensionPickers(): void {
		if (!this.extensionPickersContainer || !this.separatorElement) {
			return;
		}

		// Determine the active session type
		const activeSessionType = this.options.sessionTypePickerDelegate?.getActiveSessionProvider?.();
		if (!activeSessionType) {
			this.clearExtensionPickers();
			this.separatorElement.classList.add('hidden');
			return;
		}

		// Get option groups for the active session type
		const optionGroups = this.chatSessionsService.getOptionGroupsForSessionType(activeSessionType);
		if (!optionGroups || optionGroups.length === 0) {
			// Don't clear existing pickers, extensions may not have registered
			// option groups yet for this session type. Keep showing the previous
			// pickers until onDidChangeOptionGroups fires with new data.
			return;
		}

		// Filter to visible option groups
		const visibleGroups: IChatSessionProviderOptionGroup[] = [];
		for (const group of optionGroups) {
			// Skip the models option group, it is shown in the chat input box instead.
			if (isModelOptionGroup(group)) {
				continue;
			}
			const hasItems = group.items.length > 0 || (group.commands || []).length > 0;
			const passesWhenClause = this.evaluateOptionGroupVisibility(group);
			if (hasItems && passesWhenClause) {
				visibleGroups.push(group);
			}
		}

		if (visibleGroups.length === 0) {
			this.clearExtensionPickers();
			this.separatorElement.classList.add('hidden');
			return;
		}

		// Groups are available,clear old pickers and render new ones
		this.clearExtensionPickers();

		// Show separator
		this.separatorElement.classList.remove('hidden');

		// Trigger fade-in animation on the extension pickers container
		if (this.extensionPickersContainer) {
			this.extensionPickersContainer.classList.remove('fade-in');
			// Force reflow to restart animation
			void this.extensionPickersContainer.offsetWidth;
			this.extensionPickersContainer.classList.add('fade-in');
		}

		// Create a picker widget for each visible option group
		for (const optionGroup of visibleGroups) {
			const initialItem = this.getDefaultOptionForGroup(optionGroup);
			const initialState = { group: optionGroup, item: initialItem };

			// Create delegate for this option group
			const emitter = this.getOrCreateOptionEmitter(optionGroup.id);
			const itemDelegate: IChatSessionPickerDelegate = {
				getCurrentOption: () => this._selectedOptions.get(optionGroup.id) ?? this.getDefaultOptionForGroup(optionGroup),
				onDidChangeOption: emitter.event,
				setOption: (option: IChatSessionProviderOptionItem) => {
					this._selectedOptions.set(optionGroup.id, option);
					emitter.fire(option);

					// Notify extension of the option change if we have a session
					const sessionResource = this.options.getSessionResource?.();
					const currentCtx = sessionResource ? this.chatService.getChatSessionFromInternalUri(sessionResource) : undefined;
					if (currentCtx) {
						this.chatSessionsService.notifySessionOptionsChange(
							currentCtx.chatSessionResource,
							[{ optionId: optionGroup.id, value: option }]
						).catch(err => this.logService.error(`Failed to notify extension of ${optionGroup.id} change:`, err));
					}

					// Re-render extension pickers in case `when` clauses depend on this option
					this.renderExtensionPickers();
				},
				getOptionGroup: () => {
					const groups = this.chatSessionsService.getOptionGroupsForSessionType(activeSessionType);
					return groups?.find(g => g.id === optionGroup.id);
				},
				getSessionResource: () => this.options.getSessionResource?.(),
			};

			// Use toAction (plain object) instead of new Action() because
			// ChatSessionPickerActionItem spreads the action, and prototype
			// getters (like Action.enabled) are lost during spread. MenuItemAction
			// works in the toolbar path because its enabled is an own property.
			const action = toAction({ id: optionGroup.id, label: optionGroup.name, run: () => { } });

			const widget = this.instantiationService.createInstance(
				optionGroup.searchable ? SearchableOptionPickerActionItem : ChatSessionPickerActionItem,
				action, initialState, itemDelegate
			);


			this.pickerWidgetDisposables.add(widget);
			this.pickerWidgets.set(optionGroup.id, widget);

			// Render the picker into a row with label + slot
			const row = dom.append(this.extensionPickersContainer!, dom.$('.chat-full-welcome-picker-row'));
			dom.append(row, dom.$('.chat-full-welcome-picker-label', undefined, optionGroup.name));
			const slot = dom.append(row, dom.$('.chat-full-welcome-picker-slot'));
			widget.render(slot);
		}
	}

	/**
	 * Render target session type buttons (Background and Cloud only).
	 * These are stable and only update active state on session type change.
	 */
	private renderTargetButtons(container: HTMLElement): void {
		const targetTypes = [AgentSessionProviders.Background, AgentSessionProviders.Cloud];
		const activeType = this.options.sessionTypePickerDelegate?.getActiveSessionProvider?.() ?? AgentSessionProviders.Background;

		// Sliding indicator behind the active button
		this.targetIndicator = dom.append(container, dom.$('.chat-full-welcome-target-indicator'));

		this.targetButtons = [];
		for (const sessionType of targetTypes) {
			const name = sessionType === AgentSessionProviders.Background
				? localize('chat.session.chatFullWelcome.local', "Local")
				: getAgentSessionProviderName(sessionType);
			const button = dom.$('.chat-full-welcome-target-button');
			const labelEl = dom.$('span.chat-full-welcome-target-label', undefined, name);
			button.appendChild(labelEl);

			button.classList.toggle('active', sessionType === activeType);

			this.contentDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
				if (this.options.sessionTypePickerDelegate?.setActiveSessionProvider) {
					this.options.sessionTypePickerDelegate.setActiveSessionProvider(sessionType);
				}
			}));

			container.appendChild(button);
			this.targetButtons.push({ element: button, sessionType });
		}

		// Mark has-selection if there's already an active target
		const hasActive = targetTypes.includes(activeType);
		this.targetButtonsContainer?.classList.toggle('has-selection', hasActive);

		// Position indicator after layout settles
		dom.getWindow(container).requestAnimationFrame(() => this.updateTargetIndicatorPosition());
	}

	/**
	 * Update the sliding indicator position to match the currently active target button.
	 */
	private updateTargetIndicatorPosition(): void {
		if (!this.targetIndicator || !this.targetButtonsContainer) {
			return;
		}

		const activeButton = this.targetButtons.find(b => b.element.classList.contains('active'));
		if (!activeButton) {
			this.targetIndicator.classList.remove('visible');
			return;
		}

		const containerRect = this.targetButtonsContainer.getBoundingClientRect();
		const buttonRect = activeButton.element.getBoundingClientRect();

		// If the indicator is not yet visible, suppress the slide transition
		// so it appears instantly at the correct position on first load.
		const isFirstPosition = !this.targetIndicator.classList.contains('visible');
		if (isFirstPosition) {
			this.targetIndicator.style.transition = 'none';
		}

		this.targetIndicator.style.left = `${buttonRect.left - containerRect.left}px`;
		this.targetIndicator.style.width = `${buttonRect.width}px`;
		this.targetIndicator.classList.add('visible');

		if (isFirstPosition) {
			// Force a reflow then restore the transition for future slides
			void this.targetIndicator.offsetWidth;
			this.targetIndicator.style.transition = '';
		}
	}

	/**
	 * Evaluate whether an option group should be visible based on its `when` expression.
	 */
	private evaluateOptionGroupVisibility(optionGroup: { id: string; when?: string }): boolean {
		if (!optionGroup.when) {
			return true;
		}

		const expr = ContextKeyExpr.deserialize(optionGroup.when);
		if (!expr) {
			return true;
		}

		return this.contextKeyService.contextMatchesRules(expr);
	}

	/**
	 * Get the default option for an option group.
	 */
	private getDefaultOptionForGroup(optionGroup: IChatSessionProviderOptionGroup): IChatSessionProviderOptionItem | undefined {
		// Check if user has previously selected an option
		const selected = this._selectedOptions.get(optionGroup.id);
		if (selected) {
			return selected;
		}
		// Fall back to the default item
		return optionGroup.items.find(item => item.default);
	}

	/**
	 * Sync selected options from the session service into `_selectedOptions`
	 * and fire emitters so existing picker widgets update their labels.
	 */
	private syncOptionsFromSession(sessionResource: URI): void {
		const ctx = this.chatService.getChatSessionFromInternalUri(sessionResource);
		if (!ctx) {
			return;
		}

		const activeSessionType = this.options.sessionTypePickerDelegate?.getActiveSessionProvider?.();
		if (!activeSessionType) {
			return;
		}

		const optionGroups = this.chatSessionsService.getOptionGroupsForSessionType(activeSessionType);
		if (!optionGroups) {
			return;
		}

		for (const optionGroup of optionGroups) {
			if (isModelOptionGroup(optionGroup)) {
				continue;
			}

			const currentOption = this.chatSessionsService.getSessionOption(ctx.chatSessionResource, optionGroup.id);
			if (!currentOption) {
				continue;
			}

			let item: IChatSessionProviderOptionItem | undefined;
			if (typeof currentOption === 'string') {
				item = optionGroup.items.find(m => m.id === currentOption.trim());
			} else {
				item = currentOption;
			}

			if (item) {
				this._selectedOptions.set(optionGroup.id, item);
				// Fire emitter so existing widgets update their label
				const emitter = this.optionEmitters.get(optionGroup.id);
				if (emitter) {
					emitter.fire(item);
				}
			}
		}
	}

	/**
	 * Get or create an event emitter for an option group.
	 */
	private getOrCreateOptionEmitter(optionGroupId: string): Emitter<IChatSessionProviderOptionItem> {
		let emitter = this.optionEmitters.get(optionGroupId);
		if (!emitter) {
			emitter = new Emitter<IChatSessionProviderOptionItem>();
			this.optionEmitters.set(optionGroupId, emitter);
			this.pickerWidgetDisposables.add(emitter);
		}
		return emitter;
	}

	private disposePickerWidgets(): void {
		this.pickerWidgetDisposables.clear();
		this.pickerWidgets.clear();
		this.optionEmitters.clear();
		this.targetButtons = [];
	}

	/**
	 * Clear only the extension picker widgets and their container.
	 */
	private clearExtensionPickers(): void {
		this.pickerWidgetDisposables.clear();
		this.pickerWidgets.clear();
		this.optionEmitters.clear();
		if (this.extensionPickersContainer) {
			dom.clearNode(this.extensionPickersContainer);
		}
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
	 * Clear cached selected options and re-render pickers.
	 * Called when switching to a new session so stale selections
	 * from the previous session are not carried over.
	 */
	public resetSelectedOptions(): void {
		this._selectedOptions.clear();
		this.renderExtensionPickers();
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
