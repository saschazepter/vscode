/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ISessionSyncStateService, type SessionSyncState } from '../common/sessionSyncStateService';

const statusTitle = 'Session Sync';
const sessionSyncDocsLink = 'https://code.visualstudio.com/docs/copilot/overview';

/**
 * Shows session sync status in the chat status bar popup.
 *
 * Renders a contributed chat status item that displays the current
 * cloud sync state — not enabled, on, syncing, up to date, error, etc.
 * Follows the same pattern as ChatStatusWorkspaceIndexingStatus.
 */
export class SessionSyncStatus extends Disposable {

	private readonly _statusItem: vscode.ChatStatusItem;

	constructor(
		private readonly _syncStateService: ISessionSyncStateService,
		private readonly _configService: IConfigurationService,
		private readonly _expService: IExperimentationService,
	) {
		super();

		this._statusItem = this._register(vscode.window.createChatStatusItem('copilot.sessionSyncStatus'));
		this._statusItem.title = statusTitle;

		// Listen for sync state changes
		this._register(this._syncStateService.onDidChangeSyncState(state => this._renderState(state)));

		// Listen for config changes to show/hide
		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('chat.localIndex.enabled')) {
				this._updateVisibility();
			}
		}));

		this._updateVisibility();
		this._renderState(this._syncStateService.syncState);
	}

	private _updateVisibility(): void {
		const localEnabled = this._configService.getExperimentBasedConfig(ConfigKey.LocalIndexEnabled, this._expService);
		if (!localEnabled) {
			this._statusItem.hide();
		} else {
			this._statusItem.show();
			this._renderState(this._syncStateService.syncState);
		}
	}

	private _renderState(state: SessionSyncState): void {
		// Don't render if localIndex is off — item should stay hidden
		const localEnabled = this._configService.getExperimentBasedConfig(ConfigKey.LocalIndexEnabled, this._expService);
		if (!localEnabled) {
			return;
		}

		this._statusItem.title = {
			label: statusTitle,
			link: sessionSyncDocsLink,
			helpText: 'Syncs session data to your GitHub.com account.',
		};

		// description → shown as badge in collapsed header (icon + message)
		// detail → shown when expanded
		const tipsAction = '[Get Tips from Sessions](command:workbench.action.chat.open?%7B%22query%22%3A%22%2Fchronicle%3Atips%22%7D)';

		switch (state.kind) {
			case 'not-enabled':
				this._statusItem.description = '$(circle-slash) Not enabled';
				this._statusItem.detail = '[Enable Session Sync](command:workbench.action.openSettings?%5B%22chat.sessionSync.enabled%22%5D)';
				break;

			case 'disabled-by-policy':
				this._statusItem.description = '$(warning) Disabled by policy';
				this._statusItem.detail = 'Session sync is disabled by your organization\'s policy.';
				break;

			case 'on':
				this._statusItem.description = '$(check) On';
				this._statusItem.detail = tipsAction;
				break;

			case 'syncing':
				this._statusItem.description = `Syncing ${state.sessionCount} session(s)\u2026 $(loading~spin)`;
				this._statusItem.detail = tipsAction;
				break;

			case 'up-to-date':
				this._statusItem.description = `$(check) ${state.syncedCount} sessions synced`;
				this._statusItem.detail = tipsAction;
				break;

			case 'deleting':
				this._statusItem.description = `Deleting ${state.sessionCount} session(s)\u2026 $(loading~spin)`;
				this._statusItem.detail = tipsAction;
				break;

			case 'error':
				this._statusItem.description = '$(warning) Sync failed';
				this._statusItem.detail = tipsAction;
				break;
		}
	}
}
