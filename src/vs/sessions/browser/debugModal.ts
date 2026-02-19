/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared helper for opening debug panels in a modal overlay.
 * Used by both the Copilot SDK and Cloud Task debug panel actions.
 */

import * as dom from '../../base/browser/dom.js';
import { IDisposable } from '../../base/common/lifecycle.js';

export interface IDebugModalOptions {
	readonly container: HTMLElement;
	readonly width?: string;
	readonly height?: string;
	readonly maxHeight?: string;
}

/**
 * Open a modal overlay in the given container. Returns a disposable that
 * removes the backdrop and cleans up event listeners when disposed.
 *
 * @param options Modal configuration (container, sizing)
 * @param renderContent Called with the modal content element. Must return
 *   a disposable that will be disposed when the modal closes.
 */
export function openDebugModal(
	options: IDebugModalOptions,
	renderContent: (contentEl: HTMLElement) => IDisposable,
): IDisposable {
	const targetWindow = dom.getWindow(options.container);

	const backdrop = dom.$('.copilot-sdk-debug-backdrop');
	backdrop.style.cssText = 'position:absolute;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);';
	options.container.appendChild(backdrop);

	const modal = dom.$('div');
	const width = options.width ?? '560px';
	const height = options.height ?? '80%';
	const maxHeight = options.maxHeight ?? '700px';
	modal.style.cssText = `width:${width};height:${height};max-height:${maxHeight};border-radius:8px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.4);`;
	backdrop.appendChild(modal);

	const contentDisposable = renderContent(modal);

	const close = () => {
		contentDisposable.dispose();
		backdrop.remove();
		targetWindow.document.removeEventListener('keydown', onKeyDown);
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') { close(); }
	};

	backdrop.addEventListener('click', (e) => {
		if (e.target === backdrop) { close(); }
	});
	targetWindow.document.addEventListener('keydown', onKeyDown);

	return { dispose: close };
}
