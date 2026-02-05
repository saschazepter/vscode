/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { IWorkspaceFolder } from '../../../platform/workspace/common/workspace.js';
import { IAgentWorkbenchWorkspaceService } from '../../services/agentSessions/browser/agentWorkbenchWorkspaceService.js';

/**
 * Provides workspace folder information for the Agent Workbench.
 * This service is initialized with a connection to the ProjectBarPart that provides
 * the selected workspace folder and fires events when the selection changes.
 */
export class AgentWorkbenchWorkspaceService extends Disposable implements IAgentWorkbenchWorkspaceService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveWorkspaceFolder = this._register(new Emitter<URI | undefined>());
	readonly onDidChangeActiveWorkspaceFolder: Event<URI | undefined> = this._onDidChangeActiveWorkspaceFolder.event;

	private _activeWorkspaceFolderUri: URI | undefined;
	get activeWorkspaceFolderUri(): URI | undefined {
		return this._activeWorkspaceFolderUri;
	}

	constructor(
		initialFolder: IWorkspaceFolder | undefined,
		onDidSelectWorkspace: Event<IWorkspaceFolder | undefined>
	) {
		super();

		// Set initial value
		this._activeWorkspaceFolderUri = initialFolder?.uri;

		// Update when workspace selection changes
		this._register(onDidSelectWorkspace(folder => {
			this._activeWorkspaceFolderUri = folder?.uri;
			this._onDidChangeActiveWorkspaceFolder.fire(this._activeWorkspaceFolderUri);
		}));
	}
}
