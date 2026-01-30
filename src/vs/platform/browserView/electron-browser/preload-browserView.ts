/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable no-restricted-globals */

/**
 * Preload script for browser views that exposes safe APIs via contextBridge.
 *
 * This script runs in an isolated context BEFORE the page's scripts, so we can
 * capture references to native APIs before they can be tampered with by page content.
 */
(function () {

	const { contextBridge } = require('electron');

	// Capture native APIs before page scripts can override them
	const nativeGetSelection = window.getSelection.bind(window);

	// #######################################################################
	// ###                                                                 ###
	// ###       !!! DO NOT USE GET/SET PROPERTIES ANYWHERE HERE !!!       ###
	// ###       !!!  UNLESS THE ACCESS IS WITHOUT SIDE EFFECTS  !!!       ###
	// ###       (https://github.com/electron/electron/issues/25516)       ###
	// ###                                                                 ###
	// #######################################################################

	const globals = {

		/**
		 * Get the currently selected text in the page.
		 */
		getSelectedText(): string {
			try {
				return nativeGetSelection()?.toString() ?? '';
			} catch {
				return '';
			}
		}
	};

	try {
		contextBridge.exposeInMainWorld('vscodeBrowserView', globals);
	} catch (error) {
		console.error(error);
	}
}());
