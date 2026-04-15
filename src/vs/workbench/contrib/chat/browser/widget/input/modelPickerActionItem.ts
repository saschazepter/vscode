/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveWindow } from '../../../../../../base/browser/dom.js';
import { IManagedHoverContent } from '../../../../../../base/browser/ui/hover/hover.js';
import { getBaseLayerHoverDelegate } from '../../../../../../base/browser/ui/hover/hoverDelegate2.js';
import { getDefaultHoverDelegate } from '../../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { BaseActionViewItem } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../../../base/common/actions.js';
import { MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun, IObservable } from '../../../../../../base/common/observable.js';
import { localize } from '../../../../../../nls.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../../platform/keybinding/common/keybinding.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { TelemetryTrustedValue } from '../../../../../../platform/telemetry/common/telemetryUtils.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IActionProvider } from '../../../../../../base/browser/ui/dropdown/dropdown.js';
import { IActionWidgetDropdownAction, IActionWidgetDropdownActionProvider } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { ChatEntitlement, IChatEntitlementService } from '../../../../../services/chat/common/chatEntitlementService.js';
import { MANAGE_CHAT_COMMAND_ID } from '../../../common/constants.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../common/languageModels.js';
import { DEFAULT_MODEL_PICKER_CATEGORY } from '../../../common/widget/input/modelPickerWidget.js';
import { IChatInputPickerOptions } from './chatInputPickerActionItem.js';
import { getModelHoverContent, ModelPickerWidget } from './chatModelPicker.js';

export interface IModelPickerDelegate {
	readonly currentModel: IObservable<ILanguageModelChatMetadataAndIdentifier | undefined>;
	setModel(model: ILanguageModelChatMetadataAndIdentifier): void;
	getModels(): ILanguageModelChatMetadataAndIdentifier[];
	useGroupedModelPicker(): boolean;
	showManageModelsAction(): boolean;
	showUnavailableFeatured(): boolean;
	showFeatured(): boolean;
}

type ChatModelChangeClassification = {
	owner: 'lramos15';
	comment: 'Reporting when the model picker is switched';
	fromModel?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The previous chat model' };
	toModel: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The new chat model' };
};

type ChatModelChangeEvent = {
	fromModel: string | TelemetryTrustedValue<string> | undefined;
	toModel: string | TelemetryTrustedValue<string>;
};


function modelDelegateToWidgetActionsProvider(delegate: IModelPickerDelegate, telemetryService: ITelemetryService, pickerOptions: IChatInputPickerOptions, languageModelsService?: ILanguageModelsService): IActionWidgetDropdownActionProvider {
	return {
		getActions: () => {
			const models = delegate.getModels();
			if (models.length === 0) {
				// Show a fake "Auto" entry when no models are available
				return [{
					id: 'auto',
					enabled: true,
					checked: true,
					category: DEFAULT_MODEL_PICKER_CATEGORY,
					class: undefined,
					tooltip: localize('chat.modelPicker.auto', "Auto"),
					label: localize('chat.modelPicker.auto', "Auto"),
					hover: { content: localize('chat.modelPicker.auto.description', "Automatically selects the best model for your task based on capacity."), position: pickerOptions.hoverPosition },
					run: () => { }
				} satisfies IActionWidgetDropdownAction];
			}
			return models.map(model => {
				const isAuto = model.metadata.id === 'auto' && model.metadata.vendor === 'copilot';
				const selectThisModel = () => {
					if (model.identifier !== delegate.currentModel.get()?.identifier) {
						const previousModel = delegate.currentModel.get();
						telemetryService.publicLog2<ChatModelChangeEvent, ChatModelChangeClassification>('chat.modelChange', {
							fromModel: previousModel?.metadata.vendor === 'copilot' ? new TelemetryTrustedValue(previousModel.identifier) : 'unknown',
							toModel: model.metadata.vendor === 'copilot' ? new TelemetryTrustedValue(model.identifier) : 'unknown'
						});
						delegate.setModel(model);
					}
				};
				const hoverMarkdown = getModelHoverContent(model, languageModelsService, undefined, selectThisModel);
				return {
					id: model.metadata.id,
					enabled: true,
					icon: model.metadata.statusIcon,
					checked: model.identifier === delegate.currentModel.get()?.identifier,
					category: model.metadata.modelPickerCategory || DEFAULT_MODEL_PICKER_CATEGORY,
					class: undefined,
					description: isAuto ? undefined : model.metadata.detail,
					tooltip: '',
					hover: { content: hoverMarkdown, position: pickerOptions.hoverPosition },
					label: model.metadata.name,
					run: () => {
						const previousModel = delegate.currentModel.get();
						telemetryService.publicLog2<ChatModelChangeEvent, ChatModelChangeClassification>('chat.modelChange', {
							fromModel: previousModel?.metadata.vendor === 'copilot' ? new TelemetryTrustedValue(previousModel.identifier) : 'unknown',
							toModel: model.metadata.vendor === 'copilot' ? new TelemetryTrustedValue(model.identifier) : 'unknown'
						});
						delegate.setModel(model);
					}
				} satisfies IActionWidgetDropdownAction;
			});
		}
	};
}

