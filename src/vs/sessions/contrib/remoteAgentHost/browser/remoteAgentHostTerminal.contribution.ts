/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { isWeb } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { AGENT_HOST_SCHEME, agentHostAuthority, fromAgentHostUri } from '../../../../platform/agentHost/common/agentHostUri.js';
import { IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { IRemoteAgentHostService, RemoteAgentHostConnectionStatus } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AgentHostTerminalContribution, IAgentHostEntry } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostTerminalContribution.js';
import { LoggingAgentConnection } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/loggingAgentConnection.js';
import { IAgentHostTerminalService } from '../../../../workbench/contrib/terminal/browser/agentHostTerminalService.js';
import { ITerminalProfileService } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

export class RemoteAgentHostTerminalContribution extends AgentHostTerminalContribution {
	constructor(
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@IAgentHostService agentHostService: IAgentHostService,
		@ITerminalProfileService terminalProfileService: ITerminalProfileService,
		@IQuickInputService quickInputService: IQuickInputService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAgentHostTerminalService agentHostTerminalService: IAgentHostTerminalService,
	) {
		super(
			agentHostService,
			terminalProfileService,
			quickInputService,
			instantiationService,
			agentHostTerminalService,
		);


		// React to connection changes
		this._register(this._remoteAgentHostService.onDidChangeConnections(() => {
			this._reconcile();
		}));

		// The base-class constructor already called _reconcile(), but at that
		// point _remoteAgentHostService was not yet assigned (guard returned
		// early). Re-reconcile now to pick up any existing connections.
		this._reconcile();
	}

	protected override _collectEntries(): IAgentHostEntry[] {
		const entries: IAgentHostEntry[] = [];
		// Guard: _remoteAgentHostService may not be assigned yet when the
		// base-class constructor calls _reconcile() before super() returns.
		if (!this._remoteAgentHostService) {
			return isWeb ? entries : super._collectEntries();
		}
		// Remote connections
		for (const info of this._remoteAgentHostService.connections) {
			if (info.status !== RemoteAgentHostConnectionStatus.Connected) {
				continue;
			}
			const connection = this._remoteAgentHostService.getConnection(info.address);
			if (!connection) {
				continue;
			}

			entries.push({
				name: info.name || info.address,
				address: info.address,
				getConnection: () => this._instantiationService.createInstance(
					LoggingAgentConnection,
					connection,
					`agenthost.${connection.clientId}`,
					localize('agentHostTerminal.channelRemote', "Agent Host Terminal ({0})", info.address),
				),
			});
		}

		return isWeb ? entries : [...entries, ...super._collectEntries()];
	}

	protected override _getDefaultCwd(address: string): URI | undefined {
		// Agent-host sessions never materialize workspace folders in the
		// browser, so the terminal service has no cwd. Derive one from the
		// active session's worktree instead, scoped to the chosen host.
		const repo = this._sessionsManagementService?.activeSession.get()?.workspace.get()?.repositories[0];
		const worktree = repo?.workingDirectory ?? repo?.uri;
		if (worktree?.scheme !== AGENT_HOST_SCHEME || worktree.authority !== agentHostAuthority(address)) {
			return undefined;
		}
		return fromAgentHostUri(worktree);
	}
}
registerWorkbenchContribution2(AgentHostTerminalContribution.ID, RemoteAgentHostTerminalContribution, WorkbenchPhase.AfterRestored);
