/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { ChatEntitlementContextKeys } from '../../../../services/chat/common/chatEntitlementService.js';
import { IWorkbenchModeService } from '../../../../services/layout/common/workbenchModeService.js';
import { IsAgentSessionsWorkspaceContext, WorkbenchModeContext } from '../../../../common/contextkeys.js';
import { CHAT_CATEGORY } from '../../browser/actions/chatActions.js';
import { ProductQualityContext } from '../../../../../platform/contextkey/common/contextkeys.js';
import { IAgentSessionsService } from '../../browser/agentSessions/agentSessionsService.js';
import { IChatWidgetService } from '../../browser/chat.js';
import { ITerminalGroupService, ITerminalService } from '../../../terminal/browser/terminal.js';

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
			category: CHAT_CATEGORY,
			menu: [
				{
					id: MenuId.AgentSessionsOpenSubMenu,
					group: 'navigation',
					order: 2,
					when: IsAgentSessionsWorkspaceContext
				}
			],
		});
	}

	override async run(accessor: ServicesAccessor,): Promise<void> {
		const nativeHostService = accessor.get(INativeHostService);
		const agentSessionsService = accessor.get(IAgentSessionsService);
		const chatWidgetService = accessor.get(IChatWidgetService);

		const sessionResource = chatWidgetService.lastFocusedWidget?.viewModel?.sessionResource;
		if (!sessionResource) {
			return;
		}

		const session = agentSessionsService.getSession(sessionResource);
		const folderPath = session?.metadata?.worktreePath as string | undefined;

		if (!folderPath) {
			return;
		}

		await nativeHostService.openWindow([{ folderUri: URI.file(folderPath) }], { forceNewWindow: true });
	}
}
registerAction2(OpenSessionWorktreeInVSCodeAction);

export class OpenSessionInTerminalAction extends Action2 {

	constructor() {
		super({
			id: 'agentSession.openInTerminal',
			title: localize2('openInTerminal', "Open in Integrated Terminal"),
			icon: Codicon.terminal,
			menu: [{
				id: MenuId.AgentSessionsOpenSubMenu,
				group: 'navigation',
				order: 1,
				when: IsAgentSessionsWorkspaceContext,
			}]
		});
	}

	override async run(accessor: ServicesAccessor,): Promise<void> {
		const terminalService = accessor.get(ITerminalService);
		const terminalGroupService = accessor.get(ITerminalGroupService);
		const agentSessionsService = accessor.get(IAgentSessionsService);
		const chatWidgetService = accessor.get(IChatWidgetService);

		const sessionResource = chatWidgetService.lastFocusedWidget?.viewModel?.sessionResource;
		if (!sessionResource) {
			return;
		}

		const session = agentSessionsService.getSession(sessionResource);
		const folderPath = session?.metadata?.worktreePath as string | undefined;

		if (!folderPath) {
			return;
		}

		const instance = await terminalService.createTerminal({ config: { cwd: URI.file(folderPath) } });
		if (instance) {
			terminalService.setActiveInstance(instance);
			terminalGroupService.showPanel(true);
		}
	}
}

registerAction2(OpenSessionInTerminalAction);

// Register the split button menu item that combines Open in VS Code and Open in Terminal
MenuRegistry.appendMenuItem(MenuId.AuxiliaryBarTitle, {
	submenu: MenuId.AgentSessionsOpenSubMenu,
	isSplitButton: { togglePrimaryAction: true },
	title: localize2('open', "Open..."),
	icon: Codicon.folderOpened,
	group: 'navigation',
	order: 1,
	when: IsAgentSessionsWorkspaceContext,
});
