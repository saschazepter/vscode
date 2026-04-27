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
import { AgentHostFilterConnectionStatus, IAgentHostFilterService } from '../../../contrib/remoteAgentHost/common/agentHostFilter.js';
import { HostFilterActionViewItem } from '../../../contrib/remoteAgentHost/browser/hostFilterActionViewItem.js';

/**
 * Mobile variant of {@link HostFilterActionViewItem}.
 *
 * Overrides the host picker to show a mobile-native bottom sheet instead
 * of the desktop context menu when in phone layout.
 */
export class MobileHostFilterActionViewItem extends HostFilterActionViewItem {

	private readonly _bottomSheet = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		action: IAction,
		@IAgentHostFilterService filterService: IAgentHostFilterService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IHoverService hoverService: IHoverService,
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

		this._showBottomSheet();
	}

	private _showBottomSheet(): void {
		// Dismiss any existing bottom sheet before opening a new one
		this._bottomSheet.clear();

		const disposables = new DisposableStore();
		this._bottomSheet.value = disposables;

		const targetWindow = dom.getWindow(this.element);
		const targetDocument = targetWindow.document;
		const hosts = this._filterService.hosts;
		const selectedId = this._filterService.selectedProviderId;

		// --- Backdrop ---
		const backdrop = targetDocument.createElement('div');
		backdrop.className = 'host-picker-sheet-backdrop';
		disposables.add(dom.addDisposableListener(backdrop, dom.EventType.CLICK, () => dismiss()));
		disposables.add(Gesture.addTarget(backdrop));
		disposables.add(dom.addDisposableListener(backdrop, TouchEventType.Tap, () => dismiss()));

		// --- Sheet container ---
		const sheet = targetDocument.createElement('div');
		sheet.className = 'host-picker-sheet';
		sheet.setAttribute('role', 'dialog');
		sheet.setAttribute('aria-label', localize('agentHostFilter.sheet.aria', "Select Agent Host"));

		// Prevent taps on the sheet from bubbling to the backdrop dismiss handler
		disposables.add(dom.addDisposableListener(sheet, dom.EventType.CLICK, e => e.stopPropagation()));
		disposables.add(Gesture.addTarget(sheet));
		disposables.add(dom.addDisposableListener(sheet, TouchEventType.Tap, e => dom.EventHelper.stop(e, true)));

		// Drag handle
		const handle = targetDocument.createElement('div');
		handle.className = 'host-picker-sheet-handle';
		sheet.appendChild(handle);

		// Title
		const title = targetDocument.createElement('div');
		title.className = 'host-picker-sheet-title';
		title.textContent = localize('agentHostFilter.sheet.title', "Select Host");
		sheet.appendChild(title);

		// Host items
		const list = targetDocument.createElement('div');
		list.className = 'host-picker-sheet-list';
		list.setAttribute('role', 'listbox');

		for (const host of hosts) {
			const item = targetDocument.createElement('button');
			item.className = 'host-picker-sheet-item';
			item.setAttribute('role', 'option');
			item.setAttribute('aria-selected', String(selectedId === host.providerId));
			if (selectedId === host.providerId) {
				item.classList.add('selected');
			}

			const iconSpan = targetDocument.createElement('span');
			iconSpan.className = 'host-picker-sheet-item-icon';
			iconSpan.append(...renderLabelWithIcons(`$(${Codicon.remote.id})`));
			item.appendChild(iconSpan);

			const labelSpan = targetDocument.createElement('span');
			labelSpan.className = 'host-picker-sheet-item-label';
			labelSpan.textContent = host.label;
			item.appendChild(labelSpan);

			if (host.status !== AgentHostFilterConnectionStatus.Connected) {
				const statusSpan = targetDocument.createElement('span');
				statusSpan.className = 'host-picker-sheet-item-status';
				statusSpan.textContent = host.status === AgentHostFilterConnectionStatus.Connecting
					? localize('agentHostFilter.sheet.connecting', "connecting…")
					: localize('agentHostFilter.sheet.disconnected', "disconnected");
				item.appendChild(statusSpan);
			}

			if (selectedId === host.providerId) {
				const checkSpan = targetDocument.createElement('span');
				checkSpan.className = 'host-picker-sheet-item-check';
				checkSpan.append(...renderLabelWithIcons(`$(${Codicon.check.id})`));
				item.appendChild(checkSpan);
			}

			disposables.add(dom.addDisposableListener(item, dom.EventType.CLICK, () => {
				this._filterService.setSelectedProviderId(host.providerId);
				dismiss();
			}));

			list.appendChild(item);
		}

		sheet.appendChild(list);
		backdrop.appendChild(sheet);
		targetDocument.body.appendChild(backdrop);
		disposables.add({ dispose: () => backdrop.remove() });

		// Dismiss on Escape
		disposables.add(dom.addDisposableListener(targetDocument, dom.EventType.KEY_DOWN, e => {
			if (new StandardKeyboardEvent(e).equals(KeyCode.Escape)) {
				dom.EventHelper.stop(e, true);
				dismiss();
			}
		}));

		// Focus first item for keyboard accessibility
		const firstItem = list.querySelector<HTMLElement>('.host-picker-sheet-item');
		firstItem?.focus();

		let isDismissing = false;
		const dismiss = () => {
			if (isDismissing) {
				return;
			}
			isDismissing = true;
			sheet.classList.add('dismissing');
			backdrop.classList.add('dismissing');
			const onEnd = () => {
				this._bottomSheet.clear();
			};
			sheet.addEventListener('animationend', onEnd, { once: true });
			// Fallback: clear after the animation duration in case animationend
			// does not fire (e.g., reduced-motion, display change).
			setTimeout(onEnd, 300);
		};
	}
}
