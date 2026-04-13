/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';

/**
 * Session indexing levels — matches CLI's MissionControlIndexingLevel.
 * - 'local': keep on device only, no remote export
 * - 'user': sync to cloud, visible only to the user
 * - 'repo_and_user': sync to cloud, visible to repo collaborators
 */
export type SessionIndexingLevel = 'local' | 'user' | 'repo_and_user';

/**
 * Storage level setting values (includes 'none' for first-use notification).
 */
export type StorageLevelSetting = 'none' | SessionIndexingLevel;

/**
 * Manages user preferences for session indexing via VS Code settings.
 *
 * Uses the `github.copilot.chat.advanced.sessionSearch.storageLevel` setting
 * (workspace-scoped) instead of inline chat consent.
 *
 * When the setting is 'none' (default), a one-time notification is shown
 * on first `/chronicle` use, with buttons to set the value.
 */
export class SessionIndexingPreference {

	/** Track whether we've shown the notification in this session to avoid spamming. */
	private _notificationShown = false;

	constructor(
		private readonly _configService: IConfigurationService,
	) { }

	/**
	 * Get the current storage level from settings.
	 * Returns the level, or undefined if set to 'none' (not yet configured).
	 */
	getStorageLevel(): SessionIndexingLevel | undefined {
		const value = this._configService.getConfig(ConfigKey.TeamInternal.SessionSearchStorageLevel);
		if (value === 'none' || !value) {
			return undefined;
		}
		return value as SessionIndexingLevel;
	}

	/**
	 * Check if the user needs to be prompted (setting is 'none').
	 */
	needsPrompt(): boolean {
		const value = this._configService.getConfig(ConfigKey.TeamInternal.SessionSearchStorageLevel);
		return value === 'none' || !value;
	}

	/**
	 * Show a one-time notification asking the user to configure session storage.
	 * Uses vscode.window.showInformationMessage with action buttons.
	 *
	 * Returns the chosen level, or undefined if dismissed.
	 */
	async showFirstUseNotification(): Promise<SessionIndexingLevel | undefined> {
		if (this._notificationShown) {
			return undefined;
		}
		this._notificationShown = true;

		// Dynamic import to avoid circular deps — vscode is only available at runtime
		const vscode = await import('vscode');

		const openSettings = l10n.t('Open Settings');

		const choice = await vscode.window.showInformationMessage(
			l10n.t('Configure how Copilot stores your session history. This enables features like /chronicle.'),
			openSettings,
		);

		if (choice === openSettings) {
			await vscode.commands.executeCommand('workbench.action.openSettings', 'github.copilot.chat.advanced.sessionSearch.storageLevel');
		}

		return undefined;
	}

	/**
	 * Check if the current storage level enables cloud sync.
	 */
	hasCloudConsent(): boolean {
		const level = this.getStorageLevel();
		return level === 'user' || level === 'repo_and_user';
	}
}
