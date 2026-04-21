/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { DEFAULT_ACCOUNT_SIGN_IN_COMMAND } from '../../accounts/browser/defaultAccount.js';
import { AccountPolicyGateState, AccountPolicyGateUnsatisfiedReason, ChatAccountPolicyGateActiveContext, IAccountPolicyGateInfo, IAccountPolicyGateService } from '../common/accountPolicyService.js';

const NOTIFICATION_DISMISSED_KEY = 'accountPolicy.gateNotificationDismissed';

type AccountPolicyGateStateEvent = {
	gateActive: boolean;
	gateSatisfied: boolean;
	reasonNotSatisfied: string | undefined;
};

type AccountPolicyGateStateClassification = {
	owner: 'copilot';
	comment: 'Tracks the Account Policy gate state for diagnosing account-driven restriction issues. No PII (organization names are NOT logged).';
	gateActive: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'True if an admin has activated the Approved Account gate (non-empty approved-organization list).' };
	gateSatisfied: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'True if the gate is satisfied (signed-in approved account with resolved policy).' };
	reasonNotSatisfied: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Bucketed reason the gate is unsatisfied: noAccount, wrongProvider, orgNotApproved, policyNotResolved.' };
};

/**
 * Observes the Account Policy gate computed by `IAccountPolicyGateService` and:
 *   - mirrors the gate state into a workbench context key so welcome views/menus can react;
 *   - shows a notification with a Sign In action when the gate is active but unsatisfied;
 *   - emits telemetry whenever the gate state changes.
 *
 * The actual restriction of feature values lives in `AccountPolicyService` itself; this
 * contribution is a thin UX/observability adapter and does NOT re-evaluate the gate.
 */
export class AccountPolicyGateContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.accountPolicyGate';

	private readonly contextKey: IContextKey<boolean>;
	private lastInfo: IAccountPolicyGateInfo;

	private readonly notificationHandle = this._register(new MutableDisposable());
	private dismissedReason: AccountPolicyGateUnsatisfiedReason | undefined;

	constructor(
		@IAccountPolicyGateService private readonly gateService: IAccountPolicyGateService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IStorageService private readonly storageService: IStorageService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) {
		super();
		this.contextKey = ChatAccountPolicyGateActiveContext.bindTo(contextKeyService);
		this.lastInfo = this.gateService.gateInfo;

		// Seed any consumer that initialised before us (e.g. context-key when-clauses).
		this.apply(this.lastInfo, /*forceTelemetry*/ true);

		this._register(this.gateService.onDidChangeGateInfo(info => this.apply(info, /*forceTelemetry*/ false)));
	}

	private apply(info: IAccountPolicyGateInfo, forceTelemetry: boolean): void {
		const stateChanged = forceTelemetry || info.state !== this.lastInfo.state || info.reason !== this.lastInfo.reason;
		const reasonChanged = info.reason !== this.lastInfo.reason;
		this.lastInfo = info;

		// `policyNotResolved` is transient — the user IS in an approved org but account
		// data hasn't loaded yet. Don't set the context key for this state so the UI
		// stays visible (policies aren't being restricted either — see AccountPolicyService).
		const isRestricted = info.state === AccountPolicyGateState.Restricted
			&& info.reason !== AccountPolicyGateUnsatisfiedReason.PolicyNotResolved;
		this.contextKey.set(isRestricted);

		if (stateChanged) {
			this.telemetryService.publicLog2<AccountPolicyGateStateEvent, AccountPolicyGateStateClassification>('accountPolicy.gateState', {
				gateActive: info.state !== AccountPolicyGateState.Inactive,
				gateSatisfied: info.state === AccountPolicyGateState.Satisfied,
				reasonNotSatisfied: info.reason,
			});
		}

		if (info.state !== AccountPolicyGateState.Restricted) {
			// Gate is no longer restricting anything → close any open notification AND reset
			// the "Don't Show Again" preference so a later flip back to Restricted is visible
			// again. Also reset the in-memory dismissed-reason so reason transitions get a
			// fresh notification.
			this.notificationHandle.clear();
			this.dismissedReason = undefined;
			this.storageService.remove(NOTIFICATION_DISMISSED_KEY, StorageScope.APPLICATION);
			return;
		}

		// `policyNotResolved` is a transient boot-time state: the user IS signed into
		// an approved org but account-side data hasn't loaded yet. Don't show a
		// notification for this — it will resolve on its own within seconds.
		if (info.reason === AccountPolicyGateUnsatisfiedReason.PolicyNotResolved) {
			return;
		}

		// Restricted. Show or refresh the notification if the reason has changed since the
		// last shown/dismissed message. This covers cases like NoAccount → OrgNotApproved
		// where the user needs to see updated guidance.
		if (reasonChanged) {
			this.notificationHandle.clear();
			this.dismissedReason = undefined;
		}
		this.maybeShowNotification(info.reason);
	}

	private maybeShowNotification(reason: AccountPolicyGateUnsatisfiedReason | undefined): void {
		if (this.notificationHandle.value) {
			return; // already showing for this reason
		}
		if (this.dismissedReason === reason) {
			return; // user dismissed for this reason this session
		}
		const persistedDismissed = this.storageService.get(NOTIFICATION_DISMISSED_KEY, StorageScope.APPLICATION);
		if (persistedDismissed === (reason ?? '')) {
			return; // user clicked "Don't Show Again" for this same reason on this machine
		}

		const message = reason === AccountPolicyGateUnsatisfiedReason.OrgNotApproved
			? localize('accountPolicy.notification.org', "Your administrator requires sign-in with a GitHub account from an approved organization to use AI features.")
			: reason === AccountPolicyGateUnsatisfiedReason.PolicyNotResolved
				? localize('accountPolicy.notification.unresolved', "Waiting for your GitHub account policy to load before AI features can be enabled\u2026")
				: localize('accountPolicy.notification.signin', "Your administrator requires sign-in with an approved GitHub account to use AI features.");

		const handleDisposables = new DisposableStore();
		const handle = this.notificationService.prompt(
			Severity.Warning,
			message,
			[
				{
					label: localize('accountPolicy.notification.signin.action', "Sign In"),
					run: () => this.commandService.executeCommand(DEFAULT_ACCOUNT_SIGN_IN_COMMAND),
				},
				{
					label: localize('accountPolicy.notification.contactAdmin', "Contact Your Administrator"),
					run: () => { /* informational — no-op; the label itself is the guidance */ },
				},
				{
					label: localize('accountPolicy.notification.learnMore', "Learn More"),
					run: () => this.openerService.open(URI.parse('https://code.visualstudio.com/docs/enterprise/overview')),
				},
			],
			{ sticky: true }
		);

		// Capture which reason the toast is showing for so a manual close treats it as a
		// session-scoped dismissal — but only for THIS reason. A subsequent reason change
		// will reset `dismissedReason` and re-show.
		const reasonAtShow = reason;
		handleDisposables.add(handle.onDidClose(() => {
			this.dismissedReason = reasonAtShow;
			this.notificationHandle.clear();
		}));
		handleDisposables.add({ dispose: () => handle.close() });
		this.notificationHandle.value = handleDisposables;
	}
}
