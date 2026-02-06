/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IChatWidgetService } from '../../../contrib/chat/browser/chat.js';
import { ChatAgentLocation } from '../../../contrib/chat/common/constants.js';

/**
 * Clears the main chat view widget when the workspace changes.
 */
export class ClearChatOnWorkspaceChangeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentSessions.clearChatOnWorkspaceChange';

	constructor(
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService
	) {
		super();

		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._clearChatWidgets();
		}));
	}

	private _clearChatWidgets(): void {
		for (const widget of this._chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat)) {
			widget.clear();
		}
	}
}
