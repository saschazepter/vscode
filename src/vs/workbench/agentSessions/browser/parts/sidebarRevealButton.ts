/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';

/**
 * The distance from the edge (in pixels) that triggers the reveal button to appear.
 */
const EDGE_TRIGGER_ZONE_PX = 36;

/**
 * The size of the reveal button (diameter in pixels).
 */
const BUTTON_SIZE_PX = 32;

type Side = 'left' | 'right';

/**
 * A round button that appears at the edge of the workbench when a sidebar is hidden.
 * Hovering near the edge slides the button in; clicking it reveals the sidebar.
 */
export class SidebarRevealButton extends Disposable {

	private readonly button: HTMLElement;
	private readonly _mouseListenerDisposable = this._register(new MutableDisposable());
	private _visible = false;
	private _enabled = false;

	constructor(
		private readonly parentContainer: HTMLElement,
		private readonly side: Side,
		private readonly layoutService: IWorkbenchLayoutService
	) {
		super();

		this.button = this.createButton();
		this.parentContainer.appendChild(this.button);

		// Start listening for mouse movement to show/hide the button
		this.installMouseListener();

		// Listen for part visibility changes to enable/disable the button
		this._register(this.layoutService.onDidChangePartVisibility(e => {
			const relevantPart = this.side === 'left' ? Parts.SIDEBAR_PART : Parts.AUXILIARYBAR_PART;
			if (e.partId === relevantPart) {
				this.updateEnabled(!e.visible);
			}
		}));

		// Set initial enabled state
		const part = this.side === 'left' ? Parts.SIDEBAR_PART : Parts.AUXILIARYBAR_PART;
		this.updateEnabled(!this.layoutService.isVisible(part));
	}

	private createButton(): HTMLElement {
		const button = $('div.sidebar-reveal-button');
		button.classList.add(this.side === 'left' ? 'left' : 'right');
		button.setAttribute('role', 'button');

		// Icon: chevron pointing toward the center of the workbench
		const icon = $('span.sidebar-reveal-button-icon');
		const codicon = this.side === 'left' ? Codicon.chevronRight : Codicon.chevronLeft;
		icon.classList.add(...ThemeIcon.asClassNameArray(codicon));
		button.appendChild(icon);

		// Set size via CSS custom properties for easy tuning
		button.style.setProperty('--reveal-button-size', `${BUTTON_SIZE_PX}px`);

		// Click handler
		this._register(addDisposableListener(button, EventType.CLICK, () => this.revealSidebar()));

		return button;
	}

	private installMouseListener(): void {
		const listener = this._register(addDisposableListener(this.parentContainer, EventType.MOUSE_MOVE, (e: MouseEvent) => {
			if (!this._enabled) {
				return;
			}

			const rect = this.parentContainer.getBoundingClientRect();
			const isNearEdge = this.side === 'left'
				? (e.clientX - rect.left) < EDGE_TRIGGER_ZONE_PX
				: (rect.right - e.clientX) < EDGE_TRIGGER_ZONE_PX;

			if (isNearEdge && !this._visible) {
				this.showButton();
			} else if (!isNearEdge && this._visible) {
				this.hideButton();
			}
		}));
		this._mouseListenerDisposable.value = listener;

		// Hide button when mouse leaves the workbench entirely
		this._register(addDisposableListener(this.parentContainer, EventType.MOUSE_LEAVE, () => {
			if (this._visible) {
				this.hideButton();
			}
		}));
	}

	private updateEnabled(enabled: boolean): void {
		this._enabled = enabled;
		if (!enabled) {
			this.hideButton();
		}
	}

	private showButton(): void {
		if (this._visible) {
			return;
		}
		this._visible = true;
		this.button.classList.add('visible');
	}

	private hideButton(instant?: boolean): void {
		if (!this._visible) {
			return;
		}
		this._visible = false;
		if (instant) {
			this.button.classList.add('no-transition');
		}
		this.button.classList.remove('visible');
		if (instant) {
			// Force reflow so the no-transition class takes effect synchronously
			this.button.classList.remove('no-transition');
		}
	}

	private revealSidebar(): void {
		this.hideButton(/* instant */ true);
		const part = this.side === 'left' ? Parts.SIDEBAR_PART : Parts.AUXILIARYBAR_PART;
		this.layoutService.setPartHidden(false, part);
	}
}
