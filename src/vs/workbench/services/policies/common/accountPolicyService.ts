/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStringDictionary } from '../../../../base/common/collections.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { AbstractPolicyService, IPolicyService, PolicyDefinition, PolicyValue } from '../../../../platform/policy/common/policy.js';
import { DefaultAccountService, IDefaultAccountService } from '../../accounts/common/defaultAccount.js';

export class AccountPolicyService extends AbstractPolicyService implements IPolicyService {

	constructor(
		@ILogService private readonly logService: ILogService,
		@IDefaultAccountService private readonly defaultAccountService: DefaultAccountService
	) {
		super();
	}

	protected async _updatePolicyDefinitions(policyDefinitions: IStringDictionary<PolicyDefinition>): Promise<void> {
		this.logService.info(`AccountPolicyService#_updatePolicyDefinitions: Got ${Object.keys(policyDefinitions).length} policy definitions`);
		try {
			const tmp = this.defaultAccountService.getDefaultAccount();
			if (tmp) {
				this.logService.info(`AccountPolicyService#_updatePolicyDefinitions - Default account: ${JSON.stringify(tmp)}`);
			} else {
				this.logService.info(`AccountPolicyService#_updatePolicyDefinitions - No default account found`);
			}
		} catch (e) {
			this.logService.error('AccountPolicyService#_updatePolicyDefinitions - Error getting default account:', e);
		}

		// TODO: Updates dummy values
		const dummyKeys: IStringDictionary<PolicyValue> = { 'chat.implicitContext.enabled': 'always', 'chat.experimental.detectParticipant.enabled': true };
		for (const key in dummyKeys) {
			const value = dummyKeys[key];

			if (value === undefined) {
				this.policies.delete(key);
			} else {
				this.policies.set(key, value);
			}
		}
	}
}
