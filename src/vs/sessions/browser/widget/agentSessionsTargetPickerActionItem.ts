/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../base/browser/dom.js';
import { renderLabelWithIcons } from '../../../base/browser/ui/iconLabel/iconLabels.js';
import { IAction } from '../../../base/common/actions.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { MenuItemAction } from '../../../platform/actions/common/actions.js';
import { IActionWidgetService } from '../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction, IActionWidgetDropdownActionProvider, IActionWidgetDropdownOptions } from '../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { IActionProvider } from '../../../base/browser/ui/dropdown/dropdown.js';
import { AgentSessionProviders, getAgentSessionProviderDescription, getAgentSessionProviderIcon, resolveAgentSessionProviderName, isFirstPartyAgentSessionProvider } from '../../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';
import { ChatInputPickerActionViewItem, IChatInputPickerOptions } from '../../../workbench/contrib/chat/browser/widget/input/chatInputPickerActionItem.js';
import { IAgentChatTargetConfig } from './agentSessionsChatTargetConfig.js';
import { IChatSessionsService } from '../../../workbench/contrib/chat/common/chatSessionsService.js';

interface IAgentTargetItem {
	type: AgentSessionProviders;
	label: string;
	hoverDescription: string;
}

const firstPartyCategory = { label: localize('agentChat.targetCategory.agent', "Agent Types"), order: 1 };
const otherCategory = { label: localize('agentChat.targetCategory.other', "Other"), order: 2 };

/**
 * Target picker for the new agent chat widget.
 * Reads available targets from an `IAgentChatTargetConfig` rather than from `chatSessionsService`.
	 * Selection calls `targetConfig.setSelectedTarget()` - no session creation, no command execution.
 */
export class AgentSessionsTargetPickerActionItem extends ChatInputPickerActionViewItem {

	constructor(
		action: MenuItemAction,
		private readonly targetConfig: IAgentChatTargetConfig,
		pickerOptions: IChatInputPickerOptions,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		const actionProvider: IActionWidgetDropdownActionProvider = {
			getActions: () => {
				const currentType = targetConfig.selectedTarget.get();
				const allowed = targetConfig.allowedTargets.get();

				const actions: IActionWidgetDropdownAction[] = [];
				for (const type of allowed) {
					const item: IAgentTargetItem = {
						type,
						label: resolveAgentSessionProviderName(chatSessionsService, type),
						hoverDescription: getAgentSessionProviderDescription(type),
					};

					actions.push({
						...action,
						id: `agentChat.selectTarget.${type}`,
						label: item.label,
						checked: currentType === type,
						icon: getAgentSessionProviderIcon(type),
						enabled: true,
						category: isFirstPartyAgentSessionProvider(type) ? firstPartyCategory : otherCategory,
						tooltip: '',
						hover: { content: item.hoverDescription, position: pickerOptions.hoverPosition },
						run: async () => {
							targetConfig.setSelectedTarget(type);
							if (this.element) {
								this.renderLabel(this.element);
							}
						},
					});
				}

				return actions;
			}
		};

		const actionBarActionProvider: IActionProvider = {
			getActions: () => {
				return [this._getLearnMore()];
			}
		};

		const dropdownOptions: Omit<IActionWidgetDropdownOptions, 'label' | 'labelRenderer'> = {
			actionProvider,
			actionBarActionProvider,
			showItemKeybindings: true,
			reporter: { id: 'AgentChatTargetPicker', name: 'AgentChatTargetPicker', includeOptions: true },
		};

		super(action, dropdownOptions, pickerOptions, actionWidgetService, keybindingService, contextKeyService, telemetryService);

		// Re-render label when the selected target or allowed targets change
		this._register(this.targetConfig.onDidChangeSelectedTarget(() => {
			if (this.element) {
				this.renderLabel(this.element);
			}
		}));

		this._register(this.targetConfig.onDidChangeAllowedTargets(() => {
			if (this.element) {
				this.renderLabel(this.element);
			}
		}));
	}

	private _getLearnMore(): IAction {
		const learnMoreUrl = 'https://code.visualstudio.com/docs/copilot/agents/overview';
		return {
			id: 'workbench.action.chat.agentOverview.learnMore',
			label: localize('agentChat.learnMoreAgentTypes', "Learn about agent types..."),
			tooltip: learnMoreUrl,
			class: undefined,
			enabled: true,
			run: async () => {
				await this.openerService.open(URI.parse(learnMoreUrl));
			}
		};
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		this.setAriaLabelAttributes(element);
		const currentType = this.targetConfig.selectedTarget.get() ?? AgentSessionProviders.Local;

		const label = resolveAgentSessionProviderName(this.chatSessionsService, currentType);
		const icon = getAgentSessionProviderIcon(currentType);

		const labelElements = [];
		labelElements.push(...renderLabelWithIcons(`$(${icon.id})`));
		if (currentType !== AgentSessionProviders.Local || !this.pickerOptions.onlyShowIconsForDefaultActions.get()) {
			labelElements.push(dom.$('span.chat-input-picker-label', undefined, label));
		}
		labelElements.push(...renderLabelWithIcons(`$(chevron-down)`));

		dom.reset(element, ...labelElements);

		return null;
	}
}
