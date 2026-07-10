/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { GitHubTelemetryNotification } from '@github/copilot-sdk';
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ITelemetryService, TelemetryLevel } from '../../../telemetry/common/telemetry.js';
import type { IAgentHostRestrictedTelemetry, TelemetryMeasurements, TelemetryProps } from '../../node/agentHostRestrictedTelemetry.js';
import { CopilotGitHubTelemetryForwarder } from '../../node/copilot/copilotGitHubTelemetryForwarder.js';

interface CapturedEvent {
	eventName: string;
	properties: TelemetryProps | undefined;
	measurements: TelemetryMeasurements | undefined;
}

class TestTelemetryService implements ITelemetryService, IAgentHostRestrictedTelemetry {
	declare readonly _serviceBrand: undefined;

	readonly telemetryLevel = TelemetryLevel.USAGE;
	readonly sendErrorTelemetry = true;
	readonly sessionId = 'sessionId';
	readonly machineId = 'machineId';
	readonly sqmId = 'sqmId';
	readonly devDeviceId = 'devDeviceId';
	readonly firstSessionDate = 'firstSessionDate';
	readonly standard: CapturedEvent[] = [];
	readonly restricted: CapturedEvent[] = [];

	publicLog(): void { }
	publicLogError(): void { }
	publicLog2(): void { }
	publicLogError2(): void { }
	setExperimentProperty(): void { }
	setCommonProperty(): void { }
	sendInternalMSFTTelemetryEvent(): void { }
	setCopilotTrackingId(): void { }
	setRestrictedTelemetryEndpoint(): void { }
	setRestrictedTelemetryEnabled(): void { }

	sendGHTelemetryEvent(eventName: string, properties?: TelemetryProps, measurements?: TelemetryMeasurements): void {
		this.standard.push({ eventName, properties, measurements });
	}

	sendEnhancedGHTelemetryEvent(eventName: string, properties?: TelemetryProps, measurements?: TelemetryMeasurements): void {
		this.restricted.push({ eventName, properties, measurements });
	}
}

suite('CopilotGitHubTelemetryForwarder', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('forwards a standard event with its native name and data', () => {
		const telemetryService = new TestTelemetryService();
		const forwarder = new CopilotGitHubTelemetryForwarder(() => false, telemetryService);

		forwarder.forward({
			sessionId: 'notification-session',
			restricted: false,
			event: {
				kind: 'tool_call_executed',
				created_at: '2026-07-10T12:00:00Z',
				model_call_id: 'model-call',
				properties: { tool_name: 'grep' },
				metrics: { duration_ms: 42 },
				exp_assignment_context: 'experiment',
				features: { featureA: 'enabled' },
				copilot_tracking_id: 'tracking-id',
				client: {
					cli_version: '1.0.69',
					os_platform: 'win32',
					os_version: '11',
					os_arch: 'x64',
					node_version: '24.0.0',
					is_staff: true,
				},
			},
		});

		assert.deepStrictEqual({
			standard: telemetryService.standard,
			restricted: telemetryService.restricted,
		}, {
			standard: [{
				eventName: 'tool_call_executed',
				properties: {
					cli_version: '1.0.69',
					os_platform: 'win32',
					os_version: '11',
					os_arch: 'x64',
					node_version: '24.0.0',
					is_staff: 'true',
					tool_name: 'grep',
					created_at: '2026-07-10T12:00:00Z',
					model_call_id: 'model-call',
					exp_assignment_context: 'experiment',
					session_id: 'notification-session',
					copilot_tracking_id: 'tracking-id',
					'feature.featureA': 'enabled',
				},
				measurements: { duration_ms: 42 },
			}],
			restricted: [],
		});
	});

	test('gates restricted events on the restricted telemetry option', () => {
		const telemetryService = new TestTelemetryService();
		let restrictedTelemetryEnabled = false;
		const forwarder = new CopilotGitHubTelemetryForwarder(() => restrictedTelemetryEnabled, telemetryService);
		const notification: GitHubTelemetryNotification = {
			sessionId: 'session',
			restricted: true,
			event: {
				kind: 'restricted_event',
				properties: {},
				metrics: {},
			},
		};

		forwarder.forward(notification);
		restrictedTelemetryEnabled = true;
		forwarder.forward(notification);

		assert.deepStrictEqual({
			standard: telemetryService.standard,
			restricted: telemetryService.restricted,
		}, {
			standard: [],
			restricted: [{
				eventName: 'restricted_event',
				properties: {
					created_at: undefined,
					model_call_id: undefined,
					exp_assignment_context: undefined,
					session_id: 'session',
					copilot_tracking_id: undefined,
					is_staff: undefined,
				},
				measurements: {},
			}],
		});
	});

	test('multiplexes oversized properties', () => {
		const telemetryService = new TestTelemetryService();
		const forwarder = new CopilotGitHubTelemetryForwarder(() => false, telemetryService);
		const value = 'x'.repeat(8193);

		forwarder.forward({
			sessionId: 'session',
			restricted: false,
			event: {
				kind: 'large_event',
				properties: { large: value },
				metrics: {},
			},
		});

		assert.deepStrictEqual(telemetryService.standard[0].properties, {
			large: value.slice(0, 8192),
			large_02: 'x',
			created_at: undefined,
			model_call_id: undefined,
			exp_assignment_context: undefined,
			session_id: 'session',
			copilot_tracking_id: undefined,
			is_staff: undefined,
		});
	});
});
