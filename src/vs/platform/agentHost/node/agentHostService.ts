/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { ILogService, ILoggerService } from '../../log/common/log.js';
import { RemoteLoggerChannelClient } from '../../log/common/logIpc.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { IAgentHostStarter } from '../common/agent.js';
import { reportAgentHostProcessError } from '../common/agentHostProcessTelemetry.js';
import { AgentHostIpcChannels } from '../common/agentService.js';

enum Constants {
	MaxRestarts = 5,
}

/**
 * Main-process service that manages the agent host utility process lifecycle
 * (lazy start, crash recovery, logger forwarding). The renderer communicates
 * with the utility process directly via MessagePort - this class does not
 * relay any agent service calls.
 */
export class AgentHostProcessManager extends Disposable {

	private _started = false;
	private _wasQuitRequested = false;
	private _restartCount = 0;
	private _startGeneration = 0;
	private _activeClientCount = 0;
	private _startPromise: Promise<void> | undefined;
	private _restartAfterStart = false;
	private readonly _tracksActiveClients: boolean;
	private readonly _activeProcess = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		private readonly _starter: IAgentHostStarter,
		@ILogService private readonly _logService: ILogService,
		@ILoggerService private readonly _loggerService: ILoggerService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
		super();
		this._tracksActiveClients = !!this._starter.onDidChangeActiveClientCount;

		this._register(this._starter);

		// Start lazily when the first window asks for a connection
		if (this._starter.onRequestConnection) {
			this._register(this._starter.onRequestConnection(() => this._ensureStarted()));
		}

		if (this._starter.onDidChangeActiveClientCount) {
			this._register(this._starter.onDidChangeActiveClientCount(count => {
				this._activeClientCount = count;
				if (count > 0) {
					this._ensureStarted();
				} else {
					this._stop();
				}
			}));
		}

		if (this._starter.onWillShutdown) {
			this._register(this._starter.onWillShutdown(() => this._wasQuitRequested = true));
		}
	}

	private _ensureStarted(): void {
		if (this._started || !this._shouldRun()) {
			return;
		}
		if (this._startPromise) {
			this._restartAfterStart = true;
			return;
		}

		this._startPromise = this._start().finally(() => {
			this._startPromise = undefined;
			const restartAfterStart = this._restartAfterStart;
			this._restartAfterStart = false;
			if (restartAfterStart && !this._started && this._shouldRun()) {
				this._ensureStarted();
			}
		});
	}

	private async _start(): Promise<void> {
		this._started = true;
		const generation = ++this._startGeneration;
		try {
			const connection = await this._starter.start();

			if (this._store.isDisposed || !this._started || generation !== this._startGeneration) {
				connection.store.dispose();
				return;
			}

			this._logService.info('AgentHostProcessManager: agent host started');
			const processStore = new DisposableStore();
			this._activeProcess.value = processStore;
			processStore.add(connection.store);

			// Connect logger channel so agent host logs appear in the output channel
			processStore.add(this._createLoggerClient(connection));

			// Handle unexpected exit
			processStore.add(connection.onDidProcessExit(e => {
				if (!this._wasQuitRequested && !this._store.isDisposed) {
					this._started = false;
					this._activeProcess.clear();
					const willRestart = this._shouldRun() && this._restartCount <= Constants.MaxRestarts;
					reportAgentHostProcessError(this._telemetryService, {
						kind: 'unexpectedExit',
						code: e.code,
						restartCount: this._restartCount,
						willRestart,
					});
					if (willRestart) {
						this._logService.error(`AgentHostProcessManager: agent host terminated unexpectedly with code ${e.code}`);
						this._restartCount++;
						this._ensureStarted();
					} else if (this._shouldRun()) {
						this._logService.error(`AgentHostProcessManager: agent host terminated with code ${e.code}, giving up after ${Constants.MaxRestarts} restarts`);
					}
				}
			}));
		} catch (error) {
			if (generation === this._startGeneration) {
				this._started = false;
				this._logService.error('AgentHostProcessManager: failed to start agent host', error);
				reportAgentHostProcessError(this._telemetryService, {
					kind: 'startFailed',
					restartCount: this._restartCount,
					willRestart: false,
				}, error);
			}
		}
	}

	protected _createLoggerClient(connection: Awaited<ReturnType<IAgentHostStarter['start']>>): IDisposable {
		return new RemoteLoggerChannelClient(this._loggerService, connection.client.getChannel(AgentHostIpcChannels.Logger));
	}

	private _shouldRun(): boolean {
		return !this._tracksActiveClients || this._activeClientCount > 0;
	}

	private _stop(): void {
		if (!this._started) {
			return;
		}

		this._started = false;
		this._restartCount = 0;
		this._restartAfterStart = false;
		this._startGeneration++;
		this._activeProcess.clear();
		this._logService.info('AgentHostProcessManager: agent host stopped because no enabled clients remain');
	}
}
