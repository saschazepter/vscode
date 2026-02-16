/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../../base/browser/keyboardEvent.js';
import { BaseActionViewItem } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getActiveWindow } from '../../../../../../base/browser/dom.js';
import { IManagedHoverContent } from '../../../../../../base/browser/ui/hover/hover.js';
import { getBaseLayerHoverDelegate } from '../../../../../../base/browser/ui/hover/hoverDelegate2.js';
import { getDefaultHoverDelegate } from '../../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { renderIcon, renderLabelWithIcons } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IAction } from '../../../../../../base/common/actions.js';
import { KeyCode } from '../../../../../../base/common/keyCodes.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun, IObservable } from '../../../../../../base/common/observable.js';
import { localize } from '../../../../../../nls.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../common/languageModels.js';
import { IChatInputPickerOptions } from './chatInputPickerActionItem.js';
import { buildModelPickerItems, getModelPickerListOptions } from './chatModelPicker.js';

export interface IModelPickerDelegate {
	readonly currentModel: IObservable<ILanguageModelChatMetadataAndIdentifier | undefined>;
	setModel(model: ILanguageModelChatMetadataAndIdentifier): void;
	getModels(): ILanguageModelChatMetadataAndIdentifier[];
}

/**
 * Action view item for selecting a language model in the chat interface.
 *
 * Renders as a button showing the current model name. On click, opens the
 * ActionWidget directly with grouped sections:
 * Auto → Recently Used → Curated → Other Models (collapsed with search).
 *
 * Extends BaseActionViewItem directly (instead of ActionWidgetDropdownActionViewItem)
 * because we need full control over item construction - the standard
 * ActionWidgetDropdown groups items by category, but we build pre-structured
 * IActionListItems with headers, separators and collapsible sections.
 */
export class ModelPickerActionItem extends BaseActionViewItem {
	private currentModel: ILanguageModelChatMetadataAndIdentifier | undefined;

	constructor(
		action: IAction,
		private readonly _delegate: IModelPickerDelegate,
		private readonly pickerOptions: IChatInputPickerOptions,
		@IActionWidgetService private readonly actionWidgetService: IActionWidgetService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@ICommandService private readonly commandService: ICommandService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
	) {
		super(undefined, action);
		this.currentModel = _delegate.currentModel.get();

		// Listen for model changes from the delegate
		this._register(autorun(t => {
			const model = _delegate.currentModel.read(t);
			this.currentModel = model;
			this._updateTooltip();
			if (this.element) {
				this._renderLabel(this.element);
			}
		}));
	}

	override render(container: HTMLElement): void {
		this.element = dom.append(container, dom.$('a.action-label'));
		this.element.tabIndex = 0;
		this.element.setAttribute('role', 'button');
		this.element.setAttribute('aria-haspopup', 'true');
		this.element.setAttribute('aria-expanded', 'false');

		this._renderLabel(this.element);
		this._updateTooltip();

		// Open picker on click
		this._register(dom.addDisposableListener(this.element, dom.EventType.MOUSE_DOWN, (e) => {
			if (e.button !== 0) {
				return; // only left click
			}
			dom.EventHelper.stop(e, true);
			this._showPicker();
		}));

		// Open picker on Enter/Space
		this._register(dom.addDisposableListener(this.element, dom.EventType.KEY_DOWN, (e) => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				dom.EventHelper.stop(e, true);
				this._showPicker();
			}
		}));

		container.classList.add('chat-input-picker-item');
	}

	private _getAnchorElement(): HTMLElement {
		if (this.element && getActiveWindow().document.contains(this.element)) {
			return this.element;
		}
		return this.pickerOptions.getOverflowAnchor?.() ?? this.element!;
	}

	public openModelPicker(): void {
		this._showPicker();
	}

	public show(): void {
		this._showPicker();
	}

	private _showPicker(): void {
		const items = buildModelPickerItems(
			this._delegate,
			this.languageModelsService,
			this.telemetryService,
			this.commandService,
		);

		const listOptions = getModelPickerListOptions();
		const previouslyFocusedElement = dom.getActiveElement();

		const delegate = {
			onSelect: (action: IActionWidgetDropdownAction) => {
				this.actionWidgetService.hide();
				action.run();
			},
			onHide: () => {
				this.element?.setAttribute('aria-expanded', 'false');
				if (dom.isHTMLElement(previouslyFocusedElement)) {
					previouslyFocusedElement.focus();
				}
			}
		};

		this.element?.setAttribute('aria-expanded', 'true');

		this.actionWidgetService.show(
			'ChatModelPicker',
			false,
			items,
			delegate,
			this._getAnchorElement(),
			undefined,
			[],
			{
				isChecked(element) {
					return element.kind === 'action' && !!element?.item?.checked;
				},
				getRole: (e) => {
					switch (e.kind) {
						case 'action': return 'menuitemcheckbox';
						case 'separator': return 'separator';
						default: return 'separator';
					}
				},
				getWidgetRole: () => 'menu',
			},
			listOptions
		);
	}

	private _renderLabel(element: HTMLElement): IDisposable | null {
		const { name, statusIcon } = this.currentModel?.metadata || {};
		const domChildren = [];

		if (statusIcon) {
			const iconElement = renderIcon(statusIcon);
			domChildren.push(iconElement);
		}

		domChildren.push(dom.$('span.chat-input-picker-label', undefined, name ?? localize('chat.modelPicker.auto', "Auto")));
		domChildren.push(...renderLabelWithIcons(`$(chevron-down)`));

		dom.reset(element, ...domChildren);

		// Aria
		const modelName = this.currentModel?.metadata.name ?? localize('chat.modelPicker.auto', "Auto");
		element.ariaLabel = localize('chat.modelPicker.ariaLabel', "Pick Model, {0}", modelName);
		return null;
	}

	private _updateTooltip(): void {
		if (!this.element) {
			return;
		}
		const hoverContent = this._getHoverContents();
		if (typeof hoverContent === 'string' && hoverContent) {
			this._register(getBaseLayerHoverDelegate().setupManagedHover(
				getDefaultHoverDelegate('mouse'),
				this.element,
				hoverContent
			));
		}
	}

	private _getHoverContents(): IManagedHoverContent | undefined {
		let label = localize('chat.modelPicker.label', "Pick Model");
		const keybindingLabel = this.keybindingService.lookupKeybinding(this._action.id, this._contextKeyService)?.getLabel();
		if (keybindingLabel) {
			label += ` (${keybindingLabel})`;
		}
		const { statusIcon, tooltip } = this.currentModel?.metadata || {};
		return statusIcon && tooltip ? `${label} • ${tooltip}` : label;
	}
}
