/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IAgentWorkbenchWorkspaceService = createDecorator<IAgentWorkbenchWorkspaceService>('agentWorkbenchWorkspaceService');

/**
 * Service that exposes the currently active workspace folder in the Agent Workbench.
 * The active folder is selected via the Project Bar.
 */
export interface IAgentWorkbenchWorkspaceService {
	readonly _serviceBrand: undefined;

	/**
	 * Event that fires when the active workspace folder changes.
	 */
	readonly onDidChangeActiveWorkspaceFolder: Event<URI | undefined>;

	/**
	 * URI of the currently active workspace folder.
	 * Returns `undefined` when no workspace folder is selected.
	 */
	readonly activeWorkspaceFolderUri: URI | undefined;
}
