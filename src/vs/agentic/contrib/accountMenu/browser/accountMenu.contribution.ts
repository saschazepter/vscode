/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDefaultAccountService } from '../../../../platform/defaultAccount/common/defaultAccount.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { appendUpdateMenuItems as registerUpdateMenuItems } from '../../../../workbench/contrib/update/browser/update.js';
import { Menus } from '../../../browser/menus.js';

// --- Account Menu --- //

// Register the AgenticAccount submenu in the TitleBarRight toolbar
MenuRegistry.appendMenuItem(Menus.TitleBarRight, {
	submenu: Menus.AgenticAccount,
	title: localize('account', "Account"),
	icon: Codicon.account,
	group: 'navigation',
	order: 10000,
});

// Sign in action
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.agenticSignIn',
			title: localize2('signIn', 'Sign In'),
			menu: {
				id: Menus.AgenticAccount,
				when: ContextKeyExpr.notEquals('defaultAccountStatus', 'available'),
				group: '1_account',
				order: 1,
			}
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const defaultAccountService = accessor.get(IDefaultAccountService);
		await defaultAccountService.signIn();
	}
});

// Sign Out action
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.agenticSignOut',
			title: localize2('signOut', 'Sign Out'),
			menu: {
				id: Menus.AgenticAccountSignedIn,
			}
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const defaultAccountService = accessor.get(IDefaultAccountService);
		const commandService = accessor.get(ICommandService);
		const account = await defaultAccountService.getDefaultAccount();
		if (account) {
			await commandService.executeCommand('_signOutOfAccount', {
				providerId: account.authenticationProvider.id,
				accountLabel: account.accountName,
			});
		}
	}
});

// Settings
MenuRegistry.appendMenuItem(Menus.AgenticAccount, {
	command: {
		id: 'workbench.action.openSettings',
		title: localize('settings', "Settings"),
	},
	group: '2_settings',
	order: 1,
});

// Check for Updates (reuses the update commands registered by the update contribution)
registerUpdateMenuItems(Menus.AgenticAccount, '2_settings');

// --- Signed-in Account Label Contribution --- //
// The account submenu title (e.g. "sandy081 (GitHub)") is dynamic,
// so we use a contribution to update it when the default account changes.

class AgenticAccountContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agenticAccount';

	private readonly signedAccountSubMenuItem = this._register(new MutableDisposable());

	constructor(
		@IDefaultAccountService private readonly defaultAccountService: IDefaultAccountService,
	) {
		super();
		this.update();
		this._register(this.defaultAccountService.onDidChangeDefaultAccount(() => this.update()));
	}

	private async update(): Promise<void> {
		const account = await this.defaultAccountService.getDefaultAccount();
		this.signedAccountSubMenuItem.value = account ? MenuRegistry.appendMenuItem(Menus.AgenticAccount, {
			submenu: Menus.AgenticAccountSignedIn,
			title: `${account.accountName} (${account.authenticationProvider.name})`,
			group: '1_account',
			order: 1,
		}) : undefined;
	}
}

registerWorkbenchContribution2(AgenticAccountContribution.ID, AgenticAccountContribution, WorkbenchPhase.AfterRestored);
