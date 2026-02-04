/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { UriComponents } from '../../../base/common/uri.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IHookResult } from '../../contrib/chat/common/hooksExecutionService.js';
import { HookTypeValue } from '../../contrib/chat/common/promptSyntax/hookSchema.js';
import { ExtHostHooksShape, IHookResultDto } from './extHost.protocol.js';
import { ExtHostChatAgents2 } from './extHostChatAgents2.js';

export const IExtHostHooks = createDecorator<IExtHostHooks>('IExtHostHooks');

export interface IChatHookExecutionOptions {
	readonly input?: unknown;
	readonly toolInvocationToken: unknown;
}

export interface IExtHostHooks extends ExtHostHooksShape {
	initialize(extHostChatAgents: ExtHostChatAgents2): void;
	executeHook(hookType: HookTypeValue, options: IChatHookExecutionOptions, token?: CancellationToken): Promise<IHookResult[]>;
	$executeHook(hookType: string, sessionResource: UriComponents, input: unknown): Promise<IHookResultDto[]>;
}
