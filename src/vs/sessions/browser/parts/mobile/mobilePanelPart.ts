/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { Part } from '../../../../workbench/browser/part.js';
import { AbstractPaneCompositePart } from '../../../../workbench/browser/parts/paneCompositePart.js';
import { PanelPart } from '../panelPart.js';

/**
 * Mobile variant of PanelPart.
 *
 * On phone-sized viewports the panel fills the full grid cell
 * without card margins or border insets.
 */
export class MobilePanelPart extends PanelPart {

	override updateStyles(): void {
		// Run base theme wiring (skips PanelPart's card-specific inline styles)
		AbstractPaneCompositePart.prototype.updateStyles.call(this);

		const container = this.getContainer();
		if (container) {
			container.style.backgroundColor = '';
			container.style.removeProperty('--part-background');
			container.style.removeProperty('--part-border-color');
		}
	}

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.layoutService.isVisible(Parts.PANEL_PART)) {
			return;
		}

		// Full dimensions — no card margins or border subtraction
		AbstractPaneCompositePart.prototype.layout.call(this, width, height, top, left);
		Part.prototype.layout.call(this, width, height, top, left);
	}
}
