/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { ChatDebugLogLevel, IChatDebugService } from '../../contrib/chat/common/chatDebugService.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { ExtHostChatDebugShape, ExtHostContext, IChatDebugLogEventDto, MainContext, MainThreadChatDebugShape } from '../common/extHost.protocol.js';
import { Proxied } from '../../services/extensions/common/proxyIdentifier.js';

@extHostNamedCustomer(MainContext.MainThreadChatDebug)
export class MainThreadChatDebug extends Disposable implements MainThreadChatDebugShape {
	private readonly _proxy: Proxied<ExtHostChatDebugShape>;
	private readonly _providerDisposables = new Map<number, DisposableStore>();
	private readonly _activeSessionIds = new Map<number, string>();

	constructor(
		extHostContext: IExtHostContext,
		@IChatDebugService private readonly _chatDebugService: IChatDebugService,
	) {
		super();
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostChatDebug);
	}

	$registerChatDebugLogProvider(handle: number): void {
		const disposables = new DisposableStore();
		this._providerDisposables.set(handle, disposables);

		disposables.add(this._chatDebugService.registerProvider({
			provideChatDebugLog: async (sessionId, token) => {
				this._activeSessionIds.set(handle, sessionId);
				// Note: do NOT delete from _activeSessionIds after the call.
				// The session ID is needed for streaming events that arrive
				// via $acceptChatDebugLogEvent after the initial return.
				const dtos = await this._proxy.$provideChatDebugLog(handle, sessionId, token);
				return dtos?.map(dto => this._reviveEvent(dto, sessionId));
			},
			resolveChatDebugLogEvent: async (eventId, token) => {
				return this._proxy.$resolveChatDebugLogEvent(handle, eventId, token);
			}
		}));
	}

	$unregisterChatDebugLogProvider(handle: number): void {
		const disposables = this._providerDisposables.get(handle);
		disposables?.dispose();
		this._providerDisposables.delete(handle);
		this._activeSessionIds.delete(handle);
	}

	$acceptChatDebugLogEvent(handle: number, event: IChatDebugLogEventDto): void {
		const sessionId = this._activeSessionIds.get(handle) ?? this._chatDebugService.activeSessionId ?? '';
		this._chatDebugService.log(sessionId, event.name, event.details, event.level as ChatDebugLogLevel, {
			id: event.id,
			category: event.category,
			parentEventId: event.parentEventId,
		});
	}

	private _reviveEvent(dto: IChatDebugLogEventDto, sessionId?: string) {
		return {
			id: dto.id,
			sessionId: sessionId ?? this._chatDebugService.activeSessionId ?? '',
			created: new Date(dto.created),
			name: dto.name,
			details: dto.details,
			level: dto.level as ChatDebugLogLevel,
			category: dto.category,
			parentEventId: dto.parentEventId,
		};
	}
}
