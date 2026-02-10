/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { ExtHostContext, MainContext, MainThreadHooksShape } from '../common/extHost.protocol.js';
import { HookCommandResultKind, IHookCommandResult } from '../../contrib/chat/common/hooks/hooksCommandTypes.js';
import { IHooksExecutionProxy, IHooksExecutionService } from '../../contrib/chat/common/hooks/hooksExecutionService.js';
import { IHookCommand } from '../../contrib/chat/common/promptSyntax/hookSchema.js';
import { CancellationToken } from '../../../base/common/cancellation.js';

@extHostNamedCustomer(MainContext.MainThreadHooks)
export class MainThreadHooks extends Disposable implements MainThreadHooksShape {

	constructor(
		extHostContext: IExtHostContext,
		@IHooksExecutionService private readonly _hooksExecutionService: IHooksExecutionService,
	) {
		super();
		const extHostProxy = extHostContext.getProxy(ExtHostContext.ExtHostHooks);

		const proxy: IHooksExecutionProxy = {
			runHookCommand: async (hookCommand: IHookCommand, input: unknown, token: CancellationToken): Promise<IHookCommandResult> => {
				const result = await extHostProxy.$runHookCommand(hookCommand, input, token);
				return {
					kind: result.kind as HookCommandResultKind,
					result: result.result
				};
			}
		};

		this._hooksExecutionService.setProxy(proxy);
	}
}
