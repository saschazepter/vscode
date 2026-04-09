/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { window } from 'vscode';
import type { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';

/**
 * Session indexing levels — matches CLI's MissionControlIndexingLevel.
 * - 'local': keep on device only, no remote export
 * - 'user': sync to cloud, visible only to the user
 * - 'repo_and_user': sync to cloud, visible to repo collaborators
 */
export type SessionIndexingLevel = 'local' | 'user' | 'repo_and_user';

/** GlobalState key prefix for per-repo preferences. */
const PREF_KEY_PREFIX = 'copilot.sessionIndexing.';

/** GlobalState key for the global wildcard preference. */
const PREF_KEY_GLOBAL = `${PREF_KEY_PREFIX}*`;

/**
 * Manages user preferences for session indexing (local vs cloud sync).
 *
 * On first chat interaction in a repo, prompts the user to choose how
 * sessions are stored. The preference is persisted in globalState:
 * - Per-repo: `copilot.sessionIndexing.{owner/repo}` → level
 * - Global:   `copilot.sessionIndexing.*` → level
 *
 * Lookup order: repo-specific → global wildcard → prompt user.
 */
export class SessionIndexingPreference {

	constructor(
		private readonly _extensionContext: IVSCodeExtensionContext,
	) { }

	/**
	 * Get the stored preference for a repository, or undefined if not set.
	 */
	getPreference(repoNwo: string): SessionIndexingLevel | undefined {
		// Check repo-specific preference first
		const repoKey = `${PREF_KEY_PREFIX}${repoNwo}`;
		const repoPref = this._extensionContext.globalState.get<SessionIndexingLevel>(repoKey);
		if (repoPref) {
			return repoPref;
		}

		// Fall back to global wildcard
		return this._extensionContext.globalState.get<SessionIndexingLevel>(PREF_KEY_GLOBAL);
	}

	/**
	 * Prompt the user to choose their session indexing preference.
	 * Returns the chosen level, or undefined if dismissed.
	 */
	async promptUser(repoNwo: string): Promise<SessionIndexingLevel | undefined> {
		const items: { label: string; description?: string; level: SessionIndexingLevel }[] = [
			{
				label: l10n.t('$(lock) Keep on This Device Only'),
				description: l10n.t('Sessions stay local, not synced to cloud'),
				level: 'local',
			},
			{
				label: l10n.t('$(cloud-upload) Sync to My Account'),
				description: l10n.t('Sessions synced to cloud, visible only to you'),
				level: 'user',
			},
			{
				label: l10n.t('$(organization) Sync to Repository for My Team'),
				description: l10n.t('Sessions synced to cloud, visible to repo collaborators'),
				level: 'repo_and_user',
			},
		];

		const levelPick = await window.showQuickPick(items, {
			title: l10n.t('Session Storage'),
			placeHolder: l10n.t('Choose how your Copilot sessions are stored'),
			ignoreFocusOut: true,
		});

		if (!levelPick) {
			return undefined; // dismissed
		}

		// Ask scope
		const scopeItems: { label: string; scope: 'repo' | 'global' }[] = [
			{
				label: l10n.t('Apply to This Repository ({0})', repoNwo),
				scope: 'repo',
			},
			{
				label: l10n.t('Apply to All Repositories'),
				scope: 'global',
			},
		];

		const scopePick = await window.showQuickPick(scopeItems, {
			title: l10n.t('Session Storage Scope'),
			placeHolder: l10n.t('Where should this preference apply?'),
			ignoreFocusOut: true,
		});

		if (!scopePick) {
			// Dismissed scope — still save for this repo as default
			await this._savePreference(repoNwo, 'repo', levelPick.level);
			return levelPick.level;
		}

		await this._savePreference(repoNwo, scopePick.scope, levelPick.level);
		return levelPick.level;
	}

	/**
	 * Save the preference to globalState.
	 */
	private async _savePreference(
		repoNwo: string,
		scope: 'repo' | 'global',
		level: SessionIndexingLevel,
	): Promise<void> {
		if (scope === 'global') {
			await this._extensionContext.globalState.update(PREF_KEY_GLOBAL, level);
		} else {
			const repoKey = `${PREF_KEY_PREFIX}${repoNwo}`;
			await this._extensionContext.globalState.update(repoKey, level);
		}
	}
}
