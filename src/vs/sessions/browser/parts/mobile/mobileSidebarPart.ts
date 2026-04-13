/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AbstractPaneCompositePart } from '../../../../workbench/browser/parts/paneCompositePart.js';
import { SidebarPart } from '../sidebarPart.js';

/**
 * Mobile variant of SidebarPart.
 *
 * On phone-sized viewports the sidebar skips card-specific inline styles
 * so that CSS-only theming takes over.
 */
export class MobileSidebarPart extends SidebarPart {

	override updateStyles(): void {
		// Run base theme wiring (skips SidebarPart's card / title-area inline styles)
		AbstractPaneCompositePart.prototype.updateStyles.call(this);

		const container = this.getContainer();
		if (container) {
			container.style.backgroundColor = '';
			container.style.color = '';
			container.style.outlineColor = '';
		}
	}
}
