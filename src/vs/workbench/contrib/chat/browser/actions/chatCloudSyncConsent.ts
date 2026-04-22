/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { localize, localize2 } from '../../../../../nls.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import Severity from '../../../../../base/common/severity.js';

/**
 * Command that shows a rich consent dialog for cloud session sync.
 * Called by the copilot extension before the first cloud upload per workspace.
 * Returns true if the user consented, false otherwise.
 */
CommandsRegistry.registerCommand('github.copilot.chat.showCloudSyncConsent', async (accessor, repoNwo: string): Promise<boolean> => {
	const dialogService = accessor.get(IDialogService);

	const result = await dialogService.prompt({
		type: Severity.Info,
		message: localize('cloudSync.consent.title', "Cloud Session Sync"),
		buttons: [
			{
				label: localize('cloudSync.consent.continue', "Continue"),
				run: () => true,
			},
			{
				label: localize('cloudSync.consent.disable', "Disable"),
				run: () => false,
			},
		],
		custom: {
			icon: Codicon.cloudUpload,
			markdownDetails: [{
				markdown: new MarkdownString(
					localize(
						'cloudSync.consent.detail',
						"Copilot session data for **{0}** will be synced to the cloud. This includes prompts, branches, and files touched during your sessions.\n\nThis enables:\n- Access to your session history across devices\n- Richer chronicle reports with cross-device data\n\nYou can disable this later in settings: `github.copilot.chat.advanced.sessionSearch.cloudSync.enabled`",
						repoNwo,
					),
				),
			}],
		},
	});

	return result.result ?? false;
});

/**
 * Command that enables cloud session sync by writing to the copilot extension setting.
 * Used as a command link in inline markdown messages within the chat.
 */
CommandsRegistry.registerCommand('github.copilot.chat.enableCloudSync', async (accessor): Promise<void> => {
	const configurationService = accessor.get(IConfigurationService);
	await configurationService.updateValue('github.copilot.chat.sessionSearch.cloudSync.enabled', true);
});

/**
 * Command that disables cloud session sync.
 * Used as a command link in the cloud sync consent content part.
 */
CommandsRegistry.registerCommand('github.copilot.chat.disableCloudSync', async (accessor): Promise<void> => {
	const configurationService = accessor.get(IConfigurationService);
	await configurationService.updateValue('github.copilot.chat.sessionSearch.cloudSync.enabled', false);
});

/**
 * Command that shows a non-modal notification suggesting cloud sync.
 * Shown once per workspace when the user runs /chronicle with localIndex on but cloudSync off.
 * "Enable" turns on cloudSync. "Don't Show Again" suppresses future notifications for this workspace.
 */
CommandsRegistry.registerCommand('github.copilot.chat.suggestCloudSync', async (accessor): Promise<void> => {
	const notificationService = accessor.get(INotificationService);
	const configurationService = accessor.get(IConfigurationService);
	const storageService = accessor.get(IStorageService);

	const dismissKey = 'chat.cloudSync.suggestionDismissed';
	if (storageService.getBoolean(dismissKey, StorageScope.WORKSPACE)) {
		return;
	}

	notificationService.prompt(
		Severity.Info,
		localize('cloudSync.suggest.message', "Cloud sync is available for richer cross-device Copilot session history."),
		[
			{
				label: localize('cloudSync.suggest.enable', "Enable"),
				run: () => {
					configurationService.updateValue('github.copilot.chat.sessionSearch.cloudSync.enabled', true);
					storageService.store(dismissKey, true, StorageScope.WORKSPACE, StorageTarget.USER);
				},
			},
			{
				label: localize('cloudSync.suggest.dismiss', "Don't Show Again"),
				run: () => {
					storageService.store(dismissKey, true, StorageScope.WORKSPACE, StorageTarget.USER);
				},
			},
		],
	);
});

/**
 * Debug action to reset all cloud sync consent/suggestion storage keys.
 * Allows re-testing the dialogs without clearing all workspace storage.
 */
registerAction2(class ResetCloudSyncConsentAction extends Action2 {
	constructor() {
		super({
			id: 'github.copilot.chat.resetCloudSyncConsent',
			title: localize2('cloudSync.reset.title', "Reset Cloud Sync Consent (Debug)"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const storageService = accessor.get(IStorageService);
		storageService.remove('chat.cloudSync.consentShown', StorageScope.WORKSPACE);
		storageService.remove('chat.cloudSync.suggestionDismissed', StorageScope.WORKSPACE);
	}
});
