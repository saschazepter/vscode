/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { Server as UtilityProcessServer } from '../../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../../base/parts/sandbox/node/electronTypes.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { AgentHostIpcChannels } from '../common/agentService.js';
import { AgentService } from './agentService.js';

startAgentHost();

function startAgentHost(): void {
	if (!isUtilityProcess(process)) {
		throw new Error('agentHostMain must be loaded in an Electron utility process');
	}

	const server = new UtilityProcessServer();

	const disposables = new DisposableStore();

	// Create the real service implementation that lives in this process
	const agentService = new AgentService();
	const agentChannel = ProxyChannel.fromService(agentService, disposables);
	server.registerChannel(AgentHostIpcChannels.AgentHost, agentChannel);

	process.once('exit', () => {
		agentService.dispose();
		disposables.dispose();
	});
}
