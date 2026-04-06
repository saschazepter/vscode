/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IRemoteAgentHostService, RemoteAgentHostConnectionStatus, RemoteAgentHostsEnabledSettingId } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { ITunnelAgentHostService, type ITunnelInfo } from '../../../../platform/agentHost/common/tunnelAgentHost.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISessionsProvidersService } from '../../sessions/browser/sessionsProvidersService.js';
import { RemoteAgentHostSessionsProvider } from './remoteAgentHostSessionsProvider.js';

const LOG_PREFIX = '[TunnelAgentHost]';

/** Minimum interval between silent status checks (5 minutes). */
const STATUS_CHECK_INTERVAL = 5 * 60 * 1000;

export class TunnelAgentHostContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.tunnelAgentHostContribution';

	private readonly _providerStores = this._register(new DisposableMap<string /* address */, DisposableStore>());
	private readonly _providerInstances = new Map<string, RemoteAgentHostSessionsProvider>();
	private readonly _pendingConnects = new Set<string>();
	private _lastStatusCheck = 0;

	constructor(
		@ITunnelAgentHostService private readonly _tunnelService: ITunnelAgentHostService,
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		// Create providers for cached tunnels
		this._reconcileProviders();

		// Update connection statuses when connections change
		this._register(this._remoteAgentHostService.onDidChangeConnections(() => {
			this._updateConnectionStatuses();
			this._wireConnections();
		}));

		// Reconcile providers when the tunnel cache changes
		this._register(this._tunnelService.onDidChangeTunnels(() => {
			this._reconcileProviders();
		}));

		// Silently reconnect cached tunnels on startup
		this._silentReconnect();
	}

	/**
	 * Called by the workspace picker when it opens. Silently re-checks
	 * tunnel statuses if more than 5 minutes have elapsed since the last check.
	 */
	async checkTunnelStatuses(): Promise<void> {
		if (Date.now() - this._lastStatusCheck < STATUS_CHECK_INTERVAL) {
			return;
		}
		await this._silentReconnect();
	}

	// -- Provider management --

	private _reconcileProviders(): void {
		const enabled = this._configurationService.getValue<boolean>(RemoteAgentHostsEnabledSettingId);
		const cached = enabled ? this._tunnelService.getCachedTunnels() : [];
		const desiredAddresses = new Set(cached.map(t => `tunnel:${t.tunnelId}`));

		// Remove providers no longer cached
		for (const [address] of this._providerStores) {
			if (!desiredAddresses.has(address)) {
				this._providerStores.deleteAndDispose(address);
				this._providerInstances.delete(address);
			}
		}

		// Add providers for cached tunnels
		for (const tunnel of cached) {
			const address = `tunnel:${tunnel.tunnelId}`;
			if (!this._providerStores.has(address)) {
				this._createProvider(address, tunnel.name);
			}
		}
	}

	private _createProvider(address: string, name: string): void {
		const store = new DisposableStore();
		const provider = this._instantiationService.createInstance(
			RemoteAgentHostSessionsProvider, { address, name },
		);
		store.add(provider);
		store.add(this._sessionsProvidersService.registerProvider(provider));
		this._providerInstances.set(address, provider);
		store.add(toDisposable(() => this._providerInstances.delete(address)));
		this._providerStores.set(address, store);
	}

	// -- Connection status --

	private _updateConnectionStatuses(): void {
		for (const [address, provider] of this._providerInstances) {
			const connectionInfo = this._remoteAgentHostService.connections.find(c => c.address === address);
			if (connectionInfo) {
				provider.setConnectionStatus(connectionInfo.status);
			} else if (this._pendingConnects.has(address)) {
				provider.setConnectionStatus(RemoteAgentHostConnectionStatus.Connecting);
			} else {
				provider.setConnectionStatus(RemoteAgentHostConnectionStatus.Disconnected);
			}
		}
	}

	/**
	 * Wire live connections to their providers so session operations work.
	 */
	private _wireConnections(): void {
		for (const [address, provider] of this._providerInstances) {
			const connectionInfo = this._remoteAgentHostService.connections.find(
				c => c.address === address && c.status === RemoteAgentHostConnectionStatus.Connected
			);
			if (connectionInfo) {
				const connection = this._remoteAgentHostService.getConnection(address);
				if (connection) {
					provider.setConnection(connection, connectionInfo.defaultDirectory);
				}
			}
		}
	}

	// -- Silent reconnect --

	private async _silentReconnect(): Promise<void> {
		const enabled = this._configurationService.getValue<boolean>(RemoteAgentHostsEnabledSettingId);
		if (!enabled) {
			return;
		}

		this._lastStatusCheck = Date.now();

		// Validate cached tunnels still exist
		let onlineTunnels: ITunnelInfo[] | undefined;
		try {
			onlineTunnels = await this._tunnelService.listTunnels({ silent: true });
		} catch {
			// No cached token or network error — skip validation
		}

		const cached = this._tunnelService.getCachedTunnels();
		if (onlineTunnels) {
			const onlineIds = new Set(onlineTunnels.map(t => t.tunnelId));
			// Remove cached tunnels that no longer exist
			for (const tunnel of cached) {
				if (!onlineIds.has(tunnel.tunnelId)) {
					this._tunnelService.removeCachedTunnel(tunnel.tunnelId);
				}
			}
		}

		// Try to reconnect cached tunnels that are disconnected
		for (const tunnel of this._tunnelService.getCachedTunnels()) {
			const address = `tunnel:${tunnel.tunnelId}`;
			const hasConnection = this._remoteAgentHostService.connections.some(
				c => c.address === address && c.status === RemoteAgentHostConnectionStatus.Connected
			);
			if (hasConnection || this._pendingConnects.has(address)) {
				continue;
			}

			// Only try if the tunnel was found online
			if (onlineTunnels && !onlineTunnels.some(t => t.tunnelId === tunnel.tunnelId)) {
				continue;
			}

			this._pendingConnects.add(address);
			this._updateConnectionStatuses();

			const tunnelInfo: ITunnelInfo = {
				tunnelId: tunnel.tunnelId,
				clusterId: tunnel.clusterId,
				name: tunnel.name,
				tags: [],
				protocolVersion: 5,
			};

			this._tunnelService.connect(tunnelInfo, tunnel.authProvider).then(() => {
				this._pendingConnects.delete(address);
				this._logService.info(`${LOG_PREFIX} Silently reconnected to tunnel '${tunnel.name}'`);
				this._updateConnectionStatuses();
			}).catch(err => {
				this._pendingConnects.delete(address);
				this._logService.debug(`${LOG_PREFIX} Silent reconnect failed for tunnel '${tunnel.name}': ${err}`);
				this._updateConnectionStatuses();
			});
		}
	}
}

registerWorkbenchContribution2(TunnelAgentHostContribution.ID, TunnelAgentHostContribution, WorkbenchPhase.AfterRestored);
