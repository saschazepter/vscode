/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatWidget.css';
import './media/chatWelcomePart.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toAction } from '../../../../base/common/actions.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';

import { CodeEditorWidget, ICodeEditorWidgetOptions } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { EditorExtensionsRegistry } from '../../../../editor/browser/editorExtensions.js';
import { IEditorConstructionOptions } from '../../../../editor/browser/config/editorConfiguration.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService, IContextKey, RawContextKey, ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { isEqual } from '../../../../base/common/resources.js';
import { asCSSUrl } from '../../../../base/browser/cssValue.js';
import { FileAccess } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { AgentSessionProviders, getAgentSessionProviderName } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';
import { ISessionsWorkbenchService } from '../../sessions/browser/sessionsWorkbenchService.js';
import { ChatSessionPosition, getResourceForNewChatSession } from '../../../../workbench/contrib/chat/browser/chatSessions/chatSessions.contribution.js';
import { ChatSessionPickerActionItem, IChatSessionPickerDelegate } from '../../../../workbench/contrib/chat/browser/chatSessions/chatSessionPickerActionItem.js';
import { SearchableOptionPickerActionItem } from '../../../../workbench/contrib/chat/browser/chatSessions/searchableOptionPickerActionItem.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../workbench/contrib/chat/common/constants.js';
import { IChatSendRequestOptions } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatSessionProviderOptionGroup, IChatSessionProviderOptionItem, IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { IModelPickerDelegate, ModelPickerActionItem } from '../../../../workbench/contrib/chat/browser/widget/input/modelPickerActionItem.js';
import { IChatInputPickerOptions } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPickerActionItem.js';
import { WorkspaceFolderCountContext } from '../../../../workbench/common/contextkeys.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { ContextMenuController } from '../../../../editor/contrib/contextmenu/browser/contextmenu.js';
import { getSimpleEditorOptions } from '../../../../workbench/contrib/codeEditor/browser/simpleEditorOptions.js';

// #region --- Target Config ---

/**
 * Tracks which agent session targets are available and which is selected.
 * Targets are fixed at construction time; only the selection changes.
 */
export interface ITargetConfig {
	readonly allowedTargets: IObservable<ReadonlySet<AgentSessionProviders>>;
	readonly selectedTarget: IObservable<AgentSessionProviders | undefined>;
	readonly onDidChangeSelectedTarget: Event<AgentSessionProviders | undefined>;
	readonly onDidChangeAllowedTargets: Event<ReadonlySet<AgentSessionProviders>>;
	setSelectedTarget(target: AgentSessionProviders): void;
}

export interface ITargetConfigOptions {
	allowedTargets: AgentSessionProviders[];
	defaultTarget?: AgentSessionProviders;
}

class TargetConfig extends Disposable implements ITargetConfig {

	private readonly _allowedTargets = observableValue<ReadonlySet<AgentSessionProviders>>('allowedTargets', new Set());
	readonly allowedTargets: IObservable<ReadonlySet<AgentSessionProviders>> = this._allowedTargets;

	private readonly _selectedTarget = observableValue<AgentSessionProviders | undefined>('selectedTarget', undefined);
	readonly selectedTarget: IObservable<AgentSessionProviders | undefined> = this._selectedTarget;

	private readonly _onDidChangeSelectedTarget = this._register(new Emitter<AgentSessionProviders | undefined>());
	readonly onDidChangeSelectedTarget = this._onDidChangeSelectedTarget.event;

	private readonly _onDidChangeAllowedTargets = this._register(new Emitter<ReadonlySet<AgentSessionProviders>>());
	readonly onDidChangeAllowedTargets = this._onDidChangeAllowedTargets.event;

	constructor(options: ITargetConfigOptions) {
		super();
		const initialSet = new Set(options.allowedTargets);
		this._allowedTargets.set(initialSet, undefined);
		const defaultTarget = options.defaultTarget && initialSet.has(options.defaultTarget)
			? options.defaultTarget
			: initialSet.values().next().value;
		this._selectedTarget.set(defaultTarget, undefined);
	}

