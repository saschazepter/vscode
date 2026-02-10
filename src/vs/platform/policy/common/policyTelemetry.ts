/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { IPolicyService, PolicyValue } from './policy.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { PolicyName } from '../../../base/common/policy.js';

type PolicyValueTelemetryEvent = {
	policyName: string;
	valueType: 'string' | 'number' | 'boolean';
	isSet: boolean;
};

type PolicyValueTelemetryClassification = {
	policyName: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The name of the policy that was set or changed.' };
	valueType: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The type of value for this policy (string, number, or boolean).' };
	isSet: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Whether the policy has a value set (true) or was cleared (false).' };
	owner: 'hediet';
	comment: 'Reports when policy values are configured or changed to understand which policies are used most frequently.';
};

/**
 * Observes policy changes and reports telemetry about which policies are being used.
 */
export class PolicyTelemetryReporter extends Disposable {

	constructor(
		private readonly policyService: IPolicyService,
		private readonly telemetryService: ITelemetryService
	) {
		super();
		this._register(this.policyService.onDidChange(changedPolicies => this.reportPolicyChanges(changedPolicies)));
	}

	private reportPolicyChanges(changedPolicies: readonly PolicyName[]): void {
		for (const policyName of changedPolicies) {
			const value = this.policyService.getPolicyValue(policyName);
			const definition = this.policyService.policyDefinitions[policyName];
			
			if (!definition) {
				continue;
			}

			this.telemetryService.publicLog2<PolicyValueTelemetryEvent, PolicyValueTelemetryClassification>('policyValue', {
				policyName,
				valueType: definition.type,
				isSet: value !== undefined
			});
		}
	}

	/**
	 * Reports the initial state of all configured policies.
	 * Should be called after policy service initialization.
	 */
	reportInitialPolicies(): void {
		const serialized = this.policyService.serialize();
		if (!serialized) {
			return;
		}

		for (const policyName in serialized) {
			const { definition, value } = serialized[policyName];
			if (value !== undefined) {
				this.telemetryService.publicLog2<PolicyValueTelemetryEvent, PolicyValueTelemetryClassification>('policyValue', {
					policyName,
					valueType: definition.type,
					isSet: true
				});
			}
		}
	}
}
