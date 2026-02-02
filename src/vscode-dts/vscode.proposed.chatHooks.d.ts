/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// version: 1

declare module 'vscode' {

	/**
	 * A single hook command configuration.
	 */
	export interface ChatHookCommand {
		readonly command: string;
		readonly cwd?: string;
		readonly env?: Record<string, string>;
		readonly timeoutSec?: number;
	}

	/**
	 * Collected hooks for a chat request, organized by hook type.
	 */
	export interface ChatRequestHooks {
		readonly sessionStart?: readonly ChatHookCommand[];
		readonly sessionEnd?: readonly ChatHookCommand[];
		readonly userPromptSubmitted?: readonly ChatHookCommand[];
		readonly preToolUse?: readonly ChatHookCommand[];
		readonly postToolUse?: readonly ChatHookCommand[];
		readonly errorOccurred?: readonly ChatHookCommand[];
	}

	export interface ChatRequest {
		/**
		 * Configured hooks for this chat request.
		 * These are collected from hooks.json files and can be used by the extension
		 * to execute commands at specific points in the agent workflow.
		 */
		readonly hooks?: ChatRequestHooks;
	}
}
