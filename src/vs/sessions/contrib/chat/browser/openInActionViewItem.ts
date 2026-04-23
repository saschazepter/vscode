/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, append, EventType, $, isHTMLElement } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { ActionViewItem, BaseActionViewItem, IActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Action, IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ActionWidgetDropdownActionViewItem } from '../../../../platform/actions/browser/actionWidgetDropdownActionViewItem.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { IActionWidgetDropdownAction } from '../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { VSCODE_STABLE_ICON_URI } from './openInIcons.js';

/**
 * Split-button action view item for the sessions titlebar "Open In" control.
 */
export class OpenInActionViewItem extends BaseActionViewItem {

	private readonly _primaryAction: ActionViewItem;
	private readonly _dropdown: ChevronActionWidgetDropdown;
	constructor(
		action: IAction,
		_options: IActionViewItemOptions,
		runPrimaryAction: () => Promise<void>,
		getDropdownActions: () => IActionWidgetDropdownAction[],
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super(undefined, action);

		const primaryAction = this._register(new Action(
			'agentSessions.openInPrimary',
			localize('openIn', "Open In"),
			ThemeIcon.asClassName(Codicon.vscodeInsiders),
			true,
			runPrimaryAction,
		));
		this._primaryAction = this._register(new ActionViewItem(undefined, primaryAction, { icon: true, label: false }));

		const dropdownAction = this._register(new Action('agentSessions.openInDropdown', localize('openInMoreActions', "More Open In Actions")));
		this._dropdown = this._register(new ChevronActionWidgetDropdown(
			dropdownAction,
			{
				actionProvider: { getActions: getDropdownActions },
				showItemKeybindings: false,
			},
			actionWidgetService,
			keybindingService,
			contextKeyService,
			telemetryService,
		));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('monaco-dropdown-with-default');

		const primaryContainer = $('.action-container');
		this._primaryAction.render(append(container, primaryContainer));
		const primaryLabel = primaryContainer.firstElementChild;
		if (isHTMLElement(primaryLabel)) {
			primaryLabel.classList.add('sessions-open-in-primary');
		}
		// Replace codicon ::before with a full-color product icon <img>
		if (isHTMLElement(primaryLabel)) {
			const hasImg = Array.from(primaryLabel.children).some(child => isHTMLElement(child) && child.classList.contains('sessions-open-in-icon'));
			if (!hasImg) {
				const img = document.createElement('img');
				img.className = 'sessions-open-in-icon';
				img.src = VSCODE_STABLE_ICON_URI.toString(true);
				img.style.width = '16px';
				img.style.height = '16px';
				primaryLabel.prepend(img);
			}
		}
		const hasOpenInLabel = isHTMLElement(primaryLabel) && Array.from(primaryLabel.children).some(child => isHTMLElement(child) && child.classList.contains('sessions-open-in-label'));
		if (isHTMLElement(primaryLabel) && !hasOpenInLabel) {
			append(primaryLabel, $('span.sessions-open-in-label', undefined, localize('openIn', "Open In")));
		}
		this._register(addDisposableListener(primaryContainer, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.RightArrow)) {
				this._primaryAction.blur();
				this._dropdown.focus();
				event.stopPropagation();
			}
		}));

		const dropdownContainer = $('.dropdown-action-container');
		this._dropdown.render(append(container, dropdownContainer));
		this._register(addDisposableListener(dropdownContainer, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.LeftArrow)) {
				this._dropdown.setFocusable(false);
				this._primaryAction.focus();
				event.stopPropagation();
			}
		}));
	}

	override focus(fromRight?: boolean): void {
		if (fromRight) {
			this._dropdown.focus();
		} else {
			this._primaryAction.focus();
		}
	}

	override blur(): void {
		this._primaryAction.blur();
		this._dropdown.blur();
	}

	override setFocusable(focusable: boolean): void {
		this._primaryAction.setFocusable(focusable);
		if (!focusable) {
			this._dropdown.setFocusable(false);
		}
	}
}

class ChevronActionWidgetDropdown extends ActionWidgetDropdownActionViewItem {
	protected override renderLabel(element: HTMLElement): IDisposable | null {
		element.classList.add('codicon', 'codicon-chevron-down');
		return null;
	}
}
