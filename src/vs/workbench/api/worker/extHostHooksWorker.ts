/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IHookCommandDto } from '../common/extHost.protocol.js';
import { IExtHostHooks } from '../common/extHostHooks.js';
import { HookCommandResultKind, IHookCommandResult } from '../../contrib/chat/common/hooks/hooksCommandTypes.js';

export class WorkerExtHostHooks implements IExtHostHooks {

	constructor(
		@ILogService private readonly _logService: ILogService
	) { }

	async $runHookCommand(_hookCommand: IHookCommandDto, _input: unknown, _token: CancellationToken): Promise<IHookCommandResult> {
		this._logService.debug('[WorkerExtHostHooks] Hook commands are not supported in web worker context');

		// Web worker cannot run shell commands - return an error
		return {
			kind: HookCommandResultKind.Error,
			result: 'Hook commands are not supported in web worker context'
		};
	}
}
