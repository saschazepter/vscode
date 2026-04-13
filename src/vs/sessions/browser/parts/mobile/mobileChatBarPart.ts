/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { Part } from '../../../../workbench/browser/part.js';
import { AbstractPaneCompositePart } from '../../../../workbench/browser/parts/paneCompositePart.js';
import { ChatBarPart } from '../chatBarPart.js';

/**
 * Mobile variant of ChatBarPart.
 *
 * On phone-sized viewports the chat bar fills the full grid cell without
 * card margins, border insets, or session-bar height adjustments.
 */
export class MobileChatBarPart extends ChatBarPart {

	override updateStyles(): void {
		// Run base theme wiring (skips ChatBarPart's card-specific inline styles)
		AbstractPaneCompositePart.prototype.updateStyles.call(this);

		const container = this.getContainer();
		if (container) {
			container.style.backgroundColor = '';
			container.style.removeProperty('--part-background');
			container.style.removeProperty('--part-border-color');
			container.style.color = '';
		}
	}

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.layoutService.isVisible(Parts.CHATBAR_PART)) {
			return;
		}

		this._lastLayout = { width, height, top, left };

		// Full dimensions — no card margins or session-bar subtraction
		AbstractPaneCompositePart.prototype.layout.call(this, width, height, top, left);
		Part.prototype.layout.call(this, width, height, top, left);
	}
}
