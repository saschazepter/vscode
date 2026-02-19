/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Overrides the default browser-based IRequestService (which uses fetch() and
 * is subject to CORS) with one that proxies requests through the main process
 * via IPC. The main process uses Electron's net.request() which bypasses CORS.
 */

import { InstantiationType, registerSingleton } from '../../platform/instantiation/common/extensions.js';
import { IRequestService } from '../../platform/request/common/request.js';
import { RequestChannelClient } from '../../platform/request/common/requestIpc.js';
import { IMainProcessService } from '../../platform/ipc/common/mainProcessService.js';

class MainProcessRequestService extends RequestChannelClient implements IRequestService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super(mainProcessService.getChannel('request'));
	}
}

// This overrides the NativeRequestService registered in
// workbench/services/request/electron-browser/requestService.ts
registerSingleton(IRequestService, MainProcessRequestService, InstantiationType.Delayed);
