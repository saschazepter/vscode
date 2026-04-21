/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IDefaultAccountService } from '../../../../platform/defaultAccount/common/defaultAccount.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { ChatConfiguration } from '../../../../workbench/contrib/chat/common/constants.js';
import { IChatEntitlementService } from '../../../../workbench/services/chat/common/chatEntitlementService.js';
import { ISessionsBlockedOverlayOptions, SessionsBlockedReason, SessionsPolicyBlockedOverlay } from './sessionsPolicyBlocked.js';
import { AccountPolicyGateState, AccountPolicyGateUnsatisfiedReason, ChatAccountPolicyGateActiveContext, IAccountPolicyGateInfo, IAccountPolicyGateService } from '../../../../workbench/services/policies/common/accountPolicyService.js';

type AccountPolicyGateStateEvent = {
	gateActive: boolean;
	gateSatisfied: boolean;
	reasonNotSatisfied: string | undefined;
};

type AccountPolicyGateStateClassification = {
	owner: 'joshspicer';
	comment: 'Tracks the Account Policy gate state for diagnosing account-driven restriction issues.';
	gateActive: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'True if an admin has activated the Approved Account gate (non-empty approved-organization list).' };
	gateSatisfied: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'True if the gate is satisfied (signed-in approved account with resolved policy).' };
	reasonNotSatisfied: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Bucketed reason the gate is unsatisfied: noAccount, wrongProvider, orgNotApproved, policyNotResolved.' };
};

export class SessionsPolicyBlockedContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessionsPolicyBlocked';

	private readonly overlayRef = this._register(new MutableDisposable());
	private readonly contextKey: IContextKey<boolean>;
	private lastGateInfo: IAccountPolicyGateInfo;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAccountPolicyGateService private readonly gateService: IAccountPolicyGateService,
		@IDefaultAccountService private readonly defaultAccountService: IDefaultAccountService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) {
		super();

		this.contextKey = ChatAccountPolicyGateActiveContext.bindTo(contextKeyService);
		this.lastGateInfo = this.gateService.gateInfo;

		this.update(/*forceTelemetry*/ true);

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ChatConfiguration.AgentEnabled)) {
				this.update(/*forceTelemetry*/ false);
			}
		}));

		this._register(this.gateService.onDidChangeGateInfo(() => this.update(/*forceTelemetry*/ false)));
	}

	private update(forceTelemetry: boolean): void {
		const gateInfo = this.gateService.gateInfo;
		const stateChanged = forceTelemetry || gateInfo.state !== this.lastGateInfo.state || gateInfo.reason !== this.lastGateInfo.reason;
		this.lastGateInfo = gateInfo;

		// Apply context key + setForceHidden for the gate (same logic as
		// the workbench-layer AccountPolicyGateContribution, which is NOT
		// imported in the sessions window).
		const isGateRestricted = gateInfo.state === AccountPolicyGateState.Restricted
			&& gateInfo.reason !== AccountPolicyGateUnsatisfiedReason.PolicyNotResolved;
		this.contextKey.set(isGateRestricted);
		this.chatEntitlementService.setForceHidden(isGateRestricted);
		this.logService.info(`[SessionsPolicyBlocked] gate: state=${gateInfo.state}, reason=${gateInfo.reason}, isRestricted=${isGateRestricted}`);

		if (stateChanged) {
			this.telemetryService.publicLog2<AccountPolicyGateStateEvent, AccountPolicyGateStateClassification>('accountPolicy.gateState', {
				gateActive: gateInfo.state !== AccountPolicyGateState.Inactive,
				gateSatisfied: gateInfo.state === AccountPolicyGateState.Satisfied,
				reasonNotSatisfied: gateInfo.reason,
			});
		}

		// --- Overlay logic ---

		// Priority 1: agent mode disabled by policy
		const agentEnabled = this.configurationService.getValue<boolean>(ChatConfiguration.AgentEnabled);
		if (agentEnabled === false) {
			this.showOverlay({ reason: SessionsBlockedReason.AgentDisabled });
			return;
		}

		// Priority 2: account policy gate is restricting access
		if (isGateRestricted) {
			const accountName = this.defaultAccountService.currentDefaultAccount?.accountName;
			this.showOverlay({
				reason: SessionsBlockedReason.AccountPolicyGate,
				approvedOrganizations: gateInfo.approvedOrganizations,
				accountName,
			});
			return;
		}

		// Not blocked
		this.overlayRef.clear();
	}

	private showOverlay(options: ISessionsBlockedOverlayOptions): void {
		// If AgentDisabled is already showing, don't recreate.
		if (this.overlayRef.value && options.reason === SessionsBlockedReason.AgentDisabled) {
			return;
		}
		// For account policy gate, always recreate to update messaging
		// (account name / org list may have changed).
		this.overlayRef.clear();

		this.overlayRef.value = this.instantiationService.createInstance(
			SessionsPolicyBlockedOverlay,
			this.layoutService.mainContainer,
			options,
		);
	}
}

registerWorkbenchContribution2(SessionsPolicyBlockedContribution.ID, SessionsPolicyBlockedContribution, WorkbenchPhase.BlockRestore);
