/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { ExtHostChatDebugShape, IChatDebugEventDto, IChatDebugResolvedEventContentDto, MainContext, MainThreadChatDebugShape } from './extHost.protocol.js';
import { ChatDebugEventMessageContent, ChatDebugEventTextContent, ChatDebugGenericEvent, ChatDebugMessageContentType, ChatDebugModelTurnEvent, ChatDebugSubagentInvocationEvent, ChatDebugToolCallEvent, ChatDebugToolCallResult, ChatDebugUserMessageEvent, ChatDebugAgentResponseEvent } from './extHostTypes.js';
import { IExtHostRpcService } from './extHostRpcService.js';

export class ExtHostChatDebug extends Disposable implements ExtHostChatDebugShape {
	declare _serviceBrand: undefined;

	private readonly _proxy: MainThreadChatDebugShape;
	private _provider: vscode.ChatDebugLogProvider | undefined;
	private _nextHandle: number = 0;
	/** Progress pipelines keyed by `${handle}:${sessionId}` so multiple sessions can stream concurrently. */
	private readonly _activeProgress = new Map<string, DisposableStore>();

	constructor(
		@IExtHostRpcService extHostRpc: IExtHostRpcService,
	) {
		super();
		this._proxy = extHostRpc.getProxy(MainContext.MainThreadChatDebug);
	}

	private _progressKey(handle: number, sessionId: string): string {
		return `${handle}:${sessionId}`;
	}

	private _cleanupProgress(key: string): void {
		const store = this._activeProgress.get(key);
		if (store) {
			store.dispose();
			this._activeProgress.delete(key);
		}
	}

	registerChatDebugLogProvider(provider: vscode.ChatDebugLogProvider): vscode.Disposable {
		if (this._provider) {
			throw new Error('A ChatDebugLogProvider is already registered.');
		}
		this._provider = provider;
		const handle = this._nextHandle++;
		this._proxy.$registerChatDebugLogProvider(handle);

		return toDisposable(() => {
			this._provider = undefined;
			// Clean up all progress pipelines for this handle
			for (const [key, store] of this._activeProgress) {
				if (key.startsWith(`${handle}:`)) {
					store.dispose();
					this._activeProgress.delete(key);
				}
			}
			this._proxy.$unregisterChatDebugLogProvider(handle);
		});
	}

	async $provideChatDebugLog(handle: number, sessionId: string, token: CancellationToken): Promise<IChatDebugEventDto[] | undefined> {
		if (!this._provider) {
			return undefined;
		}

		// Clean up any previous progress pipeline for this handle+session pair
		const key = this._progressKey(handle, sessionId);
		this._cleanupProgress(key);

		const store = new DisposableStore();
		this._activeProgress.set(key, store);

		const emitter = store.add(new Emitter<vscode.ChatDebugEvent>());

		// Forward progress events to the main thread
		store.add(emitter.event(event => {
			const dto = this._serializeEvent(event);
			if (!dto.sessionId) {
				(dto as { sessionId?: string }).sessionId = sessionId;
			}
			this._proxy.$acceptChatDebugEvent(handle, dto);
		}));

		// Clean up when the token is cancelled
		store.add(token.onCancellationRequested(() => {
			this._cleanupProgress(key);
		}));

		try {
			const progress: vscode.Progress<vscode.ChatDebugEvent> = {
				report: (value) => emitter.fire(value)
			};

			const result = await this._provider.provideChatDebugLog(sessionId, progress, token);
			if (!result) {
				return undefined;
			}

			return result.map(event => this._serializeEvent(event));
		} catch (err) {
			this._cleanupProgress(key);
			throw err;
		}
		// Note: do NOT dispose progress pipeline here - keep it alive for
		// streaming events via progress.report() after the initial return.
		// It will be cleaned up when a new session is requested, the token
		// is cancelled, or the provider is unregistered.
	}

