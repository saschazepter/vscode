/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	export namespace env {
		/**
		 * Sets an experiment property that will be attached to all telemetry events
		 * sent by the host application. This is intended for trusted built-in
		 * extensions that need to propagate server-side experiment assignments to the
		 * host telemetry pipeline.
		 *
		 * @param name The property name (e.g., 'capi.assignmentcontext')
		 * @param value The property value
		 */
		export function setTelemetryExperimentProperty(name: string, value: string): void;
	}
}
