/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { HookTypeValue } from './promptSyntax/hookSchema.js';

export const enum HookResultKind {
	Success = 1,
	Error = 2
}

export interface IHookResult {
	readonly kind: HookResultKind;
	readonly result: string | object;
}

export interface IHooksExecutionOptions {
	readonly input?: unknown;
}

/**
 * Callback interface for hook execution proxies.
 * MainThreadHooks implements this to forward calls to the extension host.
 */
export interface IHooksExecutionProxy {
	executeHook(hookType: HookTypeValue, sessionResource: URI, input: unknown): Promise<IHookResult[]>;
}

export const IHooksExecutionService = createDecorator<IHooksExecutionService>('hooksExecutionService');

export interface IHooksExecutionService {
	_serviceBrand: undefined;

	/**
	 * Called by mainThreadHooks when extension host is ready
	 */
	setProxy(proxy: IHooksExecutionProxy): void;

	/**
	 * Execute hooks of the given type for the given session
	 */
	executeHook(hookType: HookTypeValue, sessionResource: URI, options?: IHooksExecutionOptions): Promise<IHookResult[]>;
}

export class HooksExecutionService implements IHooksExecutionService {
	declare readonly _serviceBrand: undefined;

	private _proxy: IHooksExecutionProxy | undefined;

	setProxy(proxy: IHooksExecutionProxy): void {
		this._proxy = proxy;
	}

	async executeHook(hookType: HookTypeValue, sessionResource: URI, options?: IHooksExecutionOptions): Promise<IHookResult[]> {
		if (!this._proxy) {
			return [];
		}

		return this._proxy.executeHook(hookType, sessionResource, options?.input);
	}
}
