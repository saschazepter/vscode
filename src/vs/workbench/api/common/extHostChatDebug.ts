/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { ExtHostChatDebugShape, IChatDebugLogEventDto, MainContext, MainThreadChatDebugShape } from './extHost.protocol.js';
import { IExtHostRpcService } from './extHostRpcService.js';

export class ExtHostChatDebug extends Disposable implements ExtHostChatDebugShape {
	declare _serviceBrand: undefined;

	private readonly _proxy: MainThreadChatDebugShape;
	private _provider: vscode.ChatDebugLogProvider | undefined;
	private _providerHandle: number = 0;
	private readonly _activeProgress = new Map<number, DisposableStore>();

	constructor(
		@IExtHostRpcService extHostRpc: IExtHostRpcService,
	) {
		super();
		this._proxy = extHostRpc.getProxy(MainContext.MainThreadChatDebug);
	}

	private _cleanupProgress(handle: number): void {
		const store = this._activeProgress.get(handle);
		if (store) {
			store.dispose();
			this._activeProgress.delete(handle);
		}
	}

	registerChatDebugLogProvider(provider: vscode.ChatDebugLogProvider): vscode.Disposable {
		if (this._provider) {
			throw new Error('A ChatDebugLogProvider is already registered.');
		}
		this._provider = provider;
		const handle = this._providerHandle++;
		this._proxy.$registerChatDebugLogProvider(handle);

		return toDisposable(() => {
			this._provider = undefined;
			this._cleanupProgress(handle);
			this._proxy.$unregisterChatDebugLogProvider(handle);
		});
	}

	async $provideChatDebugLog(handle: number, sessionId: string, token: CancellationToken): Promise<IChatDebugLogEventDto[] | undefined> {
		if (!this._provider) {
			return undefined;
		}

		// Clean up any previous progress pipeline for this handle
		this._cleanupProgress(handle);

		const store = new DisposableStore();
		this._activeProgress.set(handle, store);

		const emitter = store.add(new Emitter<vscode.ChatDebugLogEvent>());

		// Forward progress events to the main thread
		store.add(emitter.event(event => {
			this._proxy.$acceptChatDebugLogEvent(handle, {
				id: event.id,
				created: event.created.getTime(),
				name: event.name,
				details: event.details,
				level: event.level,
				category: event.category,
				parentEventId: event.parentEventId,
			});
		}));

		// Clean up when the token is cancelled
		store.add(token.onCancellationRequested(() => {
			this._cleanupProgress(handle);
		}));

		try {
			const progress: vscode.Progress<vscode.ChatDebugLogEvent> = {
				report: (value) => emitter.fire(value)
			};

			const result = await this._provider.provideChatDebugLog(sessionId, progress, token);
			if (!result) {
				return undefined;
			}

			return result.map(event => ({
				id: event.id,
				created: event.created.getTime(),
				name: event.name,
				details: event.details,
				level: event.level,
				category: event.category,
				parentEventId: event.parentEventId,
			}));
		} catch (err) {
			this._cleanupProgress(handle);
			throw err;
		}
		// Note: do NOT dispose progress pipeline here - keep it alive for
		// streaming events via progress.report() after the initial return.
		// It will be cleaned up when a new session is requested, the token
		// is cancelled, or the provider is unregistered.
	}

	async $resolveChatDebugLogEvent(_handle: number, eventId: string, token: CancellationToken): Promise<string | undefined> {
		if (!this._provider?.resolveChatDebugLogEvent) {
			return undefined;
		}
		const result = await this._provider.resolveChatDebugLogEvent(eventId, token);
		return result ?? undefined;
	}

	override dispose(): void {
		for (const store of this._activeProgress.values()) {
			store.dispose();
		}
		this._activeProgress.clear();
		super.dispose();
	}
}
