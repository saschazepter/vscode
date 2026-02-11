/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../base/browser/dom.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { MenuId } from '../../../platform/actions/common/actions.js';
import { MenuWorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { Menus } from '../menus.js';

// Sidebar margin values (must match style.css)
const SIDEBAR_MARGIN_TOP = 8;
const SIDEBAR_MARGIN_HORIZONTAL = 8;

type FloatingToolbarSide = 'left' | 'right';

/**
 * A floating toolbar that appears at the top of the agent sessions workbench,
 * underneath the title bar. It's only visible when there is at least one menu item.
 *
 * - `left` variant: shows actions for the primary sidebar (e.g. toggle sidebar).
 * - `right` variant: shows actions for the auxiliary/secondary sidebar.
 */
export class FloatingToolbar extends Disposable {

	private readonly container: HTMLElement;
	private readonly toolbar: MenuWorkbenchToolBar;
	private readonly _side: FloatingToolbarSide;
	private readonly _menuId: MenuId;
	private readonly _hiddenByPart: Parts;

	constructor(
		parentContainer: HTMLElement,
		side: FloatingToolbarSide,
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService
	) {
		super();

		this._side = side;
		this._menuId = side === 'left'
			? Menus.FloatingToolbar
			: Menus.FloatingToolbarRight;
		this._hiddenByPart = side === 'left' ? Parts.SIDEBAR_PART : Parts.AUXILIARYBAR_PART;

		// Create floating toolbar container
		this.container = $('div.floating-toolbar');
		this.container.classList.add(this._side);
		parentContainer.appendChild(this.container);

		// Create toolbar with the appropriate menu
		this.toolbar = this._register(instantiationService.createInstance(
			MenuWorkbenchToolBar,
			this.container,
			this._menuId,
			{
				menuOptions: { shouldForwardArgs: true }
			}
		));

		// Update visibility based on menu items
		// The toolbar container gets 'has-no-actions' class when empty
		this._register(this.toolbar.onDidChangeMenuItems(() => this.updateVisibility()));

		// Hide immediately when the associated sidebar becomes visible (don't wait for menu context key propagation)
		this._register(this.layoutService.onDidChangePartVisibility(e => {
			if (e.partId === this._hiddenByPart && e.visible) {
				this.container.classList.remove('visible');
			}
		}));

		// Update position when layout changes
		this._register(this.layoutService.onDidChangePartVisibility(() => this.updatePosition()));
		this._register(this.layoutService.onDidLayoutMainContainer(() => this.updatePosition()));

		// Initial setup
		this.updatePosition();
		this.updateVisibility();
	}

	private updatePosition(): void {
		// Get titlebar height
		const titlebarPart = this.layoutService.getContainer(globalThis.window, Parts.TITLEBAR_PART);
		const titlebarHeight = titlebarPart?.offsetHeight ?? 30;

		// Position: titlebar height + sidebar margin
		const paddingTop = 8;
		this.container.style.top = `${titlebarHeight + SIDEBAR_MARGIN_TOP + paddingTop}px`;

		if (this._side === 'left') {
			this.container.style.left = `${SIDEBAR_MARGIN_HORIZONTAL}px`;
			this.container.style.right = '';
		} else {
			this.container.style.right = `${SIDEBAR_MARGIN_HORIZONTAL}px`;
			this.container.style.left = '';
		}
	}

	private updateVisibility(): void {
		// Check if toolbar has any actions (MenuWorkbenchToolBar adds 'has-no-actions' class when empty)
		const hasItems = !this.container.classList.contains('has-no-actions');
		this.container.classList.toggle('visible', hasItems);
	}
}
