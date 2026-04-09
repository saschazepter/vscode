/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, disposableTimeout } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { softAssertNever } from '../../../../base/common/assert.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, ISettableObservable, ObservablePromise, observableValue, transaction } from '../../../../base/common/observable.js';
import type { McpServerRequestHandler } from './mcpServerRequestHandler.js';
import { McpError } from './mcpTypes.js';
import { IMcpTaskInternal } from './mcpTaskManager.js';
import { MCP } from './modelContextProtocol.js';

export function isTaskInTerminalState(task: MCP.Task): boolean {
	return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
}

/**
 * Implementation of a task that handles polling, status notifications, and handler reconnections. It implements the task polling loop internally and can also be
 * updated externally via `onDidUpdateState`, when notifications are received
 * for example.
 */
export class McpTask<T extends MCP.Result> extends Disposable implements IMcpTaskInternal {
	private readonly promise = new DeferredPromise<T>();

	public get result(): Promise<T> {
		return this.promise.p;
	}

	public get id() {
		return this._task.taskId;
	}

	private _lastTaskState: ISettableObservable<MCP.Task>;
	private _handler = observableValue<McpServerRequestHandler | undefined>('mcpTaskHandler', undefined);

	constructor(
		private readonly _task: MCP.Task,
		_token: CancellationToken = CancellationToken.None,
		private readonly _onStatusMessage?: (message: string) => void,
	) {
		super();

		const expiresAt = _task.ttl ? (Date.now() + _task.ttl) : undefined;
		this._lastTaskState = observableValue('lastTaskState', this._task);

		const store = this._register(new DisposableStore());

		// Handle external cancellation token
		if (_token.isCancellationRequested) {
			this._lastTaskState.set({ ...this._task, status: 'cancelled' }, undefined);
		} else {
			store.add(_token.onCancellationRequested(() => {
				const current = this._lastTaskState.get();
				if (!isTaskInTerminalState(current)) {
					this._lastTaskState.set({ ...current, status: 'cancelled' }, undefined);
				}
			}));
		}

		// Handle TTL expiration with an explicit timeout
		if (expiresAt) {
			const ttlTimeout = expiresAt - Date.now();
			if (ttlTimeout <= 0) {
				this._lastTaskState.set({ ...this._task, status: 'cancelled', statusMessage: 'Task timed out.' }, undefined);
			} else {
				store.add(disposableTimeout(() => {
					const current = this._lastTaskState.get();
					if (!isTaskInTerminalState(current)) {
						this._lastTaskState.set({ ...current, status: 'cancelled', statusMessage: 'Task timed out.' }, undefined);
					}
				}, ttlTimeout));
			}
		}

		// A `tasks/result` call triggered by an input_required state.
		const inputRequiredLookup = observableValue<ObservablePromise<MCP.Task> | undefined>('activeResultLookup', undefined);

		// 1. Poll for task updates when the task isn't in a terminal state
		store.add(autorun(reader => {
			const current = this._lastTaskState.read(reader);
			if (isTaskInTerminalState(current)) {
				return;
			}

			// When a task goes into the input_required state, by spec we should call
			// `tasks/result` which can return an SSE stream of task updates. No need
			// to poll while such a lookup is going on, but once it resolves we should
			// clear and update our state.
			const lookup = inputRequiredLookup.read(reader);
			if (lookup) {
				const result = lookup.promiseResult.read(reader);
				return transaction(tx => {
					if (!result) {
						// still ongoing
					} else if (result.data) {
						inputRequiredLookup.set(undefined, tx);
						this._lastTaskState.set(result.data, tx);
					} else {
						inputRequiredLookup.set(undefined, tx);
						if (result.error instanceof McpError && result.error.code === MCP.INVALID_PARAMS) {
							this._lastTaskState.set({ ...current, status: 'cancelled' }, undefined);
						} else {
							// Maybe a connection error -- start polling again
							this._lastTaskState.set({ ...current, status: 'working' }, undefined);
						}
					}
				});
			}

			const handler = this._handler.read(reader);
			if (!handler) {
				return;
			}

			const pollInterval = _task.pollInterval ?? 2000;
			const cts = new CancellationTokenSource(_token);
			reader.store.add(toDisposable(() => cts.dispose(true)));
			reader.store.add(disposableTimeout(() => {
				handler.getTask({ taskId: current.taskId }, cts.token)
					.catch((e): MCP.Task | undefined => {
						if (e instanceof McpError && e.code === MCP.INVALID_PARAMS) {
							return { ...current, status: 'cancelled' };
						} else {
							return { ...current }; // errors are already logged, keep in current state
						}
					})
					.then(r => {
						if (r && !cts.token.isCancellationRequested) {
							this._lastTaskState.set(r, undefined);
						}
					});
			}, pollInterval));
		}));

		// 2. Get the result once it's available (or propagate errors). Trigger
		// input_required handling as needed. Only react when the status itself changes.
		const lastStatus = this._lastTaskState.map(task => task.status);
		store.add(autorun(reader => {
			const status = lastStatus.read(reader);
			if (status === 'failed') {
				const current = this._lastTaskState.read(undefined);
				this.promise.error(new Error(`Task ${current.taskId} failed: ${current.statusMessage ?? 'unknown error'}`));
				store.dispose();
			} else if (status === 'cancelled') {
				this.promise.cancel();
				store.dispose();
			} else if (status === 'input_required') {
				const handler = this._handler.read(reader);
				if (handler) {
					const current = this._lastTaskState.read(undefined);
					const cts = new CancellationTokenSource(_token);
					reader.store.add(toDisposable(() => cts.dispose(true)));
					inputRequiredLookup.set(new ObservablePromise<MCP.Task>(handler.getTask({ taskId: current.taskId }, cts.token)), undefined);
				}
			} else if (status === 'completed') {
				const handler = this._handler.read(reader);
				if (handler) {
					this.promise.settleWith(handler.getTaskResult({ taskId: _task.taskId }, _token) as Promise<T>);
					store.dispose();
				}
			} else if (status === 'working') {
				// no-op
			} else {
				softAssertNever(status);
			}
		}));
	}

	onDidUpdateState(task: MCP.Task) {
		this._lastTaskState.set(task, undefined);
		if (task.statusMessage && this._onStatusMessage) {
			this._onStatusMessage(task.statusMessage);
		}
	}

	setHandler(handler: McpServerRequestHandler | undefined): void {
		this._handler.set(handler, undefined);
	}
}
