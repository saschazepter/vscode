/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bridges the Copilot SDK event stream into a real `ChatModel`.
 *
 * Instead of faking view model interfaces, we use the actual `ChatModel`
 * + `ChatViewModel` + `ChatListWidget` from `vs/workbench/contrib/chat/`.
 * SDK events are converted into `IChatProgress` objects which are fed into
 * `ChatModel.acceptResponseProgress()` -- the same path used by the real
 * chat system. This gives us the full rendering infrastructure for free:
 * markdown, code blocks, tool invocations, thinking, etc.
 *
 * What we bypass: `ChatService.sendRequest()`, `ChatInputPart`, and all
 * copilot-chat extension business logic. The SDK handles the LLM
 * communication; this bridge handles the model plumbing.
 */

import { Disposable } from '../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../base/common/htmlContent.js';
import { URI } from '../../../base/common/uri.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { OffsetRange } from '../../../editor/common/core/ranges/offsetRange.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { ChatModel, ChatRequestModel } from '../../../workbench/contrib/chat/common/model/chatModel.js';
import { ChatViewModel } from '../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { ChatRequestTextPart, IParsedChatRequest } from '../../../workbench/contrib/chat/common/requestParser/chatParserTypes.js';
import { ChatAgentLocation } from '../../../workbench/contrib/chat/common/constants.js';
import { CodeBlockModelCollection } from '../../../workbench/contrib/chat/common/widget/codeBlockModelCollection.js';
import { ICopilotSdkService, ICopilotSessionEvent, type CopilotSessionEventType } from '../../../platform/copilotSdk/common/copilotSdkService.js';
import { CopilotSdkDebugLog } from '../copilotSdkDebugLog.js';

function makeParsedRequest(text: string): IParsedChatRequest {
	return {
		text,
		parts: [new ChatRequestTextPart(
			new OffsetRange(0, text.length),
			{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: text.length + 1 },
			text
		)],
	};
}

/**
 * Bridges SDK session events into a real `ChatModel` + `ChatViewModel`
 * that can drive `ChatListWidget`.
 */
export class SdkChatModelBridge extends Disposable {

	private readonly _chatModel: ChatModel;
	private readonly _chatViewModel: ChatViewModel;
	private readonly _codeBlockModelCollection: CodeBlockModelCollection;

	/** The current in-flight request (set between send and session.idle). */
	private _activeRequest: ChatRequestModel | undefined;
	private _sessionId: string | undefined;

	private readonly _onDidChangeSessionId = this._register(new Emitter<string | undefined>());
	readonly onDidChangeSessionId: Event<string | undefined> = this._onDidChangeSessionId.event;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICopilotSdkService private readonly _sdk: ICopilotSdkService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		// Create a real ChatModel -- no serialized data, fresh session
		this._chatModel = this._register(this._instantiationService.createInstance(
			ChatModel,
			undefined, // no serialized data
			{
				initialLocation: ChatAgentLocation.Chat,
				canUseTools: true,
				disableBackgroundKeepAlive: true, // prevents ChatService.getActiveSessionReference calls
			}
		));

		// Create CodeBlockModelCollection for the view model
		this._codeBlockModelCollection = this._register(
			this._instantiationService.createInstance(CodeBlockModelCollection, 'sdkChatBridge')
		);

		// Create a real ChatViewModel wrapping the model
		this._chatViewModel = this._register(this._instantiationService.createInstance(
			ChatViewModel,
			this._chatModel,
			this._codeBlockModelCollection,
			undefined, // no options
		));

