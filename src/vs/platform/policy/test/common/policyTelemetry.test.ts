/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { PolicyName } from '../../../../base/common/policy.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullTelemetryService } from '../../../../platform/telemetry/common/telemetryUtils.js';
import { AbstractPolicyService, PolicyDefinition, PolicyValue } from '../../common/policy.js';
import { PolicyTelemetryReporter } from '../../common/policyTelemetry.js';

class TestPolicyService extends AbstractPolicyService {
private readonly _testOnDidChange = new Emitter<readonly PolicyName[]>();
override readonly onDidChange = this._testOnDidChange.event;

constructor() {
super();
}

async setPolicyValue(name: PolicyName, value: PolicyValue): Promise<void> {
this.policies.set(name, value);
this._testOnDidChange.fire([name]);
}

async _updatePolicyDefinitions(policyDefinitions: { [name: string]: PolicyDefinition }): Promise<void> {
// No-op for test
}
}

suite('Policy Telemetry', () => {
const disposables = new DisposableStore();

ensureNoDisposablesAreLeakedInTestSuite();

teardown(() => {
disposables.clear();
});

test('reports initial snapshot of policies', async () => {
const policyService = disposables.add(new TestPolicyService());
const telemetryEvents: Array<{ name: string; data: any }> = [];

const telemetryService = {
...NullTelemetryService,
publicLog2(name: string, data: any) {
telemetryEvents.push({ name, data });
}
};

// Set up some initial policies
await policyService.setPolicyValue('TestPolicy1', 'value1');
await policyService.setPolicyValue('TestPolicy2', true);
await policyService.setPolicyValue('TestPolicy3', 42);

const reporter = disposables.add(new PolicyTelemetryReporter(policyService, telemetryService));
reporter.reportInitialSnapshot();

// Should have reported individual policy values
const policyValueSetEvents = telemetryEvents.filter(e => e.name === 'policyValueSet');
assert.strictEqual(policyValueSetEvents.length, 3, 'Should report 3 policy value set events');

// Should have reported a snapshot
const snapshotEvents = telemetryEvents.filter(e => e.name === 'policyConfigurationSnapshot');
assert.strictEqual(snapshotEvents.length, 1, 'Should report 1 snapshot event');
assert.strictEqual(snapshotEvents[0].data.count, 3, 'Snapshot should show 3 active policies');
});

test('reports policy changes', async () => {
const policyService = disposables.add(new TestPolicyService());
const telemetryEvents: Array<{ name: string; data: any }> = [];

const telemetryService = {
...NullTelemetryService,
publicLog2(name: string, data: any) {
telemetryEvents.push({ name, data });
}
};

const reporter = disposables.add(new PolicyTelemetryReporter(policyService, telemetryService));

// Change a policy value
await policyService.setPolicyValue('NewPolicy', 'newValue');

// Should have reported the change
const policyValueSetEvents = telemetryEvents.filter(e => e.name === 'policyValueSet');
assert.strictEqual(policyValueSetEvents.length, 1, 'Should report 1 policy change event');
assert.strictEqual(policyValueSetEvents[0].data.name, 'NewPolicy');
assert.strictEqual(policyValueSetEvents[0].data.hasValue, true);
assert.strictEqual(policyValueSetEvents[0].data.dataType, 'string');
});

test('reports correct data types', async () => {
const policyService = disposables.add(new TestPolicyService());
const telemetryEvents: Array<{ name: string; data: any }> = [];

const telemetryService = {
...NullTelemetryService,
publicLog2(name: string, data: any) {
telemetryEvents.push({ name, data });
}
};

const reporter = disposables.add(new PolicyTelemetryReporter(policyService, telemetryService));

// Test different types
await policyService.setPolicyValue('StringPolicy', 'test');
await policyService.setPolicyValue('NumberPolicy', 123);
await policyService.setPolicyValue('BooleanPolicy', false);

const events = telemetryEvents.filter(e => e.name === 'policyValueSet');
assert.strictEqual(events[0].data.dataType, 'string');
assert.strictEqual(events[1].data.dataType, 'number');
assert.strictEqual(events[2].data.dataType, 'boolean');
});
});
