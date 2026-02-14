/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IAgentService } from '../common/agentService.js';

/**
 * The actual agent service implementation that runs inside the agent host
 * utility process. This is where the real agent logic will live.
 */
export class AgentService extends Disposable implements IAgentService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidReceiveMessage = this._register(new Emitter<string>());
	readonly onDidReceiveMessage = this._onDidReceiveMessage.event;

	async ping(msg: string): Promise<string> {
		// TODO: Replace with real agent logic
		const response = `pong: ${msg}`;
		this._onDidReceiveMessage.fire(response);
		return response;
	}
}
