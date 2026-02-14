/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../log/common/log.js';
import { IAgentHostConnection, IAgentHostStarter } from '../common/agent.js';
import { AgentHostIpcChannels, IAgentHostService, IAgentService } from '../common/agentService.js';

enum Constants {
	MaxRestarts = 5,
}

/**
 * This service implements {@link IAgentHostService} by launching an agent host
 * utility process, forwarding messages via MessagePort, and managing the
 * connection lifecycle (lazy start, restart on crash).
 */
export class AgentHostService extends Disposable implements IAgentHostService {
	declare readonly _serviceBrand: undefined;

	private _connection: IAgentHostConnection | undefined;
	private _proxy: IAgentService | undefined;

	private _wasQuitRequested = false;
	private _restartCount = 0;

	private readonly _onAgentHostExit = this._register(new Emitter<number>());
	readonly onAgentHostExit = this._onAgentHostExit.event;
	private readonly _onAgentHostStart = this._register(new Emitter<void>());
	readonly onAgentHostStart = this._onAgentHostStart.event;

	private readonly _onDidReceiveMessage = this._register(new Emitter<string>());
	readonly onDidReceiveMessage = this._onDidReceiveMessage.event;

	constructor(
		private readonly _starter: IAgentHostStarter,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._register(this._starter);
		this._register(toDisposable(() => this._disposeAgentHost()));

		// Start lazily when the first window asks for a connection
		if (this._starter.onRequestConnection) {
			this._register(Event.once(this._starter.onRequestConnection)(() => this._ensureAgentHost()));
		}

		if (this._starter.onWillShutdown) {
			this._register(this._starter.onWillShutdown(() => this._wasQuitRequested = true));
		}
	}

	// ---- lifecycle ----------------------------------------------------------

	private _ensureAgentHost(): void {
		if (!this._connection) {
			this._startAgentHost();
		}
	}

	private _startAgentHost(): void {
		const connection = this._starter.start();
		const client = connection.client;

		this._logService.info('AgentHostService: agent host started');

		// Build a proxy to the agent service running inside the utility process
		const proxy = ProxyChannel.toService<IAgentService>(client.getChannel(AgentHostIpcChannels.AgentHost));
		this._register(proxy.onDidReceiveMessage(msg => this._onDidReceiveMessage.fire(msg)));

		// Handle unexpected exit
		this._register(connection.onDidProcessExit(e => {
			this._onAgentHostExit.fire(e.code);
			if (!this._wasQuitRequested && !this._store.isDisposed) {
				if (this._restartCount <= Constants.MaxRestarts) {
					this._logService.error(`AgentHostService: agent host terminated unexpectedly with code ${e.code}`);
					this._restartCount++;
					this.restartAgentHost();
				} else {
					this._logService.error(`AgentHostService: agent host terminated with code ${e.code}, giving up after ${Constants.MaxRestarts} restarts`);
				}
			}
		}));

		this._connection = connection;
		this._proxy = proxy;
		this._onAgentHostStart.fire();
	}

	private _disposeAgentHost(): void {
		this._connection?.store.dispose();
		this._connection = undefined;
		this._proxy = undefined;
	}

	async restartAgentHost(): Promise<void> {
		this._disposeAgentHost();
		this._startAgentHost();
	}

	// ---- IAgentService forwarding -------------------------------------------

	async ping(msg: string): Promise<string> {
		this._ensureAgentHost();
		return this._proxy!.ping(msg);
	}
}