function getModelPickerActionBarActionProvider(commandService: ICommandService, chatEntitlementService: IChatEntitlementService, productService: IProductService): IActionProvider {

	const actionProvider: IActionProvider = {
		getActions: () => {
			const additionalActions: IAction[] = [];
			if (
				chatEntitlementService.entitlement === ChatEntitlement.Free ||
				chatEntitlementService.entitlement === ChatEntitlement.EDU ||
				chatEntitlementService.entitlement === ChatEntitlement.Pro ||
				chatEntitlementService.entitlement === ChatEntitlement.ProPlus ||
				chatEntitlementService.entitlement === ChatEntitlement.Business ||
				chatEntitlementService.entitlement === ChatEntitlement.Enterprise ||
				chatEntitlementService.isInternal
			) {
				additionalActions.push({
					id: 'manageModels',
					label: localize('chat.manageModels', "Manage Models..."),
					enabled: true,
					tooltip: localize('chat.manageModels.tooltip', "Manage Language Models"),
					class: undefined,
					run: () => {
						commandService.executeCommand(MANAGE_CHAT_COMMAND_ID);
					}
				});
			}

			// Add sign-in / upgrade option if entitlement is anonymous / free / new user
			const isNewOrAnonymousUser = !chatEntitlementService.sentiment.completed ||
				chatEntitlementService.entitlement === ChatEntitlement.Available ||
				chatEntitlementService.anonymous ||
				chatEntitlementService.entitlement === ChatEntitlement.Unknown;
			if (isNewOrAnonymousUser || chatEntitlementService.entitlement === ChatEntitlement.Free) {
				additionalActions.push({
					id: 'moreModels',
					label: isNewOrAnonymousUser ? localize('chat.moreModels', "Add Language Models") : localize('chat.morePremiumModels', "Add Premium Models"),
					enabled: true,
					tooltip: isNewOrAnonymousUser ? localize('chat.moreModels.tooltip', "Add Language Models") : localize('chat.morePremiumModels.tooltip', "Add Premium Models"),
					class: undefined,
					run: () => {
						const commandId = isNewOrAnonymousUser ? 'workbench.action.chat.triggerSetup' : 'workbench.action.chat.upgradePlan';
						commandService.executeCommand(commandId);
					}
				});
			}

			return additionalActions;
		}
	};
	return actionProvider;
}

/**
 * Action view item for selecting a language model in the chat interface.
 *
 * Wraps a {@link ModelPickerWidget} and adapts it for use in an action bar,
 * providing curated model suggestions, upgrade prompts, and grouped layout.
 */
export class ModelPickerActionItem extends BaseActionViewItem {
	private readonly _pickerWidget: ModelPickerWidget;
	private readonly _managedHover = this._register(new MutableDisposable());

	constructor(
		action: IAction,
		delegate: IModelPickerDelegate,
		private readonly pickerOptions: IChatInputPickerOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super(undefined, action);

		this._pickerWidget = this._register(instantiationService.createInstance(ModelPickerWidget, delegate));
		this._pickerWidget.setSelectedModel(delegate.currentModel.get());
		this._pickerWidget.setHideChevrons(pickerOptions.hideChevrons);

		// Sync delegate → widget when model list or selection changes externally
		this._register(autorun(t => {
			const model = delegate.currentModel.read(t);
			this._pickerWidget.setSelectedModel(model);
			this._updateTooltip();
		}));

		// Sync widget → delegate when user picks a model
		this._register(this._pickerWidget.onDidChangeSelection(model => delegate.setModel(model)));
	}

	override render(container: HTMLElement): void {
		this._pickerWidget.render(container);
		this.element = this._pickerWidget.domNode;
		this._updateTooltip();
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

	public setEnabled(enabled: boolean): void {
		this._pickerWidget.setEnabled(enabled);
	}

	private _showPicker(): void {
		this._pickerWidget.show(this._getAnchorElement());
	}

	private _updateTooltip(): void {
		if (!this.element) {
			return;
		}
		const hoverContent = this._getHoverContents();
		if (typeof hoverContent === 'string' && hoverContent) {
			this._managedHover.value = getBaseLayerHoverDelegate().setupManagedHover(
				getDefaultHoverDelegate('mouse'),
				this.element,
				hoverContent
			);
		} else {
			this._managedHover.clear();
		}
	}

	private _getHoverContents(): IManagedHoverContent | undefined {
		let label = localize('chat.modelPicker.label', "Pick Model");
		const keybindingLabel = this.keybindingService.lookupKeybinding(this._action.id, this._contextKeyService)?.getLabel();
		if (keybindingLabel) {
			label += ` (${keybindingLabel})`;
		}
		const { statusIcon, tooltip } = this._pickerWidget.selectedModel?.metadata || {};
		return statusIcon && tooltip ? `${label} • ${tooltip}` : label;
	}
}
