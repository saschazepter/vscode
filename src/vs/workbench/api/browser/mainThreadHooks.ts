/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { ExtHostContext, MainContext, MainThreadHooksShape } from '../common/extHost.protocol.js';
import { HookResultKind, IHookResult, IHooksExecutionProxy, IHooksExecutionService } from '../../contrib/chat/common/hooksExecutionService.js';
import { HookTypeValue } from '../../contrib/chat/common/promptSyntax/hookSchema.js';

@extHostNamedCustomer(MainContext.MainThreadHooks)
export class MainThreadHooks extends Disposable implements MainThreadHooksShape {

	constructor(
		extHostContext: IExtHostContext,
		@IHooksExecutionService private readonly _hooksExecutionService: IHooksExecutionService,
	) {
		super();
		const extHostProxy = extHostContext.getProxy(ExtHostContext.ExtHostHooks);

		// Adapter that implements IHooksExecutionProxy by forwarding to ExtHostHooksShape
		const proxy: IHooksExecutionProxy = {
			executeHook: async (hookType: HookTypeValue, sessionResource: URI, input: unknown): Promise<IHookResult[]> => {
				const results = await extHostProxy.$executeHook(hookType, sessionResource, input);
				return results.map(r => ({
					kind: r.kind as HookResultKind,
					result: r.result
				}));
			}
		};

		this._hooksExecutionService.setProxy(proxy);
	}
}
