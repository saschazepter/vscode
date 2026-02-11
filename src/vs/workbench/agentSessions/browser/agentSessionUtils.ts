/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { IActiveAgentSessionService } from '../../contrib/chat/browser/agentSessions/agentSessionsService.js';

/**
 * Returns the active working directory from the agent session service.
 * Prefers the worktree path over the repository path, since background/CLI
 * sessions operate in a worktree that may differ from the repo root.
 */
export function getActiveWorkingDirectory(activeAgentSessionService: IActiveAgentSessionService): URI | undefined {
	const session = activeAgentSessionService.getActiveSession();
	return session?.worktree ?? session?.repository;
}
