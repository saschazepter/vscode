/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../base/browser/dom.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../workbench/common/views.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { ViewPane, IViewPaneOptions } from '../../../workbench/browser/parts/views/viewPane.js';
import { SdkChatWidget } from './sdkChatWidget.js';
import { CloudTaskWidget } from './cloudTaskWidget.js';
import { type ISessionListItem, SessionListItemKind } from '../../common/sessionListItem.js';

export const SdkChatViewId = 'workbench.panel.chat.view.sdkChat';

export class SdkChatViewPane extends ViewPane {

	private _widget: SdkChatWidget | undefined;
	private _cloudTaskWidget: CloudTaskWidget | undefined;
	private _sdkContainer: HTMLElement | undefined;
	private _cloudTaskContainer: HTMLElement | undefined;

	get widget(): SdkChatWidget | undefined {
		return this._widget;
	}

	get cloudTaskWidget(): CloudTaskWidget | undefined {
		return this._cloudTaskWidget;
	}

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
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService,
		);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		// SDK chat widget container
		this._sdkContainer = append(container, $('.sdk-chat-view-pane-container'));
		this._sdkContainer.style.height = '100%';
		this._widget = this._register(this.instantiationService.createInstance(SdkChatWidget, this._sdkContainer));

		// When the SDK widget creates a cloud task, switch to the cloud task view
		this._register(this._widget.onDidCreateCloudTask(item => {
			this.showItem(item);
		}));

		// Cloud task widget container (hidden by default)
		this._cloudTaskContainer = append(container, $('.cloud-task-view-pane-container'));
		this._cloudTaskContainer.style.height = '100%';
		this._cloudTaskContainer.style.display = 'none';
		this._cloudTaskWidget = this._register(this.instantiationService.createInstance(CloudTaskWidget, this._cloudTaskContainer));
	}

	/**
	 * Show the appropriate detail widget for the given item.
	 */
	showItem(item: ISessionListItem): void {
		if (item.kind === SessionListItemKind.SdkSession) {
			this._showWidget(this._sdkContainer, this._cloudTaskContainer);
			this._widget?.load(item);
		} else {
			this._showWidget(this._cloudTaskContainer, this._sdkContainer);
			this._cloudTaskWidget?.load(item);
		}
	}

	/**
	 * Switch back to the SDK chat view in its empty/welcome state.
	 */
	showEmpty(): void {
		this._showWidget(this._sdkContainer, this._cloudTaskContainer);
		this._widget?.clear();
	}

	override focus(): void {
		super.focus();
		this._widget?.focus();
	}

	private _showWidget(show: HTMLElement | undefined, hide: HTMLElement | undefined): void {
		if (show) { show.style.display = ''; }
		if (hide) { hide.style.display = 'none'; }
	}
}
