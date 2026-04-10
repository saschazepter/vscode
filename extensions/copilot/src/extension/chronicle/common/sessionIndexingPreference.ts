/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import type { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart } from '../../../vscodeTypes';
import type { IAnswerResult } from '../../tools/common/askQuestionsTypes';
import { ToolName } from '../../tools/common/toolNames';
import type { IToolsService } from '../../tools/common/toolsService';

/**
 * Session indexing levels — matches CLI's MissionControlIndexingLevel.
 * - 'local': keep on device only, no remote export
 * - 'user': sync to cloud, visible only to the user
 * - 'repo_and_user': sync to cloud, visible to repo collaborators
 */
export type SessionIndexingLevel = 'local' | 'user' | 'repo_and_user';

/** GlobalState key prefix for per-repo preferences. */
const PREF_KEY_PREFIX = 'copilot.sessionSearch.';

/** GlobalState key for the global wildcard preference. */
const PREF_KEY_GLOBAL = `${PREF_KEY_PREFIX}*`;

/** Map option labels to indexing levels. */
const LEVEL_OPTIONS: { label: string; description: string; level: SessionIndexingLevel }[] = [
	{ label: 'Keep on this device only', description: 'Sessions stay local, not synced to cloud', level: 'local' },
	{ label: 'Sync to my account', description: 'Sessions synced to cloud, visible only to you', level: 'user' },
	{ label: 'Sync to the repository for my team', description: 'Sessions synced to cloud, visible to repo collaborators', level: 'repo_and_user' },
];

/** Scope options vary by level. */
const SCOPE_OPTIONS_BY_LEVEL: Record<SessionIndexingLevel, { label: string; description: string; scope: 'session' | 'repo' | 'global' }[]> = {
	local: [
		{ label: 'This session', description: 'Only applies to the current session', scope: 'session' },
		{ label: 'This repository', description: 'Only applies to the current repository', scope: 'repo' },
		{ label: 'All repositories', description: 'Applies across all repositories', scope: 'global' },
	],
	user: [
		{ label: 'This session', description: 'Only applies to the current session', scope: 'session' },
		{ label: 'This repository', description: 'Only applies to the current repository', scope: 'repo' },
	],
	repo_and_user: [
		{ label: 'This repository', description: 'Only applies to the current repository', scope: 'repo' },
	],
};

/**
 * Manages user preferences for session indexing (local vs cloud sync).
 *
 * Uses the vscode_askQuestions tool to show an inline consent UI in the
 * chat panel. The preference is persisted in globalState.
 */
export class SessionIndexingPreference {

	constructor(
		private readonly _extensionContext: IVSCodeExtensionContext,
	) { }

	/**
	 * Get the stored preference for a repository, or undefined if not set.
	 */
	getPreference(repoNwo: string): SessionIndexingLevel | undefined {
		const repoKey = `${PREF_KEY_PREFIX}${repoNwo}`;
		const repoPref = this._extensionContext.globalState.get<SessionIndexingLevel>(repoKey);
		if (repoPref) {
			return repoPref;
		}
		return this._extensionContext.globalState.get<SessionIndexingLevel>(PREF_KEY_GLOBAL);
	}

	/**
	 * Prompt the user inline in the chat panel using vscode_askQuestions.
	 * Requires a toolsService and toolInvocationToken from the chat request context.
	 *
	 * Returns the chosen level, or undefined if dismissed/skipped.
	 */
	async promptUserInline(
		repoNwo: string,
		toolsService: IToolsService,
		toolInvocationToken: vscode.ChatParticipantToolToken,
		token: CancellationToken,
	): Promise<SessionIndexingLevel | undefined> {
		try {
			// Step 1: Ask for storage level
			const levelResult = await toolsService.invokeTool(ToolName.CoreAskQuestions, {
				input: {
					questions: [{
						header: 'Session storage',
						question: l10n.t('Choose how your Copilot sessions are stored.'),
						options: LEVEL_OPTIONS.map(o => ({ label: o.label, description: o.description })),
						allowFreeformInput: false,
					}],
				},
				toolInvocationToken,
			}, token);

			const levelPart = levelResult.content.at(0);
			if (!(levelPart instanceof LanguageModelTextPart)) {
				return undefined;
			}
			const levelAnswers: IAnswerResult = JSON.parse(levelPart.value);
			const storageAnswer = levelAnswers.answers['Session storage'];
			if (!storageAnswer || storageAnswer.skipped || storageAnswer.selected.length === 0) {
				return undefined;
			}
			const selectedLabel = storageAnswer.selected[0];
			const level = LEVEL_OPTIONS.find(o => o.label === selectedLabel)?.level;
			if (!level) {
				return undefined;
			}

			// Step 2: Ask for scope (options depend on level)
			const scopeOptions = SCOPE_OPTIONS_BY_LEVEL[level];
			let scope: 'session' | 'repo' | 'global' = 'repo';

			if (scopeOptions.length > 1) {
				const scopeResult = await toolsService.invokeTool(ToolName.CoreAskQuestions, {
					input: {
						questions: [{
							header: 'Scope',
							question: l10n.t('What scope should this setting apply to?'),
							options: scopeOptions.map(o => ({ label: o.label, description: o.description })),
							allowFreeformInput: false,
						}],
					},
					toolInvocationToken,
				}, token);

				const scopePart = scopeResult.content.at(0);
				if (scopePart instanceof LanguageModelTextPart) {
					const scopeAnswers: IAnswerResult = JSON.parse(scopePart.value);
					const scopeAnswer = scopeAnswers.answers['Scope'];
					const scopeLabel = scopeAnswer?.selected?.[0];
					scope = scopeOptions.find(o => o.label === scopeLabel)?.scope ?? 'repo';
				}
			}
			// repo_and_user only has 'repo' scope — no need to ask

			if (scope === 'session') {
				// "This session" — don't persist, just return the level for this session
				return level;
			}

			await this._savePreference(repoNwo, scope === 'global' ? 'global' : 'repo', level);
			return level;
		} catch (err) {
			console.error('[SessionIndexingPreference] askQuestions failed:', err);
			return undefined;
		}
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

	/**
	 * Reset all session search consent preferences.
	 * Clears both repo-specific and global wildcard entries.
	 */
	async resetConsent(): Promise<void> {
		const keys = this._extensionContext.globalState.keys();
		for (const key of keys) {
			if (key.startsWith(PREF_KEY_PREFIX)) {
				await this._extensionContext.globalState.update(key, undefined);
			}
		}
	}
}
