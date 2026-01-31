/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable no-restricted-globals */

/**
 * Preload script for browser views that exposes safe APIs via contextBridge.
 * Learn more: Search the Electron docs for Security, contextBridge, and Context Isolation.
 */
(function () {

	const { contextBridge } = require('electron');

	// #######################################################################
	// ###                                                                 ###
	// ###       !!! DO NOT USE GET/SET PROPERTIES ANYWHERE HERE !!!       ###
	// ###       !!!  UNLESS THE ACCESS IS WITHOUT SIDE EFFECTS  !!!       ###
	// ###       (https://github.com/electron/electron/issues/25516)       ###
	// ###                                                                 ###
	// #######################################################################

	// IMPORTANT: This API can be accessed by the JS of any arbitrary, possibly malicious page that a user loads in the
	// Integrated Browser, so ensure that anything exposed here is safe to be accessed and called by such code.
	const globals = {
		/**
		 * Get the currently selected text in the page.
		 */
		getSelectedText(): string {
			try {
				// Even if the page has overridden window.getSelection, our call here will still reach the original
				// implementation.
				return window.getSelection()?.toString() ?? '';
			} catch {
				return '';
			}
		}
	};

	try {
		// Use `contextBridge` APIs to expose globals to the the website loaded in the Integrated Browser
		contextBridge.exposeInMainWorld('browserViewAPI', globals);
	} catch (error) {
		console.error(error);
	}
}());
