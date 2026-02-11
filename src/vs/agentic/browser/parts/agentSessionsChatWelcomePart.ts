/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentSessionsChatWelcomePart.css';
import * as dom from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { toAction } from '../../../base/common/actions.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { isEqual } from '../../../base/common/resources.js';
import { IContextKeyService, ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { localize } from '../../../nls.js';
import { asCSSUrl } from '../../../base/browser/cssValue.js';
import { FileAccess } from '../../../base/common/network.js';
import { IChatSessionProviderOptionGroup, IChatSessionProviderOptionItem, IChatSessionsService } from '../../../workbench/contrib/chat/common/chatSessionsService.js';
import { IAgentChatTargetConfig } from '../widget/agentSessionsChatTargetConfig.js';
import { AgentSessionsControl } from '../../../workbench/contrib/chat/browser/agentSessions/agentSessionsControl.js';
import { AgentSessionProviders, getAgentSessionProviderName } from '../../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';
import { ChatSessionPickerActionItem, IChatSessionPickerDelegate } from '../../../workbench/contrib/chat/browser/chatSessions/chatSessionPickerActionItem.js';
import { SearchableOptionPickerActionItem } from '../../../workbench/contrib/chat/browser/chatSessions/searchableOptionPickerActionItem.js';
import { IAgentSessionsService } from '../../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { IChatService } from '../../../workbench/contrib/chat/common/chatService/chatService.js';
import { WorkspaceFolderCountContext } from '../../../workbench/common/contextkeys.js';

const MAX_SESSIONS = 6;

function isModelOptionGroup(group: IChatSessionProviderOptionGroup): boolean {
	if (group.id === 'models') {
		return true;
	}
	const nameLower = group.name.toLowerCase();
	return nameLower === 'model' || nameLower === 'models';
}


export interface IAgentSessionsWelcomePartOptions {
	/**
	 * Target configuration that manages allowed targets and selection.
	 * Replaces the `ISessionTypePickerDelegate` - no session is created on target change.
	 */
	readonly targetConfig: IAgentChatTargetConfig;

	/**
	 * Returns the current session resource, if a session has been created.
	 * Since sessions are deferred, this may return `undefined` until the first send.
	 */
	readonly getSessionResource?: () => URI | undefined;

	/**
	 * Maximum number of sessions to display in the sessions grid.
	 */
	readonly maxSessions?: number;
}

/**
 * A self-contained full welcome part that renders target buttons with
 * an expandable configuration area that slides open when a target is selected.
 *
	 * Unlike the original `ChatFullWelcomePart` on `sandy081/layout-exploration`,
 * this version uses `IAgentChatTargetConfig` for target management, which means:
	 * - Target selection is purely UI state (no session creation on change)
	 * - Allowed targets can be restricted at creation and modified at runtime
	 * - Option groups are derived from the selected target type
 */
export class AgentSessionsChatWelcomePart extends Disposable {

	public readonly element: HTMLElement;

	/**
	 * Container where the chat input should be inserted by the parent widget.
	 */
	public readonly inputSlot: HTMLElement;

	private readonly _targetConfig: IAgentChatTargetConfig;
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

	private readonly _selectedOptions = new Map<string, IChatSessionProviderOptionItem>();
	private _revealed = false;

	constructor(
		private readonly options: IAgentSessionsWelcomePartOptions,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IProductService private readonly productService: IProductService,
		@IChatService private readonly chatService: IChatService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._targetConfig = options.targetConfig;

		this.element = dom.$('.chat-full-welcome');
		this.inputSlot = dom.$('.chat-full-welcome-inputSlot');

		// Listen for option group changes to re-render pickers
		this._register(this.chatSessionsService.onDidChangeOptionGroups(() => {
			this.renderExtensionPickers();
			this.tryReveal();
		}));

		// React to chat session option changes for the active session
		this._register(this.chatSessionsService.onDidChangeSessionOptions((e: URI | undefined) => {
			const sessionResource = this.options.getSessionResource?.();
			if (sessionResource && isEqual(sessionResource, e)) {
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

		// Listen for target changes from the target config
		this._register(this._targetConfig.onDidChangeSelectedTarget(() => {
			this.updateTargetButtonStates();
			this.renderExtensionPickers();
		}));

		// Listen for allowed targets changes (runtime additions/removals)
		this._register(this._targetConfig.onDidChangeAllowedTargets(() => {
			// Rebuild target buttons since the available set changed
			if (this.targetButtonsContainer) {
				dom.clearNode(this.targetButtonsContainer);
				this.renderTargetButtons(this.targetButtonsContainer);
			}
			this.renderExtensionPickers();
		}));

		this.buildContent();
	}

	private buildContent(): void {
		this.contentDisposables.clear();
		this.sessionsControlDisposables.clear();
		this.sessionsControl = undefined;
		dom.clearNode(this.element);

		// Header with product mascot
		const header = dom.append(this.element, dom.$('.chat-full-welcome-header'));

		// Mascot
		const quality = this.productService.quality ?? 'stable';
		const mascot = dom.append(header, dom.$('.chat-full-welcome-mascot'));
		const mascotUrl = asCSSUrl(FileAccess.asBrowserUri(`vs/workbench/contrib/chat/browser/viewsWelcome/media/code-icon-agent-sessions-${quality}.svg`));
		mascot.style.backgroundImage = mascotUrl;

		// Option group pickers container (between header and input)
		this.pickersContainer = dom.append(this.element, dom.$('.chat-full-welcome-pickers-container'));

		// Input slot - the parent widget inserts the input part here
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

		// Always reveal immediately - the input must be visible so the user
		// can type right away. Option group pickers will appear dynamically
		// when extensions register them via onDidChangeOptionGroups.
		this.doReveal();
	}

	private doReveal(): void {
		if (this._revealed) {
			return;
		}
		this._revealed = true;
		this.element.classList.add('revealed');

		dom.getWindow(this.element).requestAnimationFrame(() => this.updateTargetIndicatorPosition());
	}

	/**
	 * Render option group picker widgets above the input.
	 */
	private renderOptionGroupPickers(): void {
		if (!this.pickersContainer) {
			return;
		}

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

		this.renderExtensionPickers();
	}

	/**
	 * Update active states of existing target buttons without recreating them.
	 */
	private updateTargetButtonStates(): void {
		const activeType = this._targetConfig.selectedTarget.get() ?? AgentSessionProviders.Background;
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

		const activeSessionType = this._targetConfig.selectedTarget.get();
		if (!activeSessionType) {
			this.clearExtensionPickers();
			this.separatorElement.classList.add('hidden');
			return;
		}

		const optionGroups = this.chatSessionsService.getOptionGroupsForSessionType(activeSessionType);
		if (!optionGroups || optionGroups.length === 0) {
			return;
		}

		// Filter to visible option groups
		const visibleGroups: IChatSessionProviderOptionGroup[] = [];
		for (const group of optionGroups) {
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

		this.clearExtensionPickers();
		this.separatorElement.classList.remove('hidden');

		// Trigger fade-in animation
		if (this.extensionPickersContainer) {
			this.extensionPickersContainer.classList.remove('fade-in');
			void this.extensionPickersContainer.offsetWidth;
			this.extensionPickersContainer.classList.add('fade-in');
		}

		for (const optionGroup of visibleGroups) {
			const initialItem = this.getDefaultOptionForGroup(optionGroup);
			const initialState = { group: optionGroup, item: initialItem };

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
						).catch((err) => this.logService.error(`Failed to notify extension of ${optionGroup.id} change:`, err));
					}

					this.renderExtensionPickers();
				},
				getOptionGroup: () => {
					const groups = this.chatSessionsService.getOptionGroupsForSessionType(activeSessionType);
					return groups?.find((g: { id: string }) => g.id === optionGroup.id);
				},
				getSessionResource: () => this.options.getSessionResource?.(),
			};

			const action = toAction({ id: optionGroup.id, label: optionGroup.name, run: () => { } });

			const widget = this.instantiationService.createInstance(
				optionGroup.searchable ? SearchableOptionPickerActionItem : ChatSessionPickerActionItem,
				action, initialState, itemDelegate
			);

			this.pickerWidgetDisposables.add(widget);
			this.pickerWidgets.set(optionGroup.id, widget);

			const row = dom.append(this.extensionPickersContainer!, dom.$('.chat-full-welcome-picker-row'));
			dom.append(row, dom.$('.chat-full-welcome-picker-label', undefined, optionGroup.name));
			const slot = dom.append(row, dom.$('.chat-full-welcome-picker-slot'));
			widget.render(slot);
		}
	}

	/**
	 * Render target session type buttons.
	 * Only shows targets from the allowed set in the target config.
	 */
	private renderTargetButtons(container: HTMLElement): void {
		const allowed = this._targetConfig.allowedTargets.get();
		const activeType = this._targetConfig.selectedTarget.get() ?? AgentSessionProviders.Background;

		// Sliding indicator behind the active button
		this.targetIndicator = dom.append(container, dom.$('.chat-full-welcome-target-indicator'));

		this.targetButtons = [];
		for (const sessionType of allowed) {
			// Skip Local - it maps to the same UI as "Background" in the welcome view
			if (sessionType === AgentSessionProviders.Local) {
				continue;
			}

			const name = sessionType === AgentSessionProviders.Background
				? localize('agentChat.fullWelcome.local', "Local")
				: getAgentSessionProviderName(sessionType);
			const button = dom.$('.chat-full-welcome-target-button');
			const labelEl = dom.$('span.chat-full-welcome-target-label', undefined, name);
			button.appendChild(labelEl);

			button.classList.toggle('active', sessionType === activeType);

			this.contentDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
				this._targetConfig.setSelectedTarget(sessionType);
			}));

			container.appendChild(button);
			this.targetButtons.push({ element: button, sessionType });
		}

		const hasActive = [...allowed].includes(activeType);
		this.targetButtonsContainer?.classList.toggle('has-selection', hasActive);

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

		const isFirstPosition = !this.targetIndicator.classList.contains('visible');
		if (isFirstPosition) {
			this.targetIndicator.style.transition = 'none';
		}

		this.targetIndicator.style.left = `${buttonRect.left - containerRect.left}px`;
		this.targetIndicator.style.width = `${buttonRect.width}px`;
		this.targetIndicator.classList.add('visible');

		if (isFirstPosition) {
			void this.targetIndicator.offsetWidth;
			this.targetIndicator.style.transition = '';
		}
	}

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

	private getDefaultOptionForGroup(optionGroup: IChatSessionProviderOptionGroup): IChatSessionProviderOptionItem | undefined {
		const selected = this._selectedOptions.get(optionGroup.id);
		if (selected) {
			return selected;
		}
		return optionGroup.items.find((item) => item.default === true);
	}

	private syncOptionsFromSession(sessionResource: URI): void {
		const ctx = this.chatService.getChatSessionFromInternalUri(sessionResource);
		if (!ctx) {
			return;
		}

		const activeSessionType = this._targetConfig.selectedTarget.get();
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
				item = optionGroup.items.find((m: { id: string }) => m.id === currentOption.trim());
			} else {
				item = currentOption;
			}

			if (item) {
				// Strip the locked flag - locking is a session-specific concern
				// and the welcome view always shows unlocked pickers.
				const { locked: _locked, ...unlocked } = item;
				this._selectedOptions.set(optionGroup.id, unlocked as IChatSessionProviderOptionItem);
				const emitter = this.optionEmitters.get(optionGroup.id);
				if (emitter) {
					emitter.fire(item);
				}
			}
		}
	}

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

	private clearExtensionPickers(): void {
		this.pickerWidgetDisposables.clear();
		this.pickerWidgets.clear();
		this.optionEmitters.clear();
		if (this.extensionPickersContainer) {
			dom.clearNode(this.extensionPickersContainer);
		}
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

		const maxSessions = this.options.maxSessions ?? MAX_SESSIONS;
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
