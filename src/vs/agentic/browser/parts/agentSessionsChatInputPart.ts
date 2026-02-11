/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { MenuId } from '../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { AgentSessionProviders } from '../../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';
import { IChatWidget, ISessionTypePickerDelegate, IWorkspacePickerDelegate } from '../../../workbench/contrib/chat/browser/chat.js';
import { ChatInputPart, IChatInputPartOptions, IChatInputStyles } from '../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { IChatMode } from '../../../workbench/contrib/chat/common/chatModes.js';
import { ChatAgentLocation, ChatModeKind } from '../../../workbench/contrib/chat/common/constants.js';
import { IAgentChatTargetConfig } from '../widget/agentSessionsChatTargetConfig.js';


/**
 * Options for the AgentChatInputPart.
 * Replaces `ISessionTypePickerDelegate` with `IAgentChatTargetConfig`.
 */
export interface IAgentChatInputPartOptions {
	targetConfig: IAgentChatTargetConfig;
	defaultMode?: IChatMode;
	renderFollowups: boolean;
	renderStyle?: 'compact';
	renderInputToolbarBelowInput: boolean;
	menus: {
		executeToolbar: MenuId;
		telemetrySource: string;
		inputSideToolbar?: MenuId;
	};
	editorOverflowWidgetsDomNode?: HTMLElement;
	renderWorkingSet: boolean;
	enableImplicitContext?: boolean;
	supportsChangingModes?: boolean;
	dndContainer?: HTMLElement;
	widgetViewKindTag: string;
	workspacePickerDelegate?: IWorkspacePickerDelegate;

	/**
	 * Set of picker action IDs to hide from the input toolbar.
	 * Pickers in this set are rendered externally (e.g. in the welcome view).
	 */
	hiddenPickerIds?: ReadonlySet<string>;
}

/**
 * Creates a bridge delegate that connects `IAgentChatTargetConfig` to the
 * existing `ISessionTypePickerDelegate` interface used by `ChatInputPart`.
 *
 * This allows the existing ChatInputPart to work with the new target config
 * system without any modifications. The delegate:
 * - Reports the target config's selected target as the "active session provider"
 * - Provides a setter that updates the target config (no session creation)
 * - Fires events when the target changes
 */
function createTargetConfigDelegate(targetConfig: IAgentChatTargetConfig, disposables: DisposableStore): ISessionTypePickerDelegate {
	// Bridge the onDidChangeSelectedTarget event to only fire for non-undefined targets.
	// The delegate interface expects Event<AgentSessionProviders> (not undefined).
	const onDidChangeEmitter = disposables.add(new Emitter<AgentSessionProviders>());
	disposables.add(targetConfig.onDidChangeSelectedTarget((target: AgentSessionProviders | undefined) => {
		if (target !== undefined) {
			onDidChangeEmitter.fire(target);
		}
	}));

	return {
		getActiveSessionProvider: () => targetConfig.selectedTarget.get(),
		setActiveSessionProvider: (provider: AgentSessionProviders) => {
			targetConfig.setSelectedTarget(provider);
		},
		onDidChangeActiveSessionProvider: onDidChangeEmitter.event,
	};
}

/**
 * Adapter around `ChatInputPart` that integrates with `IAgentChatTargetConfig`
 * for target management.
 *
 * This replaces the delegate-based target selection pattern with a clean
 * target configuration system. The underlying ChatInputPart operates through
 * a bridge delegate that maps target config operations to the existing
 * delegate interface.
 *
 * Key differences from using ChatInputPart directly:
 * - Target selection is driven by `IAgentChatTargetConfig` (observable, restrictable)
 * - No session/resource is required to function
 * - Target changes do not trigger session creation
 * - Option groups are derived from the selected target type
 */
export class AgentSessionsChatInputPart extends Disposable {

	private readonly _inputPart: ChatInputPart;
	private readonly _targetConfig: IAgentChatTargetConfig;
	private readonly _bridgeDisposables = this._register(new DisposableStore());

	/**
	 * The underlying ChatInputPart instance.
	 * Consumers can access this for operations that don't involve target management
	 * (e.g., getting input text, managing attachments, etc.)
	 */
	get inputPart(): ChatInputPart {
		return this._inputPart;
	}

	get targetConfig(): IAgentChatTargetConfig {
		return this._targetConfig;
	}

	constructor(
		location: ChatAgentLocation,
		options: IAgentChatInputPartOptions,
		styles: IChatInputStyles,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this._targetConfig = options.targetConfig;

		// Create bridge delegate
		const delegate = createTargetConfigDelegate(this._targetConfig, this._bridgeDisposables);

		// Convert to ChatInputPart options
		const inputPartOptions: IChatInputPartOptions = {
			defaultMode: options.defaultMode,
			renderFollowups: options.renderFollowups,
			renderStyle: options.renderStyle,
			renderInputToolbarBelowInput: options.renderInputToolbarBelowInput,
			menus: options.menus,
			editorOverflowWidgetsDomNode: options.editorOverflowWidgetsDomNode,
			renderWorkingSet: options.renderWorkingSet,
			enableImplicitContext: options.enableImplicitContext,
			supportsChangingModes: options.supportsChangingModes,
			dndContainer: options.dndContainer,
			widgetViewKindTag: options.widgetViewKindTag,
			sessionTypePickerDelegate: delegate,
			workspacePickerDelegate: options.workspacePickerDelegate,
			hiddenPickerIds: options.hiddenPickerIds,
		};

		this._inputPart = this._register(instantiationService.createInstance(
			ChatInputPart,
			location,
			inputPartOptions,
			styles,
			false // not inline
		));
	}

	// Proxy common ChatInputPart properties and methods

	get onDidFocus(): Event<void> { return this._inputPart.onDidFocus; }
	get onDidBlur(): Event<void> { return this._inputPart.onDidBlur; }
	get onDidLoadInputState(): Event<void> { return this._inputPart.onDidLoadInputState; }
	get onDidAcceptFollowup() { return this._inputPart.onDidAcceptFollowup; }
	get onDidChangeContext() { return this._inputPart.onDidChangeContext; }
	get onDidClickOverlay() { return this._inputPart.onDidClickOverlay; }

	get attachmentModel() { return this._inputPart.attachmentModel; }
	get currentLanguageModel() { return this._inputPart.currentLanguageModel; }
	get currentModeObs() { return this._inputPart.currentModeObs; }
	get currentModeKind() { return this._inputPart.currentModeKind; }
	get height() { return this._inputPart.height; }
	get inputEditor() { return this._inputPart.inputEditor; }

	/**
	 * The selected target that will be used when the user sends a message.
	 * Unlike the original ChatInputPart, this is always "pending" since
	 * no session exists until send.
	 */
	get selectedTarget(): AgentSessionProviders | undefined {
		return this._targetConfig.selectedTarget.get();
	}

	render(container: HTMLElement, initialValue: string, widget: IChatWidget): void {
		this._inputPart.render(container, initialValue, widget);
	}

	layout(width: number): void {
		this._inputPart.layout(width);
	}

	setVisible(visible: boolean): void {
		this._inputPart.setVisible(visible);
	}

	focus(): void {
		this._inputPart.focus();
	}

	acceptInput(isUserQuery?: boolean): void {
		this._inputPart.acceptInput(isUserQuery);
	}

	setValue(value: string, transient: boolean): void {
		this._inputPart.setValue(value, transient);
	}

	setChatMode(mode: ChatModeKind | string, storeSelection?: boolean): void {
		this._inputPart.setChatMode(mode, storeSelection);
	}
}
