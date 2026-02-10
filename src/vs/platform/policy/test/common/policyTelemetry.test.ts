/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../base/common/event.js';
import { PolicyName } from '../../../../base/common/policy.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IPolicyService, PolicyDefinition, PolicyValue } from '../../common/policy.js';
import { PolicyTelemetryReporter } from '../../common/policyTelemetry.js';
import { ITelemetryService } from '../../../telemetry/common/telemetry.js';
import { IStringDictionary } from '../../../../base/common/collections.js';

suite('Policy Telemetry Reporter', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	let capturedEvents: Array<{ eventName: string; data: any }>;

	class MockPolicyService implements IPolicyService {
		readonly _serviceBrand: undefined;
		readonly onDidChange = new Emitter<readonly PolicyName[]>().event;
		policyDefinitions: IStringDictionary<PolicyDefinition> = {};
		private values = new Map<PolicyName, PolicyValue>();

		async updatePolicyDefinitions(defs: IStringDictionary<PolicyDefinition>) {
			this.policyDefinitions = defs;
			return {};
		}

		getPolicyValue(name: PolicyName): PolicyValue | undefined {
			return this.values.get(name);
		}

		serialize() {
			const result: IStringDictionary<{ definition: PolicyDefinition; value: PolicyValue }> = {};
			for (const name in this.policyDefinitions) {
				const val = this.values.get(name);
				if (val !== undefined) {
					result[name] = { definition: this.policyDefinitions[name], value: val };
				}
			}
			return result;
		}

		// Test helpers
		setValue(name: PolicyName, val: PolicyValue) {
			this.values.set(name, val);
		}

		triggerChange(names: readonly PolicyName[]) {
			(this.onDidChange as any as Emitter<readonly PolicyName[]>).fire(names);
		}
	}

	class MockTelemetryService implements ITelemetryService {
		readonly _serviceBrand: undefined;
		telemetryLevel = 3;
		sessionId = 'test';
		machineId = 'test';
		sqmId = 'test';
		devDeviceId = 'test';
		firstSessionDate = 'test';
		sendErrorTelemetry = true;

		publicLog(eventName: string, data?: any) {
			capturedEvents.push({ eventName, data });
		}

		publicLog2(eventName: string, data?: any) {
			capturedEvents.push({ eventName, data });
		}

		publicLogError(eventName: string, data?: any) {
			capturedEvents.push({ eventName, data });
		}

		publicLogError2(eventName: string, data?: any) {
			capturedEvents.push({ eventName, data });
		}

		setExperimentProperty() { }
	}

	setup(() => {
		capturedEvents = [];
	});

	test('should report initial policies on startup', () => {
		const mockPolicy = new MockPolicyService();
		mockPolicy.policyDefinitions = {
			'TestPolicy1': { type: 'string' },
			'TestPolicy2': { type: 'boolean' }
		};
		mockPolicy.setValue('TestPolicy1', 'value1');
		mockPolicy.setValue('TestPolicy2', true);

		const mockTelemetry = new MockTelemetryService();
		const reporter = disposables.add(new PolicyTelemetryReporter(mockPolicy, mockTelemetry));

		reporter.reportInitialPolicies();

		assert.strictEqual(capturedEvents.length, 2, 'Should report two policies');
		assert.strictEqual(capturedEvents[0].eventName, 'policyValue');
		assert.strictEqual(capturedEvents[0].data.policyName, 'TestPolicy1');
		assert.strictEqual(capturedEvents[0].data.isSet, true);
	});

	test('should report when policy changes', () => {
		const mockPolicy = new MockPolicyService();
		mockPolicy.policyDefinitions = {
			'ChangingPolicy': { type: 'number' }
		};

		const mockTelemetry = new MockTelemetryService();
		disposables.add(new PolicyTelemetryReporter(mockPolicy, mockTelemetry));

		mockPolicy.setValue('ChangingPolicy', 42);
		mockPolicy.triggerChange(['ChangingPolicy']);

		assert.strictEqual(capturedEvents.length, 1);
		assert.strictEqual(capturedEvents[0].data.policyName, 'ChangingPolicy');
		assert.strictEqual(capturedEvents[0].data.valueType, 'number');
	});

	test('should report when policy is cleared', () => {
		const mockPolicy = new MockPolicyService();
		mockPolicy.policyDefinitions = {
			'ClearedPolicy': { type: 'string' }
		};

		const mockTelemetry = new MockTelemetryService();
		disposables.add(new PolicyTelemetryReporter(mockPolicy, mockTelemetry));

		mockPolicy.triggerChange(['ClearedPolicy']);

		assert.strictEqual(capturedEvents.length, 1);
		assert.strictEqual(capturedEvents[0].data.isSet, false);
	});

	test('should not report undefined policies', () => {
		const mockPolicy = new MockPolicyService();
		const mockTelemetry = new MockTelemetryService();
		disposables.add(new PolicyTelemetryReporter(mockPolicy, mockTelemetry));

		mockPolicy.triggerChange(['UndefinedPolicy']);

		assert.strictEqual(capturedEvents.length, 0, 'Should not report undefined policies');
	});
});
