/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { ISharedProcessService } from '../../ipc/electron-browser/services.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IRemoteAgentHostService, RemoteAgentHostEntryType } from '../common/remoteAgentHostService.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { SSHRelayTransport } from './sshRelayTransport.js';
import { RemoteAgentHostProtocolClient } from '../browser/remoteAgentHostProtocolClient.js';
import {
	ISSHRemoteAgentHostService,
	SSH_REMOTE_AGENT_HOST_CHANNEL,
	getSSHConnectionKey,
	type ISSHAgentHostConfig,
	type ISSHAgentHostConnection,
	type ISSHRemoteAgentHostMainService,
	type ISSHResolvedConfig,
	type ISSHConnectProgress,
} from '../common/sshRemoteAgentHost.js';

/**
 * Renderer-side implementation of {@link ISSHRemoteAgentHostService} that
 * delegates the actual SSH work to the main process via IPC, then registers
 * the resulting connection with the renderer-local {@link IRemoteAgentHostService}.
 */
export class SSHRemoteAgentHostService extends Disposable implements ISSHRemoteAgentHostService {
	declare readonly _serviceBrand: undefined;

	protected readonly _mainService: ISSHRemoteAgentHostMainService;

	private readonly _onDidChangeConnections = this._register(new Emitter<void>());
	readonly onDidChangeConnections: Event<void> = this._onDidChangeConnections.event;

	readonly onDidReportConnectProgress: Event<ISSHConnectProgress>;

	private readonly _connections = new Map<string, SSHAgentHostConnectionHandle>();

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();

		this._mainService = ProxyChannel.toService<ISSHRemoteAgentHostMainService>(
			sharedProcessService.getChannel(SSH_REMOTE_AGENT_HOST_CHANNEL),
		);

		this.onDidReportConnectProgress = this._mainService.onDidReportConnectProgress;

		// When shared process fires onDidCloseConnection, clean up the renderer-side handle.
		// Do NOT remove the configured entry — it stays in settings so startup reconnect
		// can re-establish the SSH tunnel on next launch.
		this._register(this._mainService.onDidCloseConnection(connectionId => {
			const handle = this._connections.get(connectionId);
			if (handle) {
				this._connections.delete(connectionId);
				handle.fireClose();
				handle.dispose();
				this._onDidChangeConnections.fire();
			}
		}));

