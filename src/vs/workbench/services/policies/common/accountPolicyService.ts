/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStringDictionary } from '../../../../base/common/collections.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { AbstractPolicyService, getRestrictedPolicyValue, IPolicyService, PolicyDefinition, PolicyValue } from '../../../../platform/policy/common/policy.js';
import { IDefaultAccountService } from '../../../../platform/defaultAccount/common/defaultAccount.js';

/**
 * Policy name (declared by `chat.approvedAccountOrganizations` in chat.contribution.ts)
 * holding the list of GitHub organization logins that satisfy the gate. Setting this
 * policy to a non-empty value activates the "Approved Account" gate; AI features are
 * forced off until the user signs into a GitHub account from an approved organization
 * AND the account-side policy data has resolved.
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

/**
 * Context key that is `true` while the Account Policy gate is active and not satisfied
 * (i.e. AI features are forced off until the user signs into an approved GitHub
 * organization). Defined here in the services layer so both the gate contribution and
 * `vs/workbench/contrib/chat` can use it without crossing layer boundaries.
 */
export const ChatAccountPolicyGateActiveContext = new RawContextKey<boolean>(
	'chatAccountPolicyGateActive',
	false,
	{ type: 'boolean', description: localize('chatAccountPolicyGateActive', "True when the 'Require Approved Account' policy is in effect and the user is not yet signed into an approved GitHub organization, so all AI features are disabled until they sign in.") }
);

/**
 * Read-only accessor for the Account Policy gate state. Backed by the same
 * `AccountPolicyService` instance that drives policy enforcement, so UX/observability
 * consumers (notifications, context keys, telemetry) cannot drift from the
 * authoritative gate decision.
 */
export const IAccountPolicyGateService = createDecorator<IAccountPolicyGateService>('accountPolicyGateService');
export interface IAccountPolicyGateService {
	readonly _serviceBrand: undefined;
	readonly gateInfo: IAccountPolicyGateInfo;
	readonly onDidChangeGateInfo: Event<IAccountPolicyGateInfo>;
}

export class AccountPolicyService extends AbstractPolicyService implements IPolicyService, IAccountPolicyGateService {

	declare readonly _serviceBrand: undefined;

	private _gateInfo: IAccountPolicyGateInfo = { state: AccountPolicyGateState.Inactive };
	get gateInfo(): IAccountPolicyGateInfo { return this._gateInfo; }

	private readonly _onDidChangeGateInfo = this._register(new Emitter<IAccountPolicyGateInfo>());
	readonly onDidChangeGateInfo = this._onDidChangeGateInfo.event;

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

		// Fail-closed boot ordering: the gate decision depends on the managed policy
		// service knowing about `ChatApprovedAccountOrganizations`. If we computed the
		// gate before the managed service had fetched its values (which is async on
		// desktop because it crosses an IPC boundary to the main process), the gate
		// would be evaluated as Inactive even when the admin has actually configured
		// it — leaving AI features briefly unrestricted at startup. Pushing the
		// definitions through the managed service first guarantees its values are
		// loaded before we decide. (The call is a no-op when no new definitions need
		// to be registered — see AbstractPolicyService.updatePolicyDefinitions.)
		if (this.managedPolicyService) {
			try {
				await this.managedPolicyService.updatePolicyDefinitions(policyDefinitions);
			} catch (err) {
				this.logService.error('AccountPolicyService#_updatePolicyDefinitions: managed policy service update failed; proceeding fail-closed.', err);
			}
		}

		const updated: string[] = [];
		const policyData = this.defaultAccountService.policyData;

		const previousInfo = this._gateInfo;
		this._gateInfo = this.computeGateInfo();
		const gateInfoChanged = previousInfo.state !== this._gateInfo.state || previousInfo.reason !== this._gateInfo.reason;
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
		if (gateInfoChanged) {
			this._onDidChangeGateInfo.fire(this._gateInfo);
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
	// `PolicyValue` is `string | number | boolean`, so even array-typed policies are
	// delivered to AbstractPolicyService as a JSON-stringified array (this mirrors
	// how `PolicyConfiguration.parse` normalises non-string-typed policy values).
	let value: unknown = raw;
	if (typeof value === 'string') {
		try { value = JSON.parse(value); } catch { /* not JSON — leave as-is */ }
	}
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((v): v is string => typeof v === 'string')
		.map(s => s.trim().toLowerCase())
		.filter(s => s.length > 0);
}
