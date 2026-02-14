/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../ipc/electron-browser/services.js';
import { IAgentHostService, AgentHostIpcChannels } from '../common/agentService.js';

registerMainProcessRemoteService(IAgentHostService, AgentHostIpcChannels.AgentHost);
