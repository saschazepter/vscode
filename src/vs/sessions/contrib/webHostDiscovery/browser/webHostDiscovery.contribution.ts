/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRemoteAgentHostService, RemoteAgentHostEntryType } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { isWeb } from '../../../../base/common/platform.js';
import { mainWindow } from '../../../../base/browser/window.js';

interface IRegistryHost {
	hostId: string;
	clusterId?: string;
	name: string;
	tunnelUrl: string;
	connectionToken?: string;
}

/**
 * On web, discovers agent hosts from the vscode.dev host registry
 * and registers them with {@link IRemoteAgentHostService}.
 *
 * Polls localStorage for a GitHub token (stored by the welcome overlay's
 * device code flow) and queries the registry when a token becomes available.
 */
class WebHostDiscoveryContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.webHostDiscovery';

	constructor(
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		if (!isWeb) {
			return;
		}

		this._discoverHosts();
	}

	private async _discoverHosts(): Promise<void> {
		// Wait for token — the device code flow in the walkthrough may take
		// up to ~5 minutes for the user to authorize
		const token = await this._waitForToken(300_000);
		if (!token) {
			return;
		}

		try {
			const resp = await fetch('/agents/api/hosts', {
				headers: { 'Authorization': `Bearer ${token}` }
			});

			if (!resp.ok) {
				this._logService.warn(`[WebHostDiscovery] Registry returned ${resp.status}`);
				return;
			}

			const data = await resp.json() as { hosts?: IRegistryHost[] };
			const hosts = data.hosts ?? [];

			if (hosts.length === 0) {
				return;
			}

			for (const host of hosts) {
				// Route through the tunnel relay proxy which uses the Dev Tunnels
				// SDK server-side to connect to private tunnels
				const wsScheme = mainWindow.location.protocol === 'https:' ? 'wss:' : 'ws:';
				const params = new URLSearchParams({
					tunnelId: host.hostId,
					clusterId: host.clusterId ?? '',
					token: token,
				});
				const address = `${wsScheme}//${mainWindow.location.host}/agents/tunnel?${params.toString()}`;

				const name = host.name || host.hostId;

				try {
					await this._remoteAgentHostService.addRemoteAgentHost({
						name,
						connectionToken: host.connectionToken,
						connection: { type: RemoteAgentHostEntryType.WebSocket, address },
					});

					// Push GitHub token to the agent host for Copilot API access.
					// On web, IAuthenticationService doesn't have a valid session,
					// so we push the token from localStorage directly.
					const connection = this._remoteAgentHostService.getConnection(address);
					if (connection && token) {
						try {
							await connection.authenticate({
								resource: 'https://api.github.com',
								token: token
							});
						} catch (authErr) {
							this._logService.warn(`[WebHostDiscovery] Failed to push token to ${name}:`, authErr);
						}
					}
				} catch (e) {
					this._logService.warn(`[WebHostDiscovery] Failed to add host ${name}:`, e);
				}
			}
		} catch (e) {
			this._logService.warn('[WebHostDiscovery] Host discovery failed:', e);
		}
	}

	private _waitForToken(timeoutMs: number): Promise<string | undefined> {
		return new Promise(resolve => {
			// Check immediately — token may be stored under either key
			const getToken = () =>
				globalThis.localStorage?.getItem('sessions.tunnel.token') ??
				globalThis.localStorage?.getItem('sessions.github.token');

			const token = getToken();
			if (token) {
				resolve(token);
				return;
			}

			// Poll every 2s until token appears or timeout
			const interval = 2000;
			let elapsed = 0;
			const timer = mainWindow.setInterval(() => {
				elapsed += interval;
				const t = getToken();
				if (t) {
					mainWindow.clearInterval(timer);
					resolve(t);
				} else if (elapsed >= timeoutMs) {
					mainWindow.clearInterval(timer);
					resolve(undefined);
				}
			}, interval);

			this._register({ dispose: () => mainWindow.clearInterval(timer) });
		});
	}
}

registerWorkbenchContribution2(WebHostDiscoveryContribution.ID, WebHostDiscoveryContribution, WorkbenchPhase.Eventually);