	setSelectedTarget(target: AgentSessionProviders): void {
		const allowed = this._allowedTargets.get();
		if (!allowed.has(target)) {
			throw new Error(`Target "${target}" is not in the allowed set`);
		}
		if (this._selectedTarget.get() !== target) {
			this._selectedTarget.set(target, undefined);
			this._onDidChangeSelectedTarget.fire(target);
		}
	}
}

// #endregion

// #region --- Chat Welcome Widget ---

/**
 * Data passed to the `onSendRequest` callback when the user submits a query.
 */
export interface INewChatSendRequestData {
	readonly resource: URI;
	readonly target: AgentSessionProviders;
	readonly query: string;
	readonly sendOptions: IChatSendRequestOptions;
	readonly selectedOptions: ReadonlyMap<string, IChatSessionProviderOptionItem>;
}

/**
 * Options for creating a `NewChatWidget`.
 */
export interface INewChatWidgetOptions {
	readonly targetConfig: ITargetConfigOptions;
	readonly onSendRequest?: (data: INewChatSendRequestData) => void;
	readonly sessionPosition?: ChatSessionPosition;
}

/**
 * A self-contained new-session chat widget with a welcome view (mascot, target
 * buttons, option pickers), an input editor, model picker, and send button.
 *
 * This widget is shown only in the empty/welcome state. Once the user sends
 * a message, a session is created and the workbench ChatViewPane takes over.
 */
class NewChatWidget extends Disposable {

	private readonly _targetConfig: ITargetConfig;
	private readonly _options: INewChatWidgetOptions;

	// Input
	private _editor!: CodeEditorWidget;
	private readonly _currentLanguageModel = observableValue<ILanguageModelChatMetadataAndIdentifier | undefined>('currentLanguageModel', undefined);
	private readonly _modelPickerDisposable = this._register(new MutableDisposable());
	private _pendingSessionResource: URI | undefined;

	// Welcome part
	private readonly _welcomeContentDisposables = this._register(new DisposableStore());
	private _pickersContainer: HTMLElement | undefined;
	private _targetButtonsContainer: HTMLElement | undefined;
	private _targetButtons: { element: HTMLElement; sessionType: AgentSessionProviders }[] = [];
	private _targetIndicator: HTMLElement | undefined;
	private _separatorElement: HTMLElement | undefined;
	private _extensionPickersContainer: HTMLElement | undefined;
	private _inputSlot: HTMLElement | undefined;
	private readonly _pickerWidgets = new Map<string, ChatSessionPickerActionItem | SearchableOptionPickerActionItem>();
	private readonly _pickerWidgetDisposables = this._register(new DisposableStore());
	private readonly _optionEmitters = new Map<string, Emitter<IChatSessionProviderOptionItem>>();
	private readonly _selectedOptions = new Map<string, IChatSessionProviderOptionItem>();
	private readonly _optionContextKeys = new Map<string, IContextKey<string>>();
	private readonly _whenClauseKeys = new Set<string>();

