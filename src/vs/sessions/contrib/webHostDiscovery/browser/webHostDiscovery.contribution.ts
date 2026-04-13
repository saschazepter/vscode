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
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';

interface IRegistryHost {
	hostId: string;
	clusterId?: string;
	name: string;
	tunnelUrl: string;
	connectionToken?: string;
}

/** The secret storage key used by the walkthrough to store GitHub auth sessions. */
const GITHUB_AUTH_SECRET_KEY = JSON.stringify({ extensionId: 'vscode.github-authentication', key: 'github.auth' });

/**
 * On web, discovers agent hosts from the vscode.dev host registry
 * and registers them with {@link IRemoteAgentHostService}.
 *
 * Reacts to GitHub auth token availability in secret storage: checks on
 * startup and listens for new tokens stored by the welcome overlay's
 * device code flow.
 */
class WebHostDiscoveryContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.webHostDiscovery';

	private _discovered = false;

	constructor(
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
		@ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		if (!isWeb) {
			return;
		}

		// Check if a token is already available (returning user)
		this._getSecretStorageToken().then(token => {
			if (token && !this._discovered) {
				this._discoverHosts(token);
			}
		});

		// Listen for when the walkthrough stores a new token
		this._register(this._secretStorageService.onDidChangeSecret(key => {
			if (key === GITHUB_AUTH_SECRET_KEY && !this._discovered) {
				this._getSecretStorageToken().then(token => {
					if (token && !this._discovered) {
						this._discoverHosts(token);
					}
				});
			}
		}));
	}

	/**
	 * Read the GitHub access token from secret storage. The walkthrough stores
	 * auth sessions in the same format as the github-authentication extension.
	 */
	private async _getSecretStorageToken(): Promise<string | undefined> {
		try {
			const raw = await this._secretStorageService.get(GITHUB_AUTH_SECRET_KEY);
			if (raw) {
				const sessions = JSON.parse(raw) as { accessToken?: string }[];
				if (Array.isArray(sessions) && sessions.length > 0 && sessions[0].accessToken) {
					return sessions[0].accessToken;
				}
			}
		} catch {
			// Secret storage not available or parse error
		}
		return undefined;
	}

	private async _discoverHosts(token: string): Promise<void> {
		if (this._discovered) {
			return;
		}
		this._discovered = true;

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

}

registerWorkbenchContribution2(WebHostDiscoveryContribution.ID, WebHostDiscoveryContribution, WorkbenchPhase.Eventually);
