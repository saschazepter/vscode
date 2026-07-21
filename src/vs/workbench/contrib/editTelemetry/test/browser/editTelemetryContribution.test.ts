/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { ConfigurationTarget, IConfigurationChangeEvent } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ITelemetryService, TELEMETRY_CRASH_REPORTER_SETTING_ID, TELEMETRY_OLD_SETTING_ID, TELEMETRY_SETTING_ID, TelemetryLevel } from '../../../../../platform/telemetry/common/telemetry.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestChatEntitlementService } from '../../../../test/common/workbenchTestServices.js';
import { EditTelemetryContribution } from '../../browser/editTelemetryContribution.js';
import { VSCodeWorkspace } from '../../browser/helpers/vscodeObservableWorkspace.js';
import { AnnotatedDocuments } from '../../browser/helpers/annotatedDocuments.js';
import { EditTrackingFeature } from '../../browser/telemetry/editSourceTrackingFeature.js';
import { AiStatsFeature } from '../../browser/editStats/aiStatsFeature.js';

suite('Edit Telemetry Contribution', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('runs edit tracking only while usage telemetry is enabled', async () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		const configurationService = new TestConfigurationService();
		let telemetryLevel = TelemetryLevel.NONE;
		const telemetryService = instantiationService.stub(ITelemetryService, {
			get telemetryLevel() {
				return telemetryLevel;
			}
		});
		const feature = { dispose: sinon.spy() };

		instantiationService.stubInstance(VSCodeWorkspace, { dispose() { } });
		instantiationService.stubInstance(AnnotatedDocuments, { dispose() { } });
		instantiationService.stubInstance(EditTrackingFeature, feature);
		instantiationService.stubInstance(AiStatsFeature, { dispose() { } });
		const createInstanceSpy = sinon.spy(instantiationService, 'createInstance');

		const contribution = disposables.add(new EditTelemetryContribution(
			instantiationService,
			configurationService,
			telemetryService,
			new TestChatEntitlementService()
		));

		const getFeatureCreationCount = () => createInstanceSpy.getCalls().filter(call => call.args[0] === EditTrackingFeature).length;
		assert.deepStrictEqual({ creations: getFeatureCreationCount(), disposals: feature.dispose.callCount }, { creations: 0, disposals: 0 });

		telemetryLevel = TelemetryLevel.USAGE;
		fireTelemetryConfigurationChange(configurationService, TELEMETRY_SETTING_ID);
		assert.deepStrictEqual({ creations: getFeatureCreationCount(), disposals: feature.dispose.callCount }, { creations: 1, disposals: 0 });

		telemetryLevel = TelemetryLevel.NONE;
		fireTelemetryConfigurationChange(configurationService, TELEMETRY_CRASH_REPORTER_SETTING_ID);
		assert.deepStrictEqual({ creations: getFeatureCreationCount(), disposals: feature.dispose.callCount }, { creations: 1, disposals: 1 });

		telemetryLevel = TelemetryLevel.USAGE;
		fireTelemetryConfigurationChange(configurationService, TELEMETRY_OLD_SETTING_ID);
		assert.deepStrictEqual({ creations: getFeatureCreationCount(), disposals: feature.dispose.callCount }, { creations: 2, disposals: 1 });

		contribution.dispose();
	});
});

function fireTelemetryConfigurationChange(configurationService: TestConfigurationService, settingId: string): void {
	const event: IConfigurationChangeEvent = {
		source: ConfigurationTarget.USER,
		affectedKeys: new Set([settingId]),
		change: { keys: [settingId], overrides: [] },
		affectsConfiguration: key => key === settingId,
	};
	configurationService.onDidChangeConfigurationEmitter.fire(event);
}