	constructor(
		options: INewChatWidgetOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@IModelService private readonly modelService: IModelService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		this._targetConfig = this._register(new TargetConfig(options.targetConfig));
		this._options = options;

		// When target changes, regenerate pending resource
		this._register(this._targetConfig.onDidChangeSelectedTarget(() => {
			this._generatePendingSessionResource();
			this._updateTargetButtonStates();
			this._renderExtensionPickers(true);
		}));

		this._register(this._targetConfig.onDidChangeAllowedTargets(() => {
			if (this._targetButtonsContainer) {
				dom.clearNode(this._targetButtonsContainer);
				this._renderTargetButtons(this._targetButtonsContainer);
			}
			this._renderExtensionPickers(true);
		}));

		// Listen for option group changes to re-render pickers
		this._register(this.chatSessionsService.onDidChangeOptionGroups(() => {
			this._renderExtensionPickers();
		}));

		// React to chat session option changes
		this._register(this.chatSessionsService.onDidChangeSessionOptions((e: URI | undefined) => {
			if (this._pendingSessionResource && isEqual(this._pendingSessionResource, e)) {
				this._syncOptionsFromSession(this._pendingSessionResource);
				this._renderExtensionPickers();
			}
		}));

		const workspaceFolderCountKey = new Set([WorkspaceFolderCountContext.key]);
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(workspaceFolderCountKey)) {
				this._renderExtensionPickers(true);
			}
			if (this._whenClauseKeys.size > 0 && e.affectsSome(this._whenClauseKeys)) {
				this._renderExtensionPickers(true);
			}
		}));
	}

	// --- Rendering ---

	render(container: HTMLElement): void {
		const wrapper = dom.append(container, dom.$('.sessions-chat-widget'));
		const welcomeElement = dom.append(wrapper, dom.$('.chat-full-welcome'));

		// Mascot
		const header = dom.append(welcomeElement, dom.$('.chat-full-welcome-header'));
		const quality = this.productService.quality ?? 'stable';
		const mascot = dom.append(header, dom.$('.chat-full-welcome-mascot'));
		mascot.style.backgroundImage = asCSSUrl(FileAccess.asBrowserUri(`vs/sessions/contrib/chat/browser/media/code-icon-agent-sessions-${quality}.svg`));

		// Option group pickers
		this._pickersContainer = dom.append(welcomeElement, dom.$('.chat-full-welcome-pickers-container'));

		// Input slot
		this._inputSlot = dom.append(welcomeElement, dom.$('.chat-full-welcome-inputSlot'));

		// Render target buttons & extension pickers
		this._renderOptionGroupPickers();

		// Input area inside the input slot
		const inputArea = dom.$('.sessions-chat-input-area');
		this._createEditor(inputArea);
		this._createToolbar(inputArea);
		this._inputSlot.appendChild(inputArea);

		// Initialize model picker
		this._initDefaultModel();

		// Generate pending resource for option changes
		this._generatePendingSessionResource();

		// Reveal
		welcomeElement.classList.add('revealed');
	}

	private _generatePendingSessionResource(): void {
		const target = this._targetConfig.selectedTarget.get();
		if (!target || target === AgentSessionProviders.Local) {
			this._pendingSessionResource = undefined;
			return;
		}
		this._pendingSessionResource = getResourceForNewChatSession({
			type: target,
			position: this._options.sessionPosition ?? ChatSessionPosition.Sidebar,
			displayName: '',
		});
	}

	// --- Editor ---

	private _createEditor(container: HTMLElement): void {
		const editorContainer = dom.append(container, dom.$('.sessions-chat-editor'));

		const uri = URI.from({ scheme: 'sessions-chat', path: `input-${Date.now()}` });
		const textModel = this._register(this.modelService.createModel('', null, uri, true));

		const editorOptions: IEditorConstructionOptions = {
			...getSimpleEditorOptions(this.configurationService),
			readOnly: false,
			ariaLabel: localize('chatInput', "Chat input"),
			placeholder: localize('chatPlaceholder', "Run tasks in the background, type '#' for adding context"),
			fontFamily: 'system-ui, -apple-system, sans-serif',
			fontSize: 13,
			lineHeight: 20,
			padding: { top: 8, bottom: 2 },
			lineDecorationsWidth: 12,
			wrappingStrategy: 'advanced',
			stickyScroll: { enabled: false },
			renderWhitespace: 'none',
		};

		const widgetOptions: ICodeEditorWidgetOptions = {
			isSimpleWidget: true,
			contributions: EditorExtensionsRegistry.getSomeEditorContributions([
				ContextMenuController.ID,
			]),
		};

		this._editor = this._register(this.instantiationService.createInstance(
			CodeEditorWidget, editorContainer, editorOptions, widgetOptions,
		));
		this._editor.setModel(textModel);

		this._register(this._editor.onKeyDown(e => {
			if (e.keyCode === KeyCode.Enter && !e.shiftKey && !e.ctrlKey && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				this._send();
			}
		}));

		this._register(this._editor.onDidContentSizeChange(() => {
			const contentHeight = this._editor.getContentHeight();
			const clampedHeight = Math.min(Math.max(contentHeight, 36), 200);
			editorContainer.style.height = `${clampedHeight}px`;
			this._editor.layout();
		}));
	}

	private _createToolbar(container: HTMLElement): void {
		const toolbar = dom.append(container, dom.$('.sessions-chat-toolbar'));

		const modelPickerContainer = dom.append(toolbar, dom.$('.sessions-chat-model-picker'));
		this._createModelPicker(modelPickerContainer);

		dom.append(toolbar, dom.$('.sessions-chat-toolbar-spacer'));

		const sendButton = dom.append(toolbar, dom.$('.sessions-chat-send-button'));
		sendButton.tabIndex = 0;
		sendButton.role = 'button';
		sendButton.title = localize('send', "Send");
		dom.append(sendButton, renderIcon(Codicon.send));
		this._register(dom.addDisposableListener(sendButton, dom.EventType.CLICK, () => this._send()));
	}

	// --- Model picker ---

	private _createModelPicker(container: HTMLElement): void {
		const delegate: IModelPickerDelegate = {
			currentModel: this._currentLanguageModel,
			setModel: (model: ILanguageModelChatMetadataAndIdentifier) => {
				this._currentLanguageModel.set(model, undefined);
			},
			getModels: () => this._getAvailableModels(),
		};

		const pickerOptions: IChatInputPickerOptions = {
			onlyShowIconsForDefaultActions: observableValue('onlyShowIcons', false),
			hoverPosition: { hoverPosition: HoverPosition.ABOVE },
		};

		const action = { id: 'sessions.modelPicker', label: '', enabled: true, class: undefined, tooltip: '', run: () => { } };

		const modelPicker = this.instantiationService.createInstance(
			ModelPickerActionItem, action, undefined, delegate, pickerOptions,
		);
		this._modelPickerDisposable.value = modelPicker;
		modelPicker.render(container);
	}

	private _initDefaultModel(): void {
		const models = this._getAvailableModels();
		if (models.length > 0) {
			this._currentLanguageModel.set(models[0], undefined);
		}

		this._register(this.languageModelsService.onDidChangeLanguageModels(() => {
			if (!this._currentLanguageModel.get()) {
				const models = this._getAvailableModels();
				if (models.length > 0) {
					this._currentLanguageModel.set(models[0], undefined);
				}
			}
		}));
	}

	private _getAvailableModels(): ILanguageModelChatMetadataAndIdentifier[] {
		return this.languageModelsService.getLanguageModelIds()
			.map(id => {
				const metadata = this.languageModelsService.lookupLanguageModel(id);
				return metadata ? { metadata, identifier: id } : undefined;
			})
			.filter((m): m is ILanguageModelChatMetadataAndIdentifier => !!m && !!m.metadata.isUserSelectable);
	}

	// --- Welcome: Target buttons ---

	private _renderOptionGroupPickers(): void {
		if (!this._pickersContainer) {
			return;
		}

		this._disposePickerWidgets();
		dom.clearNode(this._pickersContainer);

		const pickersRow = dom.append(this._pickersContainer, dom.$('.chat-full-welcome-pickers'));

		this._targetButtonsContainer = dom.append(pickersRow, dom.$('.chat-full-welcome-target-group'));
		this._renderTargetButtons(this._targetButtonsContainer);

		this._separatorElement = dom.append(pickersRow, dom.$('.chat-full-welcome-pickers-separator'));

		this._extensionPickersContainer = dom.append(pickersRow, dom.$('.chat-full-welcome-extension-pickers'));

		this._renderExtensionPickers();
	}

	private _renderTargetButtons(container: HTMLElement): void {
		const allowed = this._targetConfig.allowedTargets.get();
		const activeType = this._targetConfig.selectedTarget.get() ?? AgentSessionProviders.Background;

		this._targetIndicator = dom.append(container, dom.$('.chat-full-welcome-target-indicator'));
		this._targetButtons = [];

		for (const sessionType of allowed) {
			if (sessionType === AgentSessionProviders.Local) {
				continue;
			}

			const name = getAgentSessionProviderName(sessionType);
			const button = dom.$('.chat-full-welcome-target-button');
			button.appendChild(dom.$('span.chat-full-welcome-target-label', undefined, name));

			const tooltip = this._getTargetTooltip(sessionType);
			if (tooltip) {
				this._welcomeContentDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), button, tooltip));
			}

			button.classList.toggle('active', sessionType === activeType);
			this._welcomeContentDisposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
				this._targetConfig.setSelectedTarget(sessionType);
			}));

			container.appendChild(button);
			this._targetButtons.push({ element: button, sessionType });
		}

		container.classList.toggle('has-selection', [...allowed].includes(activeType));
		dom.getWindow(container).requestAnimationFrame(() => this._updateTargetIndicatorPosition());
	}

	private _updateTargetButtonStates(): void {
		const activeType = this._targetConfig.selectedTarget.get() ?? AgentSessionProviders.Background;
		let hasActive = false;
		for (const { element, sessionType } of this._targetButtons) {
			const isActive = sessionType === activeType;
			element.classList.toggle('active', isActive);
			if (isActive) {
				hasActive = true;
			}
		}
		this._targetButtonsContainer?.classList.toggle('has-selection', hasActive);
		this._updateTargetIndicatorPosition();
	}

	private _updateTargetIndicatorPosition(): void {
		if (!this._targetIndicator || !this._targetButtonsContainer) {
			return;
		}
		const activeButton = this._targetButtons.find(b => b.element.classList.contains('active'));
		if (!activeButton) {
			this._targetIndicator.classList.remove('visible');
			return;
		}
		const containerRect = this._targetButtonsContainer.getBoundingClientRect();
		const buttonRect = activeButton.element.getBoundingClientRect();
		const isFirstPosition = !this._targetIndicator.classList.contains('visible');
		if (isFirstPosition) {
			this._targetIndicator.style.transition = 'none';
		}
		this._targetIndicator.style.left = `${buttonRect.left - containerRect.left}px`;
		this._targetIndicator.style.width = `${buttonRect.width}px`;
		this._targetIndicator.classList.add('visible');
		if (isFirstPosition) {
			void this._targetIndicator.offsetWidth;
			this._targetIndicator.style.transition = '';
		}
	}

	private _getTargetTooltip(sessionType: AgentSessionProviders): string | undefined {
		switch (sessionType) {
			case AgentSessionProviders.Background:
				return localize('target.worktree.tooltip', "Run the agent locally using a git worktree. Changes are made in an isolated branch and can be reviewed before merging.");
			case AgentSessionProviders.Cloud:
				return localize('target.cloud.tooltip', "Run the agent in the cloud. The session runs remotely and results are synced back when complete.");
			default:
				return undefined;
		}
	}

	// --- Welcome: Extension option pickers ---

	private _renderExtensionPickers(force?: boolean): void {
		if (!this._extensionPickersContainer || !this._separatorElement) {
			return;
		}

		const activeSessionType = this._targetConfig.selectedTarget.get();
		if (!activeSessionType) {
			this._clearExtensionPickers();
			this._separatorElement.classList.add('hidden');
			return;
		}

		const optionGroups = this.chatSessionsService.getOptionGroupsForSessionType(activeSessionType);
		if (!optionGroups || optionGroups.length === 0) {
			return;
		}

		const visibleGroups: IChatSessionProviderOptionGroup[] = [];
		this._whenClauseKeys.clear();
		for (const group of optionGroups) {
			if (isModelOptionGroup(group)) {
				continue;
			}
			if (group.when) {
				const expr = ContextKeyExpr.deserialize(group.when);
				if (expr) {
					for (const key of expr.keys()) {
						this._whenClauseKeys.add(key);
					}
				}
			}
			const hasItems = group.items.length > 0 || (group.commands || []).length > 0;
			const passesWhenClause = this._evaluateOptionGroupVisibility(group);
			if (hasItems && passesWhenClause) {
				visibleGroups.push(group);
			}
		}

		if (visibleGroups.length === 0) {
			this._clearExtensionPickers();
			this._separatorElement.classList.add('hidden');
			return;
		}

		visibleGroups.sort((a, b) => (a.when ? 1 : 0) - (b.when ? 1 : 0));

		if (!force && this._pickerWidgets.size === visibleGroups.length) {
			const allMatch = visibleGroups.every(g => this._pickerWidgets.has(g.id));
			if (allMatch) {
				return;
			}
		}

		this._clearExtensionPickers();
		this._separatorElement.classList.remove('hidden');

		for (const optionGroup of visibleGroups) {
			const initialItem = this._getDefaultOptionForGroup(optionGroup);
			const initialState = { group: optionGroup, item: initialItem };

			if (initialItem) {
				this._updateOptionContextKey(optionGroup.id, initialItem.id);
			}

			const emitter = this._getOrCreateOptionEmitter(optionGroup.id);
			const itemDelegate: IChatSessionPickerDelegate = {
				getCurrentOption: () => this._selectedOptions.get(optionGroup.id) ?? this._getDefaultOptionForGroup(optionGroup),
				onDidChangeOption: emitter.event,
				setOption: (option: IChatSessionProviderOptionItem) => {
					this._selectedOptions.set(optionGroup.id, option);
					this._updateOptionContextKey(optionGroup.id, option.id);
					emitter.fire(option);

					if (this._pendingSessionResource) {
						this.chatSessionsService.notifySessionOptionsChange(
							this._pendingSessionResource,
							[{ optionId: optionGroup.id, value: option }]
						).catch((err) => this.logService.error(`Failed to notify extension of ${optionGroup.id} change:`, err));
					}

					this._renderExtensionPickers(true);
				},
				getOptionGroup: () => {
					const groups = this.chatSessionsService.getOptionGroupsForSessionType(activeSessionType);
					return groups?.find((g: { id: string }) => g.id === optionGroup.id);
				},
				getSessionResource: () => this._pendingSessionResource,
			};

			const action = toAction({ id: optionGroup.id, label: optionGroup.name, run: () => { } });
			const widget = this.instantiationService.createInstance(
				optionGroup.searchable ? SearchableOptionPickerActionItem : ChatSessionPickerActionItem,
				action, initialState, itemDelegate
			);

			this._pickerWidgetDisposables.add(widget);
			this._pickerWidgets.set(optionGroup.id, widget);

			const row = dom.append(this._extensionPickersContainer!, dom.$('.chat-full-welcome-picker-row'));
			dom.append(row, dom.$('.chat-full-welcome-picker-label', undefined, optionGroup.name));
			const slot = dom.append(row, dom.$('.chat-full-welcome-picker-slot'));
			widget.render(slot);
		}
	}

	private _evaluateOptionGroupVisibility(optionGroup: { id: string; when?: string }): boolean {
		if (!optionGroup.when) {
			return true;
		}
		const expr = ContextKeyExpr.deserialize(optionGroup.when);
		return !expr || this.contextKeyService.contextMatchesRules(expr);
	}

	private _getDefaultOptionForGroup(optionGroup: IChatSessionProviderOptionGroup): IChatSessionProviderOptionItem | undefined {
		return this._selectedOptions.get(optionGroup.id) ?? optionGroup.items.find((item) => item.default === true);
	}

	private _syncOptionsFromSession(sessionResource: URI): void {
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
			const currentOption = this.chatSessionsService.getSessionOption(sessionResource, optionGroup.id);
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
				const { locked: _locked, ...unlocked } = item;
				this._selectedOptions.set(optionGroup.id, unlocked as IChatSessionProviderOptionItem);
				this._updateOptionContextKey(optionGroup.id, item.id);
				this._optionEmitters.get(optionGroup.id)?.fire(item);
			}
		}
	}

	private _updateOptionContextKey(optionGroupId: string, optionItemId: string): void {
		let contextKey = this._optionContextKeys.get(optionGroupId);
		if (!contextKey) {
			const rawKey = new RawContextKey<string>(`chatSessionOption.${optionGroupId}`, '');
			contextKey = rawKey.bindTo(this.contextKeyService);
			this._optionContextKeys.set(optionGroupId, contextKey);
		}
		contextKey.set(optionItemId.trim());
	}

	private _getOrCreateOptionEmitter(optionGroupId: string): Emitter<IChatSessionProviderOptionItem> {
		let emitter = this._optionEmitters.get(optionGroupId);
		if (!emitter) {
			emitter = new Emitter<IChatSessionProviderOptionItem>();
			this._optionEmitters.set(optionGroupId, emitter);
			this._pickerWidgetDisposables.add(emitter);
		}
		return emitter;
	}

	private _disposePickerWidgets(): void {
		this._pickerWidgetDisposables.clear();
		this._pickerWidgets.clear();
		this._optionEmitters.clear();
		this._targetButtons = [];
	}

	private _clearExtensionPickers(): void {
		this._pickerWidgetDisposables.clear();
		this._pickerWidgets.clear();
		this._optionEmitters.clear();
		if (this._extensionPickersContainer) {
			dom.clearNode(this._extensionPickersContainer);
		}
	}

	// --- Send ---

	private _send(): void {
		const query = this._editor.getModel()?.getValue().trim();
		if (!query) {
			return;
		}

		const target = this._targetConfig.selectedTarget.get();
		if (!target) {
			this.logService.warn('ChatWelcomeWidget: No target selected, cannot create session');
			return;
		}

		const position = this._options.sessionPosition ?? ChatSessionPosition.Sidebar;
		const resource = this._pendingSessionResource
			?? getResourceForNewChatSession({ type: target, position, displayName: '' });

		const contribution = target !== AgentSessionProviders.Local
			? this.chatSessionsService.getChatSessionContribution(target)
			: undefined;

		const sendOptions: IChatSendRequestOptions = {
			location: ChatAgentLocation.Chat,
			userSelectedModelId: this._currentLanguageModel.get()?.identifier,
			modeInfo: {
				kind: ChatModeKind.Agent,
				isBuiltin: true,
				modeInstructions: undefined,
				modeId: 'agent',
				applyCodeBlockSuggestionId: undefined,
			},
			agentIdSilent: contribution?.type,
		};

		this._options.onSendRequest?.({
			resource,
			target,
			query,
			sendOptions,
			selectedOptions: new Map(this._selectedOptions),
		});
	}

	// --- Layout ---

	layout(_height: number, _width: number): void {
		this._editor?.layout();
	}

	setVisible(_visible: boolean): void {
		// no-op
	}

	focusInput(): void {
		this._editor?.focus();
	}
}

