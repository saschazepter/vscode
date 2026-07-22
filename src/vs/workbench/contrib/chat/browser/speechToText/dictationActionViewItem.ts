/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, getWindow } from '../../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';
import { IAction, Separator, toAction } from '../../../../../base/common/actions.js';
import { localize } from '../../../../../nls.js';
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

/** Setting that enables the dictation feature; toggled off by "Disable Dictation". */
const ENABLED_SETTING = 'chat.speechToText.enabled';
/** Command that opens the microphone picker shared with Voice Mode. */
const SELECT_MICROPHONE_COMMAND = 'workbench.action.chat.selectSpeechToTextMicrophone';

/**
 * Action view item for the chat-input dictation mic button. Behaves like a
 * normal toolbar mic (click to dictate) but adds a right-click context menu with
 * dictation-specific entries — "Configure Keybinding" (mirroring the standard
 * toolbar affordance), "Select Microphone" and "Disable Dictation" — instead of
 * the generic toolbar context menu.
 */
export class DictationActionViewItem extends MenuEntryActionViewItem {

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
			// handler so we show our dictation-specific menu instead.
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
			new Separator(),
			toAction({
				id: SELECT_MICROPHONE_COMMAND,
				label: localize('dictation.selectMicrophone', "Select Microphone"),
				run: () => this._commandService.executeCommand(SELECT_MICROPHONE_COMMAND),
			}),
			toAction({
				id: 'chat.dictation.disable',
				label: localize('dictation.disable', "Disable Dictation"),
				run: () => this._configurationService.updateValue(ENABLED_SETTING, false),
			}),
		];

		this._contextMenuService.showContextMenu({
			getAnchor: () => event,
			getActions: () => actions,
		});
	}
}
