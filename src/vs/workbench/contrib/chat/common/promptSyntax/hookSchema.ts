/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IJSONSchema } from '../../../../../base/common/jsonSchema.js';
import * as nls from '../../../../../nls.js';

/**
 * JSON Schema for GitHub Copilot hook configuration files.
 * Hooks enable executing custom shell commands at strategic points in an agent's workflow.
 * @see https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-hooks
 */

const hookCommandSchema: IJSONSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['type'],
	anyOf: [
		{ required: ['command'] },
		{ required: ['bash'] },
		{ required: ['powershell'] }
	],
	errorMessage: nls.localize('hook.commandRequired', 'At least one of "command", "bash", or "powershell" must be specified.'),
	properties: {
		type: {
			type: 'string',
			enum: ['command'],
			description: nls.localize('hook.type', 'Must be "command".')
		},
		command: {
			type: 'string',
			description: nls.localize('hook.command', 'The command to execute. This is the recommended way to specify commands and works cross-platform.')
		},
		bash: {
			type: 'string',
			description: nls.localize('hook.bash', 'Path to a bash script or an inline bash command. Use for Unix-specific commands when cross-platform "command" is not sufficient.')
		},
		powershell: {
			type: 'string',
			description: nls.localize('hook.powershell', 'Path to a PowerShell script or an inline PowerShell command. Use for Windows-specific commands when cross-platform "command" is not sufficient.')
		},
		cwd: {
			type: 'string',
			description: nls.localize('hook.cwd', 'Working directory for the script (relative to repository root).')
		},
		env: {
			type: 'object',
			additionalProperties: { type: 'string' },
			description: nls.localize('hook.env', 'Additional environment variables that are merged with the existing environment.')
		},
		timeoutSec: {
			type: 'number',
			default: 30,
			description: nls.localize('hook.timeoutSec', 'Maximum execution time in seconds (default: 30).')
		}
	}
};

const hookArraySchema: IJSONSchema = {
	type: 'array',
	items: hookCommandSchema
};

export const hookFileSchema: IJSONSchema = {
	$schema: 'http://json-schema.org/draft-07/schema#',
	type: 'object',
	description: nls.localize('hookFile.description', 'GitHub Copilot hook configuration file. Hooks enable executing custom shell commands at strategic points in an agent\'s workflow.'),
	additionalProperties: false,
	required: ['version', 'hooks'],
	properties: {
		version: {
			type: 'number',
			enum: [1],
			description: nls.localize('hookFile.version', 'Schema version. Must be 1.')
		},
		hooks: {
			type: 'object',
			description: nls.localize('hookFile.hooks', 'Hook definitions organized by type.'),
			additionalProperties: false,
			properties: {
				sessionStart: {
					...hookArraySchema,
					description: nls.localize('hookFile.sessionStart', 'Executed when a new agent session begins or when resuming an existing session. Use to initialize environments, log session starts, validate project state, or set up temporary resources.')
				},
				sessionEnd: {
					...hookArraySchema,
					description: nls.localize('hookFile.sessionEnd', 'Executed when the agent session completes or is terminated. Use to cleanup temporary resources, generate reports and logs, or send notifications.')
				},
				userPromptSubmitted: {
					...hookArraySchema,
					description: nls.localize('hookFile.userPromptSubmitted', 'Executed when the user submits a prompt to the agent. Use to log user requests for auditing and usage analysis.')
				},
				preToolUse: {
					...hookArraySchema,
					description: nls.localize('hookFile.preToolUse', 'Executed before the agent uses any tool (such as bash, edit, view). This is the most powerful hook as it can approve or deny tool executions. Use to block dangerous commands, enforce security policies, require approval for sensitive operations, or log tool usage.')
				},
				postToolUse: {
					...hookArraySchema,
					description: nls.localize('hookFile.postToolUse', 'Executed after a tool completes execution (whether successful or failed). Use to log execution results, track usage statistics, generate audit trails, monitor performance, or send failure alerts.')
				},
				errorOccurred: {
					...hookArraySchema,
					description: nls.localize('hookFile.errorOccurred', 'Executed when an error occurs during agent execution. Use to log errors for debugging, send notifications, track error patterns, or generate reports.')
				}
			}
		}
	},
	defaultSnippets: [
		{
			label: nls.localize('hookFile.snippet.basic', 'Basic hook configuration'),
			description: nls.localize('hookFile.snippet.basic.description', 'A basic hook configuration with common hooks'),
			body: {
				version: 1,
				hooks: {
					sessionStart: [
						{
							type: 'command',
							command: '${1:echo "Session started"}'
						}
					],
					preToolUse: [
						{
							type: 'command',
							command: '${2:./scripts/validate.sh}',
							timeoutSec: 15
						}
					]
				}
			}
		}
	]
};

/**
 * URI for the hook schema registration.
 */
export const HOOK_SCHEMA_URI = 'vscode://schemas/hooks';

/**
 * Glob pattern for hook files.
 */
export const HOOK_FILE_GLOB = '**/.github/hooks/*.json';
