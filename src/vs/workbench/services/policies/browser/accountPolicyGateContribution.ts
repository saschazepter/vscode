/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IDefaultAccountService } from '../../../../platform/defaultAccount/common/defaultAccount.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IPolicyService } from '../../../../platform/policy/common/policy.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ChatContextKeys } from '../../../contrib/chat/common/actions/chatContextKeys.js';
import { DEFAULT_ACCOUNT_SIGN_IN_COMMAND } from '../../accounts/browser/defaultAccount.js';
import { AccountPolicyGateState, AccountPolicyGateUnsatisfiedReason, APPROVED_ACCOUNT_ORGANIZATIONS_POLICY_NAME, IAccountPolicyGateInfo } from '../common/accountPolicyService.js';

const NOTIFICATION_DISMISSED_KEY = 'accountPolicy.gateNotificationDismissed';

type AccountPolicyGateStateEvent = {
	gateActive: boolean;
	gateSatisfied: boolean;
	reasonNotSatisfied: string | undefined;
};

type AccountPolicyGateStateClassification = {
	owner: 'copilot';
	comment: 'Tracks the Account Policy gate state for diagnosing account-driven restriction issues. No PII (organization names are NOT logged).';
	gateActive: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'True if the Require Approved Account policy is in effect.' };
	gateSatisfied: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'True if the gate is satisfied (signed-in approved account with resolved policy).' };
	reasonNotSatisfied: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Bucketed reason the gate is unsatisfied: noAccount, wrongProvider, orgNotApproved, policyNotResolved.' };
};

/**
 * Observes the inputs to the Account Policy gate (managed policy values + default account state)
 * and:
 *   - mirrors the gate state into a workbench context key so welcome views/menus can react;
 *   - shows a one-time notification with a Sign In action when the gate is active but unsatisfied;
 *   - emits telemetry whenever the gate state changes.
 *
 * The actual restriction of feature values lives in `AccountPolicyService` itself; this
 * contribution only handles UX/observability.
 */
export class AccountPolicyGateContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.accountPolicyGate';

	private readonly contextKey: IContextKey<boolean>;
	private lastInfo: IAccountPolicyGateInfo = { state: AccountPolicyGateState.Inactive };
	private readonly notificationHandle = this._register(new MutableDisposable());

	constructor(
		@IPolicyService private readonly policyService: IPolicyService,
		@IDefaultAccountService private readonly defaultAccountService: IDefaultAccountService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) {
		super();
		this.contextKey = ChatContextKeys.accountPolicyGateActive.bindTo(contextKeyService);

		this.update();
		this._register(this.policyService.onDidChange(names => {
			if (names.includes(APPROVED_ACCOUNT_ORGANIZATIONS_POLICY_NAME)) {
				this.update();
			}
		}));
		this._register(this.defaultAccountService.onDidChangeDefaultAccount(() => this.update()));
		this._register(this.defaultAccountService.onDidChangePolicyData(() => this.update()));
	}

	private update(): void {
		const info = this.computeGateInfo();
		const stateChanged = info.state !== this.lastInfo.state || info.reason !== this.lastInfo.reason;
		this.lastInfo = info;

		const isRestricted = info.state === AccountPolicyGateState.Restricted;
		this.contextKey.set(isRestricted);

		if (stateChanged) {
			this.telemetryService.publicLog2<AccountPolicyGateStateEvent, AccountPolicyGateStateClassification>('accountPolicy.gateState', {
				gateActive: info.state !== AccountPolicyGateState.Inactive,
				gateSatisfied: info.state === AccountPolicyGateState.Satisfied,
				reasonNotSatisfied: info.reason,
			});
		}

		if (isRestricted) {
			this.maybeShowNotification(info.reason);
		} else {
			this.notificationHandle.clear();
		}
	}

	private computeGateInfo(): IAccountPolicyGateInfo {
		const approvedRaw = this.policyService.getPolicyValue(APPROVED_ACCOUNT_ORGANIZATIONS_POLICY_NAME);
		const approved = typeof approvedRaw === 'string' ? approvedRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
		if (approved.length === 0) {
			return { state: AccountPolicyGateState.Inactive };
		}
		const account = this.defaultAccountService.currentDefaultAccount;
		if (!account) {
			return { state: AccountPolicyGateState.Restricted, reason: AccountPolicyGateUnsatisfiedReason.NoAccount };
		}
		const configuredProvider = this.defaultAccountService.getDefaultAccountAuthenticationProvider();
		if (account.authenticationProvider.id !== configuredProvider.id) {
			return { state: AccountPolicyGateState.Restricted, reason: AccountPolicyGateUnsatisfiedReason.WrongProvider };
		}
		if (this.defaultAccountService.policyData === null) {
			return { state: AccountPolicyGateState.Restricted, reason: AccountPolicyGateUnsatisfiedReason.PolicyNotResolved };
		}
		if (approved.includes('*')) {
			return { state: AccountPolicyGateState.Satisfied };
		}
		const orgs = (account.entitlementsData?.organization_login_list ?? []).map(o => o.toLowerCase());
		if (!orgs.some(o => approved.includes(o))) {
			return { state: AccountPolicyGateState.Restricted, reason: AccountPolicyGateUnsatisfiedReason.OrgNotApproved };
		}
		return { state: AccountPolicyGateState.Satisfied };
	}

	private maybeShowNotification(reason: AccountPolicyGateUnsatisfiedReason | undefined): void {
		if (this.notificationHandle.value) {
			return; // already showing
		}
		if (this.storageService.getBoolean(NOTIFICATION_DISMISSED_KEY, StorageScope.APPLICATION, false)) {
			return;
		}
		const message = reason === AccountPolicyGateUnsatisfiedReason.OrgNotApproved
			? localize('accountPolicy.notification.org', "Your administrator requires sign-in with a GitHub account from an approved organization to use AI features.")
			: reason === AccountPolicyGateUnsatisfiedReason.PolicyNotResolved
				? localize('accountPolicy.notification.unresolved', "Waiting for your GitHub account policy to load before AI features can be enabled\u2026")
				: localize('accountPolicy.notification.signin', "Your administrator requires sign-in with an approved GitHub account to use AI features.");

		const handle = this.notificationService.prompt(
			Severity.Warning,
			message,
			[
				{
					label: localize('accountPolicy.notification.signin.action', "Sign In"),
					run: () => this.commandService.executeCommand(DEFAULT_ACCOUNT_SIGN_IN_COMMAND),
				},
				{
					label: localize('accountPolicy.notification.dontShowAgain', "Don't Show Again"),
					run: () => this.storageService.store(NOTIFICATION_DISMISSED_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE),
				}
			],
			{ sticky: true }
		);
		this.notificationHandle.value = toDisposable(() => handle.close());
	}
}
