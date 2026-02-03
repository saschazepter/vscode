/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { ExtHostChatAgents2 } from './extHostChatAgents2.js';

export const IExtHostHooks = createDecorator<IExtHostHooks>('IExtHostHooks');

export type ChatHookType = 'sessionStart' | 'userPromptSubmitted' | 'preToolUse' | 'postToolUse' | 'postToolUseFailure' | 'subagentStart' | 'subagentStop' | 'stop';

export interface IChatHookExecutionOptions {
	readonly hookType: ChatHookType;
	readonly input?: unknown;
	readonly toolInvocationToken: unknown;
}

export interface IChatHookResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface IExtHostHooks {
	initialize(extHostChatAgents: ExtHostChatAgents2): void;
	executeHook(extension: IExtensionDescription, options: IChatHookExecutionOptions, token?: CancellationToken): Promise<IChatHookResult[]>;
}
