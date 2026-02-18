/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ExtHostChatDebugShape, IChatDebugLogEventDto, MainContext, MainThreadChatDebugShape } from './extHost.protocol.js';
import { IExtHostRpcService } from './extHostRpcService.js';

export class ExtHostChatDebug extends Disposable implements ExtHostChatDebugShape {
	declare _serviceBrand: undefined;

	private readonly _proxy: MainThreadChatDebugShape;
	private _provider: vscode.ChatDebugLogProvider | undefined;
	private _providerHandle: number = 0;
	private readonly _progressEmitters = new Map<number, Emitter<vscode.ChatDebugLogEvent>>();

	constructor(
		@IExtHostRpcService extHostRpc: IExtHostRpcService,
	) {
		super();
		this._proxy = extHostRpc.getProxy(MainContext.MainThreadChatDebug);
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
			this._proxy.$unregisterChatDebugLogProvider(handle);
		});
	}

	async $provideChatDebugLog(handle: number, sessionId: string, token: CancellationToken): Promise<IChatDebugLogEventDto[] | undefined> {
		if (!this._provider) {
			return undefined;
		}

		const emitter = new Emitter<vscode.ChatDebugLogEvent>();
		this._progressEmitters.set(handle, emitter);

		// Forward progress events to the main thread
		const progressListener = emitter.event(event => {
			this._proxy.$acceptChatDebugLogEvent(handle, {
				created: event.created.getTime(),
				name: event.name,
				contents: event.contents,
				level: event.level,
			});
		});

		try {
			const progress: vscode.Progress<vscode.ChatDebugLogEvent> = {
				report: (value) => emitter.fire(value)
			};

			const result = await this._provider.provideChatDebugLog(sessionId, progress, token);
			if (!result) {
				return undefined;
			}

			return result.map(event => ({
				created: event.created.getTime(),
				name: event.name,
				contents: event.contents,
				level: event.level,
			}));
		} finally {
			progressListener.dispose();
			emitter.dispose();
			this._progressEmitters.delete(handle);
		}
	}
}
