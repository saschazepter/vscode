/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { GitHubTelemetryNotification } from '@github/copilot-sdk';
import { ITelemetryService } from '../../../telemetry/common/telemetry.js';
import { multiplexProperties, type IAgentHostRestrictedTelemetry, type TelemetryProps } from '../agentHostRestrictedTelemetry.js';

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
		if (notification.restricted && !this._isRestrictedTelemetryEnabled()) {
			return;
		}

		const telemetry = this._restrictedTelemetry;
		if (!telemetry) {
			return;
		}

		const event = notification.event;
		const properties: TelemetryProps = {
			...event.client,
			...event.properties,
			created_at: event.created_at,
			model_call_id: event.model_call_id,
			exp_assignment_context: event.exp_assignment_context,
			session_id: event.session_id ?? notification.sessionId,
			copilot_tracking_id: event.copilot_tracking_id,
			is_staff: event.client?.is_staff === undefined ? undefined : String(event.client.is_staff),
		};

		if (event.features) {
			for (const [key, value] of Object.entries(event.features)) {
				if (value !== undefined) {
					properties[`feature.${key}`] = value;
				}
			}
		}

		const multiplexedProperties = multiplexProperties(properties);
		if (notification.restricted) {
			telemetry.sendEnhancedGHTelemetryEvent(event.kind, multiplexedProperties, event.metrics);
		} else {
			telemetry.sendGHTelemetryEvent(event.kind, multiplexedProperties, event.metrics);
		}
	}

	private get _restrictedTelemetry(): IAgentHostRestrictedTelemetry | undefined {
		const telemetry = this._telemetryService as Partial<IAgentHostRestrictedTelemetry>;
		return typeof telemetry.sendGHTelemetryEvent === 'function' ? telemetry as IAgentHostRestrictedTelemetry : undefined;
	}
}
