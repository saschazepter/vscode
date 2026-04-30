/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { createSchema, schemaProperty } from './agentHostSchema.js';
import { type CustomizationRef } from './state/protocol/state.js';

/**
 * Well-known root-config keys used by the platform to configure agent-host
 * customizations.
 */
export const enum AgentHostConfigKey {
	/** Host-owned Open Plugins available to remote sessions. */
	Customizations = 'customizations',
	/**
	 * Absolute path to the shell executable used by host-managed terminals
	 * (e.g. the PTY-backed `bash`/`powershell` tools that override the
	 * Copilot CLI built-ins). Typically populated by the host's client from
	 * the user's terminal profile (e.g. `terminal.integrated.agentHostProfile.<os>`
	 * with fallback to `terminal.integrated.defaultProfile.<os>`). When unset,
	 * the agent host auto-detects the preferred system shell — on Windows
	 * this prefers PowerShell 7 (`pwsh.exe`) over Windows PowerShell 5.1.
	 */
	DefaultShell = 'defaultShell',
}

export const agentHostCustomizationConfigSchema = createSchema({
	[AgentHostConfigKey.Customizations]: schemaProperty<CustomizationRef[]>({
		type: 'array',
		title: localize('agentHost.config.customizations.title', "Plugins"),
		description: localize('agentHost.config.customizations.description', "Plugins configured on this agent host and available to remote sessions."),
		default: [],
		items: {
			type: 'object',
			title: localize('agentHost.config.customizations.itemTitle', "Plugin"),
			properties: {
				uri: {
					type: 'string',
					title: localize('agentHost.config.customizations.uri', "Plugin URI"),
				},
				displayName: {
					type: 'string',
					title: localize('agentHost.config.customizations.displayName', "Name"),
				},
				description: {
					type: 'string',
					title: localize('agentHost.config.customizations.descriptionField', "Description"),
				},
			},
			required: ['uri', 'displayName'],
		},
	}),
	[AgentHostConfigKey.DefaultShell]: schemaProperty<string>({
		type: 'string',
		title: localize('agentHost.config.defaultShell.title', "Default Shell"),
		description: localize('agentHost.config.defaultShell.description', "Absolute path to the shell executable used by host-managed terminals. Normally managed by the connected VS Code client based on terminal profile settings; advanced users running a headless agent host may set this directly."),
	}),
});

export const defaultAgentHostCustomizationConfigValues = {
	[AgentHostConfigKey.Customizations]: [] as CustomizationRef[],
};

export function getAgentHostConfiguredCustomizations(values: Record<string, unknown> | undefined): readonly CustomizationRef[] {
	const raw = values?.[AgentHostConfigKey.Customizations];
	return agentHostCustomizationConfigSchema.validate(AgentHostConfigKey.Customizations, raw)
		? raw
		: defaultAgentHostCustomizationConfigValues[AgentHostConfigKey.Customizations];
}
