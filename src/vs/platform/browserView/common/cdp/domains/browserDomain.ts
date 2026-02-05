/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerCDPDomain } from './index.js';
import { CDPMethodContext, CDPMethodResult } from '../types.js';

/**
 * Browser.* CDP command handlers.
 * These are browser-level commands for browser information and window management.
 */
export namespace CDPBrowserDomain {
	export function getVersion(_params: {}, _ctx: CDPMethodContext): CDPMethodResult {
		return {
			result: {
				protocolVersion: '1.3',
				product: 'VS Code Integrated Browser',
				revision: 'VS Code',
				userAgent: 'Electron',
				jsVersion: process.versions.v8
			}
		};
	}

	export function close(_params: {}, _ctx: CDPMethodContext): CDPMethodResult {
		// We don't actually close the browser, just acknowledge
		return { result: {} };
	}

	export function getWindowForTarget(_params: { targetId?: string }, _ctx: CDPMethodContext): CDPMethodResult {
		// Return a stub window
		return {
			result: {
				windowId: 1,
				bounds: { left: 0, top: 0, width: 800, height: 600, windowState: 'normal' }
			}
		};
	}

	export function getWindowBounds(_params: { windowId?: number }, _ctx: CDPMethodContext): CDPMethodResult {
		return {
			result: {
				bounds: { left: 0, top: 0, width: 800, height: 600, windowState: 'normal' }
			}
		};
	}
}

// Register the Browser domain
registerCDPDomain('Browser', CDPBrowserDomain);
