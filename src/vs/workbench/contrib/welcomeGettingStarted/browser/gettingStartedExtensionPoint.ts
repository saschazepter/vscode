/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IWalkthrough } from '../../../../platform/extensions/common/extensions.js';
import { ExtensionsRegistry } from '../../../services/extensions/common/extensionsRegistry.js';

const titleTranslated = localize('title', "Title");

// Walkthrough extension point has been disabled
// export const walkthroughsExtensionPoint = ExtensionsRegistry.registerExtensionPoint<IWalkthrough[]>({
// 	extensionPoint: 'walkthroughs',
// 	jsonSchema: {
// 		description: localize('walkthroughs', "Contribute walkthroughs to help users getting started with your extension."),
// 		type: 'array',
// 		items: {
// 			// schema content omitted for brevity
// 		}
// 	}
// });

// Return an empty object to maintain API compatibility
export const walkthroughsExtensionPoint = {
	setHandler: () => { /* no-op */ }
};
