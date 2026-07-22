/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ITelemetryService } from '../../telemetry/common/telemetry.js';

export type AgentHostProcessErrorEvent = {
	kind: 'unexpectedExit' | 'startFailed';
	code?: number;
	restartCount: number;
	willRestart: boolean;
};

type AgentHostProcessErrorClassification = {
	kind: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The kind of agent host process failure.' };
	code?: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; isMeasurement: true; comment: 'The agent host process exit code, when available.' };
	restartCount: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; isMeasurement: true; comment: 'The number of agent host restart attempts before this failure.' };
	willRestart: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'Whether VS Code will attempt to restart the agent host after this failure.' };
	owner: 'bryanchen-d';
	comment: 'Tracks agent host process failures that cannot be reported reliably from inside the agent host process.';
};

export function reportAgentHostProcessError(telemetryService: ITelemetryService, data: AgentHostProcessErrorEvent): void {
	telemetryService.publicLogError2<AgentHostProcessErrorEvent, AgentHostProcessErrorClassification>('agentHost.processError', data);
}