// #endregion

// #region --- New Chat View Pane ---

export const SessionsViewId = 'workbench.view.sessions.chat';

/**
 * A view pane that hosts the new-session welcome widget.
 */
export class NewChatViewPane extends ViewPane {

	private _widget: NewChatWidget | undefined;

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
		@ISessionsWorkbenchService private readonly activeSessionService: ISessionsWorkbenchService,
		@ILogService private readonly logService: ILogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this._widget = this._register(this.instantiationService.createInstance(
			NewChatWidget,
			{
				targetConfig: {
					allowedTargets: [AgentSessionProviders.Background, AgentSessionProviders.Cloud],
					defaultTarget: AgentSessionProviders.Background,
				},
				onSendRequest: (data) => {
					this.activeSessionService.openSessionAndSend(
						data.resource, data.query, data.sendOptions, data.selectedOptions
					).catch(e => this.logService.error('NewChatViewPane: Failed to open session and send request', e));
				},
			} satisfies INewChatWidgetOptions,
		));

		this._widget.render(container);
		this._widget.focusInput();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._widget?.layout(height, width);
	}

	override focus(): void {
		super.focus();
		this._widget?.focusInput();
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this._widget?.setVisible(visible);
	}
}

// #endregion

/**
 * Check whether an option group represents the model picker.
 * The convention is `id: 'models'` but extensions may use different IDs
 * per session type, so we also fall back to name matching.
 */
function isModelOptionGroup(group: IChatSessionProviderOptionGroup): boolean {
	if (group.id === 'models') {
		return true;
	}
	const nameLower = group.name.toLowerCase();
	return nameLower === 'model' || nameLower === 'models';
}