		// Subscribe to SDK events
		this._register(this._sdk.onSessionEvent(event => {
			if (this._sessionId && event.sessionId !== this._sessionId) {
				return;
			}
			this._handleSdkEvent(event);
		}));
	}

	/**
	 * The `ChatViewModel` to pass to `ChatListWidget.setViewModel()`.
	 */
	get viewModel(): ChatViewModel {
		return this._chatViewModel;
	}

	/**
	 * The `ChatModel` for direct access.
	 */
	get chatModel(): ChatModel {
		return this._chatModel;
	}

	/**
	 * The `CodeBlockModelCollection` for the `ChatListWidget`.
	 */
	get codeBlockModelCollection(): CodeBlockModelCollection {
		return this._codeBlockModelCollection;
	}

	get sessionResource(): URI {
		return this._chatModel.sessionResource;
	}

	get sessionId(): string | undefined {
		return this._sessionId;
	}

	/**
	 * Add a user message and start expecting a response.
	 */
	addUserMessage(text: string): ChatRequestModel {
		CopilotSdkDebugLog.instance?.addEntry('\u2192', 'bridge.addUserMessage', text.substring(0, 80));
		const parsed = makeParsedRequest(text);
		const request = this._chatModel.addRequest(
			parsed,
			{ variables: [] },
			0, // attempt
		);
		this._activeRequest = request;
		return request;
	}

	/**
	 * Set the active SDK session ID.
	 */
	setSessionId(sessionId: string | undefined): void {
		CopilotSdkDebugLog.instance?.addEntry('\u2192', 'bridge.setSessionId', sessionId?.substring(0, 8) ?? 'none');
		this._sessionId = sessionId;
		this._onDidChangeSessionId.fire(sessionId);
	}

	/**
	 * Clear the model for a new session.
	 */
	clear(): void {
		this._activeRequest = undefined;
		this._sessionId = undefined;

		// Remove all requests from the model
		for (const request of [...this._chatModel.getRequests()]) {
			this._chatModel.removeRequest(request.id);
		}
		this._onDidChangeSessionId.fire(undefined);
	}

	/**
	 * Load a session's history by replaying SDK events through the model.
	 */
	async loadSession(sessionId: string): Promise<void> {
		CopilotSdkDebugLog.instance?.addEntry('\u2192', 'bridge.loadSession', sessionId.substring(0, 8));
		this.clear();
		this._sessionId = sessionId;
		this._onDidChangeSessionId.fire(sessionId);

		try {
			await this._sdk.resumeSession(sessionId, { streaming: true });
			const events = await this._sdk.getMessages(sessionId);

			for (const event of events) {
				this._handleSdkEvent(event);
			}
			CopilotSdkDebugLog.instance?.addEntry('\u2190', 'bridge.loadSession', `${events.length} events replayed`);
		} catch (err) {
			this._logService.error(`[SdkChatModelBridge] Failed to load session ${sessionId}:`, err);
		}
	}

	// --- SDK Event → ChatModel Progress ---

	private _handleSdkEvent(event: ICopilotSessionEvent): void {
		const type = event.type as CopilotSessionEventType;

		switch (type) {
			case 'user.message': {
				// During replay, add user messages we haven't added yet
				const text = (event.data.content as string) ?? '';
				if (text) {
					this.addUserMessage(text);
				}
				break;
			}

			case 'assistant.message_delta': {
				const delta = event.data.deltaContent ?? '';
				if (delta && this._activeRequest) {
					this._chatModel.acceptResponseProgress(this._activeRequest, {
						kind: 'markdownContent',
						content: new MarkdownString(delta),
					});
				}
				break;
			}

			case 'assistant.message': {
				// Final complete message -- the deltas already built the content,
				// so we just ensure the response is finalized
				break;
			}

			case 'assistant.reasoning_delta': {
				const delta = event.data.deltaContent ?? '';
				if (delta && this._activeRequest) {
					this._chatModel.acceptResponseProgress(this._activeRequest, {
						kind: 'thinking',
						value: delta,
					});
				}
				break;
			}

			case 'assistant.reasoning': {
				// Reasoning complete -- no action needed, the deltas already built it
				break;
			}

			case 'tool.execution_start': {
				const toolName = event.data.toolName ?? 'unknown';
				if (this._activeRequest) {
					this._chatModel.acceptResponseProgress(this._activeRequest, {
						kind: 'progressMessage',
						content: new MarkdownString(`Running ${toolName}...`),
					});
				}
				break;
			}

			case 'tool.execution_complete': {
				const toolName = event.data.toolName ?? 'unknown';
				if (this._activeRequest) {
					this._chatModel.acceptResponseProgress(this._activeRequest, {
						kind: 'progressMessage',
						content: new MarkdownString(`${toolName} completed`),
					});
				}
				break;
			}

			case 'session.idle': {
				if (this._activeRequest?.response) {
					this._activeRequest.response.setResult({ metadata: {} });
					this._activeRequest.response.complete();
				}
				this._activeRequest = undefined;
				break;
			}

			case 'session.compaction_start': {
				if (this._activeRequest) {
					this._chatModel.acceptResponseProgress(this._activeRequest, {
						kind: 'progressMessage',
						content: new MarkdownString('Compacting context...'),
					});
				}
				break;
			}

			case 'session.compaction_complete': {
				// No action needed
				break;
			}
		}
	}
}
