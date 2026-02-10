/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { MainContext, MainThreadHooksShape } from '../common/extHost.protocol.js';

@extHostNamedCustomer(MainContext.MainThreadHooks)
export class MainThreadHooks extends Disposable implements MainThreadHooksShape {

	constructor(
		_extHostContext: IExtHostContext,
	) {
		super();
	}
}