	private _serializeEvent(event: vscode.ChatDebugEvent): IChatDebugEventDto {
		const base = {
			id: event.id,
			sessionId: (event as { sessionId?: string }).sessionId,
			created: event.created.getTime(),
			parentEventId: event.parentEventId,
		};

		if (event instanceof ChatDebugToolCallEvent) {
			return {
				...base,
				kind: 'toolCall',
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				input: event.input,
				output: event.output,
				result: event.result === ChatDebugToolCallResult.Success ? 'success'
					: event.result === ChatDebugToolCallResult.Error ? 'error'
						: undefined,
				durationInMillis: event.durationInMillis,
			};
		} else if (event instanceof ChatDebugModelTurnEvent) {
			return {
				...base,
				kind: 'modelTurn',
				model: event.model,
				inputTokens: event.inputTokens,
				outputTokens: event.outputTokens,
				totalTokens: event.totalTokens,
				cost: event.cost,
				durationInMillis: event.durationInMillis,
			};
		} else if (event instanceof ChatDebugGenericEvent) {
			return {
				...base,
				kind: 'generic',
				name: event.name,
				details: event.details,
				level: event.level,
				category: event.category,
			};
		} else if (event instanceof ChatDebugSubagentInvocationEvent) {
			return {
				...base,
				kind: 'subagentInvocation',
				agentName: event.agentName,
				description: event.description,
				status: event.status,
				durationInMillis: event.durationInMillis,
				toolCallCount: event.toolCallCount,
				modelTurnCount: event.modelTurnCount,
			};
		} else if (event instanceof ChatDebugUserMessageEvent) {
			return {
				...base,
				kind: 'userMessage',
				message: event.message,
				sections: event.sections.map(s => ({ name: s.name, content: s.content })),
			};
		} else if (event instanceof ChatDebugAgentResponseEvent) {
			return {
				...base,
				kind: 'agentResponse',
				message: event.message,
				sections: event.sections.map(s => ({ name: s.name, content: s.content })),
			};
		}

		// Duck-type fallback: if instanceof fails (e.g. extension bundles its own
		// copy of the API types), detect the event kind by its unique properties.
		const duck = event as unknown as Record<string, unknown>;
		const ctorName = duck.constructor?.name;
		if (ctorName === 'ChatDebugToolCallEvent' || (typeof duck.toolName === 'string' && duck.toolCallId !== undefined)) {
			const e = event as vscode.ChatDebugToolCallEvent;
			return {
				...base,
				kind: 'toolCall',
				toolName: e.toolName,
				toolCallId: e.toolCallId,
				input: e.input,
				output: e.output,
				result: e.result === ChatDebugToolCallResult.Success ? 'success'
					: e.result === ChatDebugToolCallResult.Error ? 'error'
						: undefined,
				durationInMillis: e.durationInMillis,
			};
		} else if (ctorName === 'ChatDebugUserMessageEvent' || (Array.isArray(duck.sections) && typeof duck.message === 'string' && ctorName !== 'ChatDebugAgentResponseEvent')) {
			const e = event as vscode.ChatDebugUserMessageEvent;
			return {
				...base,
				kind: 'userMessage',
				message: e.message,
				sections: e.sections.map(s => ({ name: s.name, content: s.content })),
			};
		} else if (ctorName === 'ChatDebugAgentResponseEvent' || (Array.isArray(duck.sections) && typeof duck.message === 'string')) {
			const e = event as vscode.ChatDebugAgentResponseEvent;
			return {
				...base,
				kind: 'agentResponse',
				message: e.message,
				sections: e.sections.map(s => ({ name: s.name, content: s.content })),
			};
		} else if (ctorName === 'ChatDebugSubagentInvocationEvent' || typeof duck.agentName === 'string') {
			const e = event as vscode.ChatDebugSubagentInvocationEvent;
			return {
				...base,
				kind: 'subagentInvocation',
				agentName: e.agentName,
				description: e.description,
				status: e.status as unknown as 'running' | 'completed' | 'failed' | undefined,
				durationInMillis: e.durationInMillis,
				toolCallCount: e.toolCallCount,
				modelTurnCount: e.modelTurnCount,
			};
		} else if (ctorName === 'ChatDebugModelTurnEvent' || duck.inputTokens !== undefined || duck.outputTokens !== undefined || duck.totalTokens !== undefined) {
			const e = event as vscode.ChatDebugModelTurnEvent;
			return {
				...base,
				kind: 'modelTurn',
				model: e.model,
				inputTokens: e.inputTokens,
				outputTokens: e.outputTokens,
				totalTokens: e.totalTokens,
				cost: e.cost,
				durationInMillis: e.durationInMillis,
			};
		}

		// Final fallback: treat as generic
		console.warn('[chatDebug][extHost._serializeEvent] FALLBACK to generic! Event did not match any instanceof or duck-type check.', {
			constructor: event?.constructor?.name,
			keys: Object.keys(event),
			agentName: (event as { agentName?: string }).agentName,
		});
		const generic = event as vscode.ChatDebugGenericEvent;
		return {
			...base,
			kind: 'generic',
			name: generic.name ?? '',
			details: generic.details,
			level: generic.level ?? 1,
			category: generic.category,
		};
	}

	async $resolveChatDebugLogEvent(_handle: number, eventId: string, token: CancellationToken): Promise<IChatDebugResolvedEventContentDto | undefined> {
		if (!this._provider?.resolveChatDebugLogEvent) {
			return undefined;
		}
		const result = await this._provider.resolveChatDebugLogEvent(eventId, token);
		if (!result) {
			return undefined;
		}
		if (result instanceof ChatDebugEventTextContent) {
			return { kind: 'text', value: result.value };
		}
		if (result instanceof ChatDebugEventMessageContent) {
			return {
				kind: 'message',
				type: result.type === ChatDebugMessageContentType.User ? 'user' : 'agent',
				message: result.message,
				sections: result.sections.map(s => ({ name: s.name, content: s.content })),
			};
		}
		// Extensions may return ChatDebugUserMessageEvent / ChatDebugAgentResponseEvent
		// from resolveChatDebugLogEvent - convert them to message content DTOs.
		if (result instanceof ChatDebugUserMessageEvent) {
			return {
				kind: 'message',
				type: 'user',
				message: result.message,
				sections: result.sections.map(s => ({ name: s.name, content: s.content })),
			};
		}
		if (result instanceof ChatDebugAgentResponseEvent) {
			return {
				kind: 'message',
				type: 'agent',
				message: result.message,
				sections: result.sections.map(s => ({ name: s.name, content: s.content })),
			};
		}
		// Duck-type fallback for any object with sections + message
		const duck = result as unknown as Record<string, unknown>;
		if (Array.isArray(duck.sections) && typeof duck.message === 'string') {
			const ctorName = duck.constructor?.name;
			const isAgent = ctorName === 'ChatDebugAgentResponseEvent' || ctorName === 'ChatDebugEventMessageContent' && duck.type === ChatDebugMessageContentType.Agent;
			return {
				kind: 'message',
				type: isAgent ? 'agent' : 'user',
				message: duck.message as string,
				sections: (duck.sections as Array<{ name: string; content: string }>).map(s => ({ name: s.name, content: s.content })),
			};
		}
		return undefined;
	}

	override dispose(): void {
		for (const store of this._activeProgress.values()) {
			store.dispose();
		}
		this._activeProgress.clear();
		super.dispose();
	}
}
