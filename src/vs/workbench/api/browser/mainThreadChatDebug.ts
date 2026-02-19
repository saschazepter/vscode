/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { ChatDebugLogLevel, IChatDebugEvent, IChatDebugService } from '../../contrib/chat/common/chatDebugService.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { ExtHostChatDebugShape, ExtHostContext, IChatDebugEventDto, MainContext, MainThreadChatDebugShape } from '../common/extHost.protocol.js';
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

	$acceptChatDebugEvent(handle: number, dto: IChatDebugEventDto): void {
		const sessionId = dto.sessionId ?? this._activeSessionIds.get(handle) ?? this._chatDebugService.activeSessionId ?? '';
		const revived = this._reviveEvent(dto, sessionId);
		this._chatDebugService.addEvent(revived);
	}

	private _reviveEvent(dto: IChatDebugEventDto, sessionId: string): IChatDebugEvent {
		const base = {
			id: dto.id,
			sessionId,
			created: new Date(dto.created),
			parentEventId: dto.parentEventId,
		};

		switch (dto.kind) {
			case 'toolCall':
				return {
					...base,
					kind: 'toolCall',
					toolName: dto.toolName,
					toolCallId: dto.toolCallId,
					input: dto.input,
					output: dto.output,
					result: dto.result,
					durationInMillis: dto.durationInMillis,
				};
			case 'modelTurn':
				return {
					...base,
					kind: 'modelTurn',
					model: dto.model,
					inputTokens: dto.inputTokens,
					outputTokens: dto.outputTokens,
					totalTokens: dto.totalTokens,
					cost: dto.cost,
					durationInMillis: dto.durationInMillis,
				};
			case 'generic':
				return {
					...base,
					kind: 'generic',
					name: dto.name,
					details: dto.details,
					level: dto.level as ChatDebugLogLevel,
					category: dto.category,
				};
			case 'subagentInvocation':
				return {
					...base,
					kind: 'subagentInvocation',
					agentName: dto.agentName,
					description: dto.description,
					status: dto.status,
					durationInMillis: dto.durationInMillis,
					toolCallCount: dto.toolCallCount,
					modelTurnCount: dto.modelTurnCount,
				};
		}
	}
}
