/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IChatQuotaService, IRateLimitWarning } from '../../../platform/chat/common/chatQuotaService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

const QUOTA_NOTIFICATION_ID = 'copilot.quotaStatus';

/**
 * Manages chat input notifications for quota and rate limit status.
 *
 * - Pushes an **error** notification when the quota is fully exhausted.
 * - Pushes an **info** or **warning** notification when a rate-limit threshold is crossed.
 * - All notifications are dismissible and auto-dismiss on the next message.
 */
export class ChatInputNotificationContribution extends Disposable {

	private _notification: vscode.ChatInputNotification | undefined;

	constructor(
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@IChatQuotaService private readonly _chatQuotaService: IChatQuotaService,
	) {
		super();

		// DEBUG: Show a test notification immediately so the UI can be verified.
		// Remove this block and the _debugTest flag before merging.
		this._debugTest = true;
		this._register(this._authService.onDidAuthenticationChange(() => this._updateQuotaNotification()));
		{
			const test = this._ensureNotification();
			test.severity = vscode.ChatInputNotificationSeverity.Warning;
			test.message = 'Monthly Budget';
			test.progress = 75;
			test.detail = 'Resets May 1 at 10:00 AM';
			test.description = 'Copilot will pause when the monthly budget is reached.';
			test.dismissible = true;
			test.autoDismissOnMessage = true;
			test.actions = [
				{ label: 'View Usage', commandId: 'workbench.action.chat.openQuotaDashboard' },
			];
			test.show();
		}
	}

	// DEBUG: set to true to prevent _updateQuotaNotification from hiding the test notification
	private _debugTest = false;

	/**
	 * Called after each chat request completes to check for rate limit warnings.
	 */
	pushRateLimitWarningIfNeeded(): void {
		const warning = this._chatQuotaService.consumeRateLimitWarning();
		if (warning) {
			this._showRateLimitWarning(warning);
		}
	}

	private _updateQuotaNotification(): void {
		if (this._debugTest) { return; } // DEBUG: skip real logic while testing UI
		if (!this._chatQuotaService.quotaExhausted) {
			// Quota is not exhausted — remove the error notification if present
			this._disposeNotification();
			return;
		}

		const isAnonymous = this._authService.copilotToken?.isNoAuthUser;
		const isFree = this._authService.copilotToken?.isFreeUser;

		if (!isAnonymous && !isFree) {
			// Only show quota exhausted notification for anonymous/free users
			return;
		}

		const notification = this._ensureNotification();

		notification.severity = vscode.ChatInputNotificationSeverity.Error;
		notification.dismissible = true;
		notification.autoDismissOnMessage = false;

		if (isAnonymous) {
			notification.message = vscode.l10n.t("You've reached the limit for chat messages. Sign in to use Copilot Free.");
			notification.actions = [{
				label: vscode.l10n.t('Sign In'),
				commandId: 'workbench.action.chat.triggerSetup',
			}];
		} else {
			notification.message = vscode.l10n.t("You've reached the limit for chat messages.");
			notification.actions = [{
				label: vscode.l10n.t('Upgrade'),
				commandId: 'workbench.action.chat.upgradePlan',
			}];
		}

		notification.show();
	}

	private _showRateLimitWarning(warning: IRateLimitWarning): void {
		const notification = this._ensureNotification();

		const resetDate = warning.resetDate;
		const now = new Date();
		const includeYear = resetDate.getFullYear() !== now.getFullYear();
		const dateStr = new Intl.DateTimeFormat(undefined, includeYear
			? { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
			: { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }
		).format(resetDate);

		const severity = warning.percentUsed >= 90
			? vscode.ChatInputNotificationSeverity.Warning
			: vscode.ChatInputNotificationSeverity.Info;

		notification.severity = severity;
		notification.dismissible = true;
		notification.autoDismissOnMessage = true;

		notification.message = warning.type === 'session'
			? vscode.l10n.t("You've used {0}% of your session rate limit. Resets on {1}.", warning.percentUsed, dateStr)
			: vscode.l10n.t("You've used {0}% of your weekly rate limit. Resets on {1}.", warning.percentUsed, dateStr);

		notification.actions = [];
		notification.show();
	}

	private _ensureNotification(): vscode.ChatInputNotification {
		if (!this._notification) {
			this._notification = vscode.chat.createInputNotification(QUOTA_NOTIFICATION_ID);
			this._register({ dispose: () => this._notification?.dispose() });
		}
		return this._notification;
	}

	private _disposeNotification(): void {
		if (this._notification) {
			this._notification.hide();
		}
	}
}
