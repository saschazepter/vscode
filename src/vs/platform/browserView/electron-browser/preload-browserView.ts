/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable no-restricted-globals */

/**
 * Preload script for pages loaded in Integrated Browser
 *
 * It runs in an isolated context that Electron calls an "isolated world".
 * Despite being isolated, it still runs on the same page as the JS from the actual loaded website
 * (which runs on the so-called "main world").
 *
 * Learn more: see Electron docs for Security, contextBridge, and Context Isolation.
 */
(function () {

	const { contextBridge, webFrame } = require('electron');

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
				// Even if the page has overridden window.getSelection, our call here will still reach the original
				// implementation. That's because Electron proxies functions, such as getSelectedText here, that are
				// exposed to a different context via exposeInIsolatedWorld or exposeInMainWorld.
				return window.getSelection()?.toString() ?? '';
			} catch {
				return '';
			}
		}
	};

	try {
		// The worldId for the isolated world we will create.
		// It's different from this preload script's isolated world, which has worldId 999 and shows up in DevTools as "Electron Isolated Context".
		const isolatedWorldId = 1000;

		// Set the name for our isolated world so it shows up nicely in DevTools
		webFrame.setIsolatedWorldInfo(isolatedWorldId, { name: 'Integrated Browser Isolated Context' });

		// Use `contextBridge` APIs to expose globals to our own isolated world.
		// The globals object will be recursively frozen (and for functions also proxied) by Electron to prevent
		// modification within the given context.
		contextBridge.exposeInIsolatedWorld(isolatedWorldId, 'browserViewAPI', globals);
	} catch (error) {
		console.error(error);
	}
}());
