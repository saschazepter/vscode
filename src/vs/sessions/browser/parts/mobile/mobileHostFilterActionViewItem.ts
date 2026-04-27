/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Gesture, EventType as TouchEventType } from '../../../../base/browser/touch.js';
import { renderLabelWithIcons } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { AgentHostFilterConnectionStatus, IAgentHostFilterService } from '../../../contrib/remoteAgentHost/common/agentHostFilter.js';
import { HostFilterActionViewItem } from '../../../contrib/remoteAgentHost/browser/hostFilterActionViewItem.js';
import './media/hostPickerDropdown.css';

/**
 * Mobile variant of {@link HostFilterActionViewItem}.
 *
 * Overrides the host picker to show a dropdown panel anchored below the
 * trigger element instead of the desktop context menu.
 */
export class MobileHostFilterActionViewItem extends HostFilterActionViewItem {

	private readonly _dropdown = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		action: IAction,
		@IAgentHostFilterService filterService: IAgentHostFilterService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IHoverService hoverService: IHoverService,
		@IThemeService private readonly _themeService: IThemeService,
	) {
		super(action, filterService, contextMenuService, hoverService);
	}

	protected override _showMenu(_e: MouseEvent | KeyboardEvent): void {
		if (!this.element) {
			return;
		}

		const hosts = this._filterService.hosts;
		if (hosts.length <= 1) {
			return;
		}

		this._showDropdown();
	}

	private _showDropdown(): void {
		this._dropdown.clear();

		const disposables = new DisposableStore();
		this._dropdown.value = disposables;

		const targetWindow = dom.getWindow(this.element);
		const targetDocument = targetWindow.document;
		const hosts = this._filterService.hosts;
		const selectedId = this._filterService.selectedProviderId;

		// Get current theme colors
		const theme = this._themeService.getColorTheme();
		const backgroundColor = theme.getColor('input-background')?.toString() || '#ffffff';
		const foregroundColor = theme.getColor('foreground')?.toString() || '#000000';
		const borderColor = theme.getColor('input-border')?.toString() || '#e0e0e0';
		const hoverBackgroundColor = theme.getColor('list-hoverBackground')?.toString() || '#f0f0f0';
		const linkColor = theme.getColor('textLink-foreground')?.toString() || '#0066cc';
		const descriptionColor = theme.getColor('descriptionForeground')?.toString() || '#999999';

		// --- Backdrop (transparent, dismiss on tap) ---
		const backdrop = targetDocument.createElement('div');
		backdrop.className = 'host-picker-dropdown-backdrop';
		disposables.add(dom.addDisposableListener(backdrop, dom.EventType.CLICK, () => dismiss()));
		disposables.add(Gesture.addTarget(backdrop));
		disposables.add(dom.addDisposableListener(backdrop, TouchEventType.Tap, () => dismiss()));

		// --- Dropdown panel anchored below trigger ---
		const panel = targetDocument.createElement('div');
		panel.className = 'host-picker-dropdown';
		panel.setAttribute('role', 'listbox');
		panel.setAttribute('aria-label', localize('agentHostFilter.dropdown.aria', "Select Agent Host"));
		panel.style.backgroundColor = backgroundColor;
		panel.style.borderColor = borderColor;

		// Prevent taps on the panel from dismissing
		disposables.add(dom.addDisposableListener(panel, dom.EventType.CLICK, e => e.stopPropagation()));
		disposables.add(Gesture.addTarget(panel));
		disposables.add(dom.addDisposableListener(panel, TouchEventType.Tap, e => dom.EventHelper.stop(e, true)));

		// Position below the trigger element
		const triggerRect = this.element!.getBoundingClientRect();
		const gap = 4;
		panel.style.top = `${triggerRect.bottom + gap}px`;
		panel.style.left = `${triggerRect.left}px`;
		panel.style.minWidth = `${Math.max(triggerRect.width, 200)}px`;

		for (const host of hosts) {
			const item = targetDocument.createElement('button');
			item.className = 'host-picker-dropdown-item';
			item.setAttribute('role', 'option');
			item.setAttribute('aria-selected', String(selectedId === host.providerId));
			item.style.color = foregroundColor;
			if (selectedId === host.providerId) {
				item.classList.add('selected');
				item.style.color = linkColor;
			}

			const iconSpan = targetDocument.createElement('span');
			iconSpan.className = 'host-picker-dropdown-item-icon';
			iconSpan.append(...renderLabelWithIcons(`$(${Codicon.remote.id})`));
			item.appendChild(iconSpan);

			const labelSpan = targetDocument.createElement('span');
			labelSpan.className = 'host-picker-dropdown-item-label';
			labelSpan.textContent = host.label;
			item.appendChild(labelSpan);

		if (host.status !== AgentHostFilterConnectionStatus.Connected) {
			const statusSpan = targetDocument.createElement('span');
			statusSpan.className = 'host-picker-dropdown-item-status';
			statusSpan.style.color = descriptionColor;
			statusSpan.textContent = host.status === AgentHostFilterConnectionStatus.Connecting
				? localize('agentHostFilter.dropdown.connecting', "connecting…")
				: localize('agentHostFilter.dropdown.disconnected', "disconnected");
			item.appendChild(statusSpan);
		}

		if (selectedId === host.providerId) {
			const checkSpan = targetDocument.createElement('span');
			checkSpan.className = 'host-picker-dropdown-item-check';
			checkSpan.style.color = linkColor;
			checkSpan.append(...renderLabelWithIcons(`$(${Codicon.check.id})`));
			item.appendChild(checkSpan);
		}

		disposables.add(Gesture.addTarget(item));
		const selectHost = () => {
			this._filterService.setSelectedProviderId(host.providerId);
			dismiss();
		};
		disposables.add(dom.addDisposableListener(item, dom.EventType.CLICK, selectHost));
		disposables.add(dom.addDisposableListener(item, TouchEventType.Tap, selectHost));

		// Set hover background via event listeners
		disposables.add(dom.addDisposableListener(item, dom.EventType.MOUSE_ENTER, () => {
			item.style.backgroundColor = hoverBackgroundColor;
		}));
		disposables.add(dom.addDisposableListener(item, dom.EventType.MOUSE_LEAVE, () => {
			item.style.backgroundColor = '';
		}));

		panel.appendChild(item);
		}

		backdrop.appendChild(panel);
		targetDocument.body.appendChild(backdrop);
		disposables.add({ dispose: () => backdrop.remove() });

		// Dismiss on Escape
		disposables.add(dom.addDisposableListener(targetDocument, dom.EventType.KEY_DOWN, e => {
			if (new StandardKeyboardEvent(e).equals(KeyCode.Escape)) {
				dom.EventHelper.stop(e, true);
				dismiss();
			}
		}));

		// Focus first item
		const firstItem = panel.querySelector<HTMLElement>('.host-picker-dropdown-item');
		firstItem?.focus();

		let isDismissing = false;
		const dismiss = () => {
			if (isDismissing) {
				return;
			}
			isDismissing = true;
			panel.classList.add('dismissing');
			const onEnd = () => {
				this._dropdown.clear();
			};
			panel.addEventListener('animationend', onEnd, { once: true });
			setTimeout(onEnd, 200);
		};
	}
}
