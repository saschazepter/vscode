/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStringDictionary } from '../../../../base/common/collections.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { AbstractPolicyService, getRestrictedPolicyValue, IPolicyService, PolicyDefinition, PolicyValue } from '../../../../platform/policy/common/policy.js';
import { IDefaultAccountService } from '../../../../platform/defaultAccount/common/defaultAccount.js';

/**
 * Policy name (declared by `chat.approvedAccountOrganizations` in chat.contribution.ts)
 * holding the comma-separated list of GitHub organization logins that satisfy the gate.
 * Setting this policy to a non-empty value activates the "Approved Account" gate; AI
 * features are forced off until the user signs into a GitHub account from an approved
 * organization AND the account-side policy data has resolved.
 *
 * The token `*` is a wildcard that accepts any signed-in GitHub/GHE account.
 */
export const APPROVED_ACCOUNT_ORGANIZATIONS_POLICY_NAME = 'ChatApprovedAccountOrganizations';

export const enum AccountPolicyGateState {
	/** Gate is not active. Policies behave exactly as account policy data dictates. */
	Inactive = 'inactive',
	/** Gate active and satisfied. Account policy values flow through normally. */
	Satisfied = 'satisfied',
	/** Gate active and NOT satisfied — restricted values are applied to all gated policies. */
	Restricted = 'restricted',
}

export const enum AccountPolicyGateUnsatisfiedReason {
	NoAccount = 'noAccount',
	WrongProvider = 'wrongProvider',
	OrgNotApproved = 'orgNotApproved',
	PolicyNotResolved = 'policyNotResolved',
}

export interface IAccountPolicyGateInfo {
	readonly state: AccountPolicyGateState;
	readonly reason?: AccountPolicyGateUnsatisfiedReason;
}

export class AccountPolicyService extends AbstractPolicyService implements IPolicyService {

	private _gateInfo: IAccountPolicyGateInfo = { state: AccountPolicyGateState.Inactive };
	get gateInfo(): IAccountPolicyGateInfo { return this._gateInfo; }

	constructor(
		@ILogService private readonly logService: ILogService,
		@IDefaultAccountService private readonly defaultAccountService: IDefaultAccountService,
		private readonly managedPolicyService?: IPolicyService,
	) {
		super();

		this._updatePolicyDefinitions(this.policyDefinitions);
		this._register(this.defaultAccountService.onDidChangePolicyData(() => {
			this._updatePolicyDefinitions(this.policyDefinitions);
		}));
		this._register(this.defaultAccountService.onDidChangeDefaultAccount(() => {
			this._updatePolicyDefinitions(this.policyDefinitions);
		}));
		if (this.managedPolicyService) {
			this._register(this.managedPolicyService.onDidChange(names => {
				if (names.includes(APPROVED_ACCOUNT_ORGANIZATIONS_POLICY_NAME)) {
					this._updatePolicyDefinitions(this.policyDefinitions);
				}
			}));
		}
	}

	protected async _updatePolicyDefinitions(policyDefinitions: IStringDictionary<PolicyDefinition>): Promise<void> {
		this.logService.trace(`AccountPolicyService#_updatePolicyDefinitions: Got ${Object.keys(policyDefinitions).length} policy definitions`);
		const updated: string[] = [];
		const policyData = this.defaultAccountService.policyData;

		this._gateInfo = this.computeGateInfo();
		const gateRestricted = this._gateInfo.state === AccountPolicyGateState.Restricted;

		for (const key in policyDefinitions) {
			const policy = policyDefinitions[key];

			let policyValue: PolicyValue | undefined;
			if (gateRestricted && (policy.value !== undefined || policy.restrictedValue !== undefined)) {
				// Only policies that opt into the gate are restricted: either by declaring an
				// account-side `value` (account-driven) or an explicit `restrictedValue`.
				// MDM-only policies (no `value`, no `restrictedValue`) — including the two policies
				// that DRIVE the gate itself — are left untouched so the admin remains in control.
				policyValue = getRestrictedPolicyValue(policy);
			} else if (policyData && policy.value) {
				policyValue = policy.value(policyData);
			}

			if (policyValue !== undefined) {
				if (this.policies.get(key) !== policyValue) {
					this.policies.set(key, policyValue);
					updated.push(key);
				}
			} else {
				if (this.policies.delete(key)) {
					updated.push(key);
				}
			}
		}

		if (updated.length) {
			this._onDidChange.fire(updated);
		}
	}

	private computeGateInfo(): IAccountPolicyGateInfo {
		if (!this.managedPolicyService) {
			return { state: AccountPolicyGateState.Inactive };
		}

		// Gate is active iff the admin has set a non-empty approved-organizations list.
		const approvedRaw = this.managedPolicyService.getPolicyValue(APPROVED_ACCOUNT_ORGANIZATIONS_POLICY_NAME);
		const approvedOrgs = parseApprovedOrganizations(approvedRaw);
		if (approvedOrgs.length === 0) {
			return { state: AccountPolicyGateState.Inactive };
		}

		const account = this.defaultAccountService.currentDefaultAccount;
		if (!account) {
			return { state: AccountPolicyGateState.Restricted, reason: AccountPolicyGateUnsatisfiedReason.NoAccount };
		}

		// Sign-in: provider id must match the configured GitHub (default or enterprise) provider.
		const configuredProvider = this.defaultAccountService.getDefaultAccountAuthenticationProvider();
		if (account.authenticationProvider.id !== configuredProvider.id) {
			return { state: AccountPolicyGateState.Restricted, reason: AccountPolicyGateUnsatisfiedReason.WrongProvider };
		}

		// Account-side policy data must have resolved (rules out the pre-fetch window).
		if (this.defaultAccountService.policyData === null) {
			return { state: AccountPolicyGateState.Restricted, reason: AccountPolicyGateUnsatisfiedReason.PolicyNotResolved };
		}

		if (approvedOrgs.includes('*')) {
			return { state: AccountPolicyGateState.Satisfied };
		}

		const accountOrgs = (account.entitlementsData?.organization_login_list ?? []).map(o => o.toLowerCase());
		const intersects = accountOrgs.some(org => approvedOrgs.includes(org));
		if (!intersects) {
			return { state: AccountPolicyGateState.Restricted, reason: AccountPolicyGateUnsatisfiedReason.OrgNotApproved };
		}

		return { state: AccountPolicyGateState.Satisfied };
	}
}

function parseApprovedOrganizations(raw: PolicyValue | undefined): string[] {
	if (typeof raw !== 'string' || raw.length === 0) {
		return [];
	}
	return raw
		.split(',')
		.map(s => s.trim().toLowerCase())
		.filter(s => s.length > 0);
}
