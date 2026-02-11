/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IsAgentSessionsWorkspaceContext } from '../../../../workbench/common/contextkeys.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AgentSessionProviders } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';
import { isAgentSession } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsModel.js';
import { IActiveAgentSessionService } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { ITerminalService, ITerminalGroupService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { Menus } from '../../../browser/menus.js';
import { BranchChatSessionAction } from './branchChatSessionAction.js';
import { RunScriptContribution } from './runScriptAction.js';

export class OpenSessionWorktreeInVSCodeAction extends Action2 {
	static readonly ID = 'chat.openSessionWorktreeInVSCode';

	constructor() {
		super({
			id: OpenSessionWorktreeInVSCodeAction.ID,
			title: localize2('openInVSCode', 'Open in VS Code'),
			icon: Codicon.vscodeInsiders,
			menu: [{
				id: Menus.OpenSubMenu,
				group: 'navigation',
				order: 2,
			}]
		});
	}

	override async run(accessor: ServicesAccessor,): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		const agentSessionsService = accessor.get(IActiveAgentSessionService);

		const activeSession = agentSessionsService.activeSession.get();
		if (!activeSession) {
			return;
		}

		const folderUri = isAgentSession(activeSession) && activeSession.providerType !== AgentSessionProviders.Cloud ? activeSession.worktree : undefined;

		if (!folderUri) {
			return;
		}

		await nativeHostService.openWindow([{ folderUri }], { forceNewWindow: true });
	}
}
registerAction2(OpenSessionWorktreeInVSCodeAction);

export class OpenSessionInTerminalAction extends Action2 {

	constructor() {
		super({
			id: 'agentSession.openInTerminal',
			title: localize2('openInTerminal', "Open Terminal"),
			icon: Codicon.terminal,
			menu: [{
				id: Menus.OpenSubMenu,
				group: 'navigation',
				order: 1,
			}]
		});
	}

	override async run(accessor: ServicesAccessor,): Promise<void> {
		const terminalService = accessor.get(ITerminalService);
		const terminalGroupService = accessor.get(ITerminalGroupService);
		const agentSessionsService = accessor.get(IActiveAgentSessionService);

		const activeSession = agentSessionsService.activeSession.get();
		const repository = isAgentSession(activeSession) && activeSession.providerType !== AgentSessionProviders.Cloud
			? activeSession.worktree
			: undefined;
		if (repository) {
			const instance = await terminalService.createTerminal({ config: { cwd: repository } });
			if (instance) {
				terminalService.setActiveInstance(instance);
			}
		}
		terminalGroupService.showPanel(true);
	}
}

registerAction2(OpenSessionInTerminalAction);

// Register the split button menu item that combines Open in VS Code and Open in Terminal
MenuRegistry.appendMenuItem(Menus.TitleBarRight, {
	submenu: Menus.OpenSubMenu,
	isSplitButton: { togglePrimaryAction: true },
	title: localize2('open', "Open..."),
	icon: Codicon.folderOpened,
	group: 'navigation',
	order: 9,
	when: IsAgentSessionsWorkspaceContext,
});

registerAction2(BranchChatSessionAction);
registerWorkbenchContribution2(RunScriptContribution.ID, RunScriptContribution, WorkbenchPhase.AfterRestored);
