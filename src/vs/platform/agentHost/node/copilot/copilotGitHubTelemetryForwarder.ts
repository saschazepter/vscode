/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { GitHubTelemetryNotification } from '@github/copilot-sdk';
import { ITelemetryData, ITelemetryService } from '../../../telemetry/common/telemetry.js';

/**
 * Re-emits GitHub-shaped telemetry events forwarded by the Copilot CLI runtime
 * (via the SDK's `onGitHubTelemetry` connection-global callback) through VS
 * Code's {@link ITelemetryService} so they land in the same first-party
 * Microsoft cluster/database as the rest of the agent host's telemetry.
 *
 * Restricted events (`cli.restricted_telemetry`) are only forwarded when
 * restricted telemetry is enabled for the current Copilot token; standard
 * events always flow through.
 */
export class CopilotGitHubTelemetryForwarder {

	constructor(
		private readonly _isRestrictedTelemetryEnabled: () => boolean,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) { }

	forward(notification: GitHubTelemetryNotification): void {
		// The runtime marks enhanced/restricted events which must only be routed
		// to first-party Microsoft stores and only when the user has opted in.
		if (notification.restricted && !this._isRestrictedTelemetryEnabled()) {
			return;
		}

		const event = notification.event;

		// The event's own `properties` (strings) and `metrics` (numbers) carry the
		// payload; the telemetry appender routes them to properties/measurements by
		// value type. Contextual metadata is added under distinct keys.
		const data: ITelemetryData = {
			...event.properties,
			...event.metrics,
			githubSessionId: notification.sessionId,
			restricted: notification.restricted,
			kind: event.kind,
			createdAt: event.created_at,
			modelCallId: event.model_call_id,
			expAssignmentContext: event.exp_assignment_context,
			eventSessionId: event.session_id,
			copilotTrackingId: event.copilot_tracking_id,
		};

		const client = event.client;
		if (client) {
			data.cliVersion = client.cli_version;
			data.osPlatform = client.os_platform;
			data.osVersion = client.os_version;
			data.osArch = client.os_arch;
			data.nodeVersion = client.node_version;
			data.copilotPlan = client.copilot_plan;
			data.clientType = client.client_type;
			data.clientName = client.client_name;
			data.isStaff = client.is_staff;
			data.devDeviceId = client.dev_device_id;
		}

		if (event.features) {
			for (const [key, value] of Object.entries(event.features)) {
				if (value !== undefined) {
					data[`feature.${key}`] = value;
				}
			}
		}

		this._telemetryService.publicLog(`copilotCli/${event.kind}`, data);
	}
}