		// Dispose any remaining handles when the service itself is disposed.
		this._register(toDisposable(() => {
			for (const handle of this._connections.values()) {
				handle.dispose();
			}
			this._connections.clear();
		}));
	}

	get connections(): readonly ISSHAgentHostConnection[] {
		return [...this._connections.values()];
	}

	async connect(config: ISSHAgentHostConfig): Promise<ISSHAgentHostConnection> {
		this._logService.info('[SSHRemoteAgentHost] Connecting to ' + config.host);
		const augmentedConfig = this._augmentConfig(config);

		// Short-circuit if we already track a live handle locally. The
		// main process keys connections by the same value, so this also
		// avoids a redundant IPC round-trip for repeated connect clicks.
		const expectedKey = getSSHConnectionKey(augmentedConfig);
		const existingLocal = this._connections.get(expectedKey);
		if (existingLocal) {
			this._logService.trace('[SSHRemoteAgentHost] Returning existing connection handle');
			return existingLocal;
		}

		// We do not have a live protocol client. The main process may still
		// be holding a tunnel from a previous window (window reload does not
		// tear down main-process state), so ask it to replace the WebSocket
		// relay. That gives the server a fresh per-transport state for our
		// new protocol client's `initialize` handshake. If no tunnel exists
		// yet, `replaceRelay` is a no-op and a brand new tunnel is created.
		const result = await this._mainService.connect(augmentedConfig, /* replaceRelay */ true);
		this._logService.trace('[SSHRemoteAgentHost] SSH tunnel established, connectionId=' + result.connectionId);

		// Create relay transport + protocol client, then register with RemoteAgentHostService
		try {
			const protocolClient = this._createRelayClient(result);
			await protocolClient.connect();
			this._logService.trace('[SSHRemoteAgentHost] Protocol handshake completed');

			await this._remoteAgentHostService.addSSHConnection({
				name: result.name,
				connectionToken: result.connectionToken,
				connection: {
					type: RemoteAgentHostEntryType.SSH,
					address: result.address,
					sshConfigHost: result.sshConfigHost,
					hostName: result.config.host,
					user: result.config.username || undefined,
					port: result.config.port,
				},
			}, protocolClient);
		} catch (err) {
			this._logService.error('[SSHRemoteAgentHost] Connection setup failed', err);
			this._mainService.disconnect(result.connectionId).catch(() => { /* best effort */ });
			throw err;
		}

		const handle = new SSHAgentHostConnectionHandle(
			result.config,
			result.address,
			result.name,
			() => this._mainService.disconnect(result.connectionId),
		);

		this._connections.set(result.connectionId, handle);
		this._onDidChangeConnections.fire();

		return handle;
	}

	async disconnect(host: string): Promise<void> {
		await this._mainService.disconnect(host);
	}

	async listSSHConfigHosts(): Promise<string[]> {
		return this._mainService.listSSHConfigHosts();
	}

	async resolveSSHConfig(host: string): Promise<ISSHResolvedConfig> {
		return this._mainService.resolveSSHConfig(host);
	}

	async reconnect(sshConfigHost: string, name: string): Promise<ISSHAgentHostConnection> {
		const commandOverride = this._getRemoteAgentHostCommand();
		const result = await this._mainService.reconnect(sshConfigHost, name, commandOverride);

		const existing = this._connections.get(result.connectionId);
		if (existing) {
			return existing;
		}

		const protocolClient = this._createRelayClient(result);
		await protocolClient.connect();

		await this._remoteAgentHostService.addSSHConnection({
			name: result.name,
			connectionToken: result.connectionToken,
			connection: {
				type: RemoteAgentHostEntryType.SSH,
				address: result.address,
				sshConfigHost: result.sshConfigHost,
				hostName: result.config.host,
				user: result.config.username || undefined,
				port: result.config.port,
			},
		}, protocolClient);

		const handle = new SSHAgentHostConnectionHandle(
			result.config,
			result.address,
			result.name,
			() => this._mainService.disconnect(result.connectionId),
		);

		this._connections.set(result.connectionId, handle);
		this._onDidChangeConnections.fire();

		return handle;
	}

	protected _createRelayClient(result: { connectionId: string; address: string }): RemoteAgentHostProtocolClient {
		const transport = new SSHRelayTransport(result.connectionId, this._mainService);
		return this._instantiationService.createInstance(
			RemoteAgentHostProtocolClient, result.address, transport,
		);
	}

	private _augmentConfig(config: ISSHAgentHostConfig): ISSHAgentHostConfig {
		const commandOverride = this._getRemoteAgentHostCommand();
		if (commandOverride) {
			return { ...config, remoteAgentHostCommand: commandOverride };
		}
		return config;
	}

	private _getRemoteAgentHostCommand(): string | undefined {
		return this._configurationService.getValue<string>('chat.sshRemoteAgentHostCommand') || undefined;
	}
}

/**
 * Lightweight renderer-side handle that represents a connection
 * managed by the main process.
 */
class SSHAgentHostConnectionHandle extends Disposable implements ISSHAgentHostConnection {
	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose = this._onDidClose.event;

	private _closedByMain = false;

	constructor(
		readonly config: ISSHAgentHostConnection['config'],
		readonly localAddress: string,
		readonly name: string,
		disconnectFn: () => Promise<void>,
	) {
		super();

		// When this handle is disposed, tear down the main-process tunnel
		// (skip if already closed from the main process side)
		this._register(toDisposable(() => {
			if (!this._closedByMain) {
				disconnectFn().catch(() => { /* best effort */ });
			}
		}));
	}

	/** Called by the service when the main process signals connection closure. */
	fireClose(): void {
		this._closedByMain = true;
		this._onDidClose.fire();
	}
}
