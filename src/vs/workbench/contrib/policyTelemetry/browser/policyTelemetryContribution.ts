/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IPolicyService } from '../../../../platform/policy/common/policy.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { PolicyTelemetryReporter } from '../../../../platform/policy/common/policyTelemetry.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

export class PolicyTelemetryContribution extends Disposable {
static readonly ID = 'workbench.contrib.policyTelemetry';

constructor(
@IInstantiationService instantiationService: IInstantiationService,
@IPolicyService policyService: IPolicyService,
@ITelemetryService telemetryService: ITelemetryService
) {
super();

const reporter = this._register(instantiationService.createInstance(PolicyTelemetryReporter, policyService, telemetryService));
reporter.reportInitialSnapshot();
}
}
