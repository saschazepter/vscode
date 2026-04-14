/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { isWeb } from '../../../../base/common/platform.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IRemoteAgentHostService, RemoteAgentHostEntryType } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IAuthenticationService } from '../../../../workbench/services/authentication/common/authentication.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';

/**
 * Well-known command ID that the embedder (e.g. vscode.dev) registers via
 * `workbenchOptions.commands` to handle auth and tunnel discovery.
 *
 * The command is expected to:
 * 1. Ensure the user is authenticated (triggering OAuth if needed)
 * 2. Discover available agent host tunnels
 * 3. Return an array of host descriptors: `{ name, address, connectionToken? }[]`
 *
 * If the command is not registered (e.g. running on desktop or a different
 * embedder), discovery is silently skipped.
 */
const DISCOVER_HOSTS_COMMAND = '_sessions.web.discoverHosts';

interface IDiscoveredHost {
	readonly name: string;
	readonly address: string;
	readonly connectionToken?: string;
}

/**
 * On web, discovers agent hosts by calling the embedder's discovery command.
 * The embedder handles auth and tunnel resolution; this contribution only
 * receives the results and feeds them into {@link IRemoteAgentHostService}.
 *
 * This decouples core from any specific embedder (vscode.dev, github.dev, etc.)
 * — the contract is a single well-known command ID.
 */
class WebHostDiscoveryContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.webHostDiscovery';

	constructor(
		@ICommandService private readonly _commandService: ICommandService,
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		if (!isWeb) {
			return;
		}

		console.log('[WebHostDiscovery] Web detected, starting discovery...');
		this._discoverHosts();

		// If the walkthrough handles auth, re-run discovery when a GitHub
		// session becomes available (onDidChangeSessions fires after login).
		this._register(this._authenticationService.onDidChangeSessions(e => {
			if (e.providerId === 'github') {
				this._logService.info('[WebHostDiscovery] GitHub sessions changed, retrying discovery...');
				this._discoverHosts();
			}
		}));

		// Also listen for secret storage changes — the device code flow
		// writes tokens directly to secret storage, bypassing the extension.
		const githubAuthKey = JSON.stringify({ extensionId: 'vscode.github-authentication', key: 'github.auth' });
		this._register(this._secretStorageService.onDidChangeSecret(key => {
			if (key === githubAuthKey) {
				this._logService.info('[WebHostDiscovery] Secret storage auth changed, retrying discovery...');
				this._discoverHosts();
			}
		}));
	}

	private async _discoverHosts(): Promise<void> {
		// Wait for extensions to activate — the github-authentication
		// extension needs to be running before we can create sessions.
		await this._extensionService.whenInstalledExtensionsRegistered();

		try {
			const hosts = await this._commandService.executeCommand<IDiscoveredHost[]>(DISCOVER_HOSTS_COMMAND);

			if (!hosts || !Array.isArray(hosts) || hosts.length === 0) {
				this._logService.info('[WebHostDiscovery] No hosts discovered');
				return;
			}

			this._logService.info(`[WebHostDiscovery] Discovered ${hosts.length} host(s), registering...`);

			for (const host of hosts) {
				if (!host.name || !host.address) {
					continue;
				}
				try {
					await this._remoteAgentHostService.addRemoteAgentHost({
						name: host.name,
						connectionToken: host.connectionToken,
						connection: { type: RemoteAgentHostEntryType.WebSocket, address: host.address },
					});
					this._logService.info(`[WebHostDiscovery] Registered host: ${host.name}`);
				} catch (err) {
					this._logService.warn(`[WebHostDiscovery] Failed to register host ${host.name}:`, err);
				}
			}
		} catch (err) {
			console.log('[WebHostDiscovery] Discovery command failed (expected on desktop):', err);
			this._logService.trace('[WebHostDiscovery] Discovery command not available:', err);
		}
	}
}

registerWorkbenchContribution2(WebHostDiscoveryContribution.ID, WebHostDiscoveryContribution, WorkbenchPhase.Eventually);
