/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatFullWelcomePart.css';
import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IAgentSessionsService } from '../agentSessions/agentSessionsService.js';
import { AgentSessionsControl } from '../agentSessions/agentSessionsControl.js';
import { IChatFullWelcomeOptions } from '../chat.js';
import { IChatSessionProviderOptionItem } from '../../common/chatSessionsService.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../common/languageModels.js';

const MAX_SESSIONS = 6;

export interface IChatFullWelcomePartOptions {
	/**
	 * The product name to display in the header.
	 */
	readonly productName: string;

	/**
	 * Configuration options from the widget.
	 */
	readonly fullWelcomeOptions?: IChatFullWelcomeOptions;
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
	// UI elements
	private configToolbar: HTMLElement | undefined;
	private collapsedModeButton: HTMLElement | undefined;

	// Picker widgets
	private readonly _currentLanguageModel = observableValue<ILanguageModelChatMetadataAndIdentifier | undefined>('currentLanguageModel', undefined);
	private readonly _selectedOptions = new Map<string, IChatSessionProviderOptionItem>();
	// For welcome view, always show full labels (not compact mode)

	constructor(
		private readonly options: IChatFullWelcomePartOptions,
		@IProductService private readonly productService: IProductService,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
	) {
		super();

		this.element = $('.chat-full-welcome');
		this.inputSlot = $('.chat-full-welcome-inputSlot');
		this.buildContent();
	}

	private buildContent(): void {
		this.contentDisposables.clear();
		this.sessionsControlDisposables.clear();
		this.sessionsControl = undefined;
		clearNode(this.element);

		// Header with product name
		const header = append(this.element, $('.chat-full-welcome-header'));
		append(header, $('h1.product-name', {}, this.options.productName || this.productService.nameShort));

		// Configuration toolbar (shows collapsed mode icon + separator + pickers)
		// Initially hidden until a mode is selected and collapsed
		this.configToolbar = append(this.element, $('.chat-full-welcome-config-toolbar'));
		this.configToolbar.style.display = 'none';

		// Collapsed mode button (icon only) - will be populated when a mode is selected
		this.collapsedModeButton = append(this.configToolbar, $('button.chat-full-welcome-collapsed-mode-button'));
		this.collapsedModeButton.setAttribute('type', 'button');

		// Input slot - ChatWidget will insert the input part here
		append(this.element, this.inputSlot);
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
