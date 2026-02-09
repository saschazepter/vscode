/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { ChatEntitlementContextKeys } from '../../../../services/chat/common/chatEntitlementService.js';
import { IWorkbenchModeService } from '../../../../services/layout/common/workbenchModeService.js';
import { IsAgentSessionsWorkspaceContext, WorkbenchModeContext } from '../../../../common/contextkeys.js';
import { CHAT_CATEGORY } from '../../browser/actions/chatActions.js';
import { ProductQualityContext } from '../../../../../platform/contextkey/common/contextkeys.js';
import { IActiveAgentSessionService } from '../../browser/agentSessions/agentSessionsService.js';
import { ITerminalGroupService, ITerminalService } from '../../../terminal/browser/terminal.js';
// eslint-disable-next-line local/code-import-patterns
import { AgentSessionsWorkbenchMenus } from '../../../../agentSessions/browser/agentSessionsWorkbenchMenus.js';
import { isAgentSession } from '../../browser/agentSessions/agentSessionsModel.js';
import { AgentSessionProviders } from '../../browser/agentSessions/agentSessions.js';

export class OpenAgentSessionsWindowAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.openAgentSessionsWindow',
			title: localize2('openAgentSessionsWindow', "Open Agent Sessions Window"),
			category: CHAT_CATEGORY,
			precondition: ContextKeyExpr.and(ProductQualityContext.notEqualsTo('stable'), ChatEntitlementContextKeys.Setup.hidden.negate()),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor) {
		const environmentService = accessor.get(INativeEnvironmentService);
		const nativeHostService = accessor.get(INativeHostService);
		const fileService = accessor.get(IFileService);

		// Create workspace file if it doesn't exist
		const workspaceUri = environmentService.agentSessionsWorkspace;
		if (!workspaceUri) {
			throw new Error('Agent Sessions workspace is not configured');
		}

		const workspaceExists = await fileService.exists(workspaceUri);
		if (!workspaceExists) {
			const emptyWorkspaceContent = JSON.stringify({ folders: [] }, null, '\t');
			await fileService.writeFile(workspaceUri, VSBuffer.fromString(emptyWorkspaceContent));
		}

		await nativeHostService.openWindow([{ workspaceUri }], { forceNewWindow: true });
	}
}

export class SwitchToAgentSessionsModeAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.switchToAgentSessionsMode',
			title: localize2('switchToAgentSessionsMode', "Switch to Agent Sessions Mode"),
			category: CHAT_CATEGORY,
			precondition: ContextKeyExpr.and(
				ProductQualityContext.notEqualsTo('stable'),
				ChatEntitlementContextKeys.Setup.hidden.negate(),
				IsAgentSessionsWorkspaceContext.toNegated(),
				WorkbenchModeContext.notEqualsTo('agent-sessions')
			),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor) {
		const workbenchModeService = accessor.get(IWorkbenchModeService);
		await workbenchModeService.setWorkbenchMode('agent-sessions');
	}
}

export class SwitchToNormalModeAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.switchToNormalMode',
			title: localize2('switchToNormalMode', "Switch to Default Mode"),
			category: CHAT_CATEGORY,
			precondition: ContextKeyExpr.and(
				ProductQualityContext.notEqualsTo('stable'),
				ChatEntitlementContextKeys.Setup.hidden.negate(),
				IsAgentSessionsWorkspaceContext.toNegated(),
				WorkbenchModeContext.notEqualsTo('')
			),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor) {
		const workbenchModeService = accessor.get(IWorkbenchModeService);
		await workbenchModeService.setWorkbenchMode(undefined);
	}
}

export class OpenSessionWorktreeInVSCodeAction extends Action2 {
	static readonly ID = 'chat.openSessionWorktreeInVSCode';

	constructor() {
		super({
			id: OpenSessionWorktreeInVSCodeAction.ID,
			title: localize2('openInVSCode', 'Open in VS Code'),
			icon: Codicon.vscodeInsiders,
			menu: [{
				id: AgentSessionsWorkbenchMenus.AgentSessionsOpenSubMenu,
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

		const folderUri = isAgentSession(activeSession) && activeSession.providerType !== AgentSessionProviders.Cloud ? activeSession.repository : undefined;

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
				id: AgentSessionsWorkbenchMenus.AgentSessionsOpenSubMenu,
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
			? activeSession.repository
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
MenuRegistry.appendMenuItem(AgentSessionsWorkbenchMenus.TitleBarRight, {
	submenu: AgentSessionsWorkbenchMenus.AgentSessionsOpenSubMenu,
	isSplitButton: { togglePrimaryAction: true },
	title: localize2('open', "Open..."),
	icon: Codicon.folderOpened,
	group: 'navigation',
	order: 9,
	when: IsAgentSessionsWorkspaceContext,
});
