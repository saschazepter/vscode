/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable no-restricted-globals */

/**
 * Preload script for pages loaded in Integrated Browser
 *
 * It runs in an isolated context that Electron calls an "Isolated World" (this one in particular has worldId of 999,
 * but one can create more isolated worlds with different ids).
 * In DevTools Console, this context shows up as "Electron Isolated Context".
 *
 * Despite being isolated from each other, it still runs on the same page as the JS from the actual loaded website
 * (which runs on the so-called "Main World").
 */
(function () {

	const { contextBridge } = require('electron');

	// #######################################################################
	// IMPORTANT NOTES ABOUT THIS `globals` OBJECT:
	// - Once exposed via contextBridge.exposeInMainWorld, this object will be accessible to the JS of any arbitrary,
	//   possibly malicious page that a user loads in the Integrated Browser, so ensure that anything exposed here is
	//   safe to be accessed and called by such code.
	// - Do not use get/set properties anywhere here unless the access is without side effects
	//   (https://github.com/electron/electron/issues/25516).
	// #######################################################################
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
		// Use `contextBridge` APIs to expose globals to the the website loaded in the Integrated Browser.
		// The globals object will be recursively frozen (and for functions also proxied) by Electron to prevent
		// modification by the loaded page.
		// Both the the website's own scripts and the current script run on the same page but they run in two mutually
		// isolated contexts, called the "main world" (the website's scripts) and the "isolated world" (this script).
		// Learn more: see Electron docs for Security, contextBridge, and Context Isolation.
		contextBridge.exposeInMainWorld('browserViewAPI', globals);
	} catch (error) {
		console.error(error);
	}
}());
