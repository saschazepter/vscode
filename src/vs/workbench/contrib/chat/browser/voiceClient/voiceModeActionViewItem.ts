/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, getWindow } from '../../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';
import { IAction } from '../../../../../base/common/actions.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { MenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { createConfigureKeybindingAction } from '../../../../../platform/actions/common/menuService.js';
import { IMenuEntryActionViewItemOptions, MenuEntryActionViewItem } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { createDisableVoiceModeAction, createSelectMicrophoneAction } from '../speechToText/micButtonMenuActions.js';

/**
 * Action view item for the chat-input Voice Mode button. Behaves like the normal
 * toolbar voice-mode toggle (click to start/stop) but adds a right-click context
 * menu with voice-specific entries — "Configure Keybinding" (mirroring the
 * standard toolbar affordance), "Select Microphone" and "Disable Voice Mode" —
 * instead of the generic toolbar context menu. Mirrors {@link DictationActionViewItem}.
 */
export class VoiceModeActionViewItem extends MenuEntryActionViewItem {

	constructor(
		action: MenuItemAction,
		options: IMenuEntryActionViewItemOptions | undefined,
		@ICommandService private readonly _commandService: ICommandService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@INotificationService notificationService: INotificationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService themeService: IThemeService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IAccessibilityService accessibilityService: IAccessibilityService,
	) {
		super(action, options, keybindingService, notificationService, contextKeyService, themeService, contextMenuService, accessibilityService);
	}

	override render(container: HTMLElement): void {
		super.render(container);

		this._register(addDisposableListener(container, 'contextmenu', e => {
			// Stop the event before it reaches the toolbar's generic context-menu
			// handler so we show our voice-specific menu instead.
			e.preventDefault();
			e.stopPropagation();
			this._showContextMenu(new StandardMouseEvent(getWindow(container), e));
		}));
	}

	private _showContextMenu(event: StandardMouseEvent): void {
		const commandId = this._action.id;
		const supportsKeybindings = !!this._keybindingService.lookupKeybinding(commandId);

		const actions: IAction[] = [
			createConfigureKeybindingAction(this._commandService, this._keybindingService, commandId, undefined, supportsKeybindings),
			createSelectMicrophoneAction(this._commandService),
			createDisableVoiceModeAction(this._commandService, this._configurationService),
		];

		this._contextMenuService.showContextMenu({
			getAnchor: () => event,
			getActions: () => actions,
		});
	}
}
