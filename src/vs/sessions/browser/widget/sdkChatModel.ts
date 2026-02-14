/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Lightweight chat model that converts Copilot SDK session events into typed
 * chat parts. Mirrors the structure of VS Code's `IChatMarkdownContent`,
 * `IChatToolInvocation`, `IChatThinkingPart`, etc. but without the heavy
 * infrastructure (observables, code block collections, editor pools).
 *
 * This model owns the data; the `SdkChatWidget` renders from it.
 */

import { Emitter, Event } from '../../../base/common/event.js';
import { IMarkdownString, MarkdownString } from '../../../base/common/htmlContent.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ICopilotSessionEvent, type CopilotSessionEventType } from '../../../platform/copilotSdk/common/copilotSdkService.js';

// #region Part Types

/**
 * Discriminated union of all SDK chat part types.
 * The `kind` field mirrors the VS Code chat part convention.
 */
export type SdkChatPart =
	| ISdkMarkdownPart
	| ISdkThinkingPart
	| ISdkToolCallPart
	| ISdkProgressPart;

export interface ISdkMarkdownPart {
	readonly kind: 'markdownContent';
	content: IMarkdownString;
	/** True while streaming deltas are still arriving. */
	isStreaming: boolean;
}

export interface ISdkThinkingPart {
	readonly kind: 'thinking';
	content: string;
	isStreaming: boolean;
}

export interface ISdkToolCallPart {
	readonly kind: 'toolInvocation';
	readonly toolName: string;
	readonly toolCallId?: string;
	state: 'running' | 'complete';
	result?: string;
}

export interface ISdkProgressPart {
	readonly kind: 'progress';
	readonly message: string;
}

// #endregion

// #region Turn Types

export interface ISdkChatTurn {
	readonly id: string;
	readonly role: 'user' | 'assistant';
	readonly parts: SdkChatPart[];
	isComplete: boolean;
}

// #endregion

// #region Change Events

export interface ISdkChatModelChange {
	readonly type: 'turnAdded' | 'partAdded' | 'partUpdated' | 'turnCompleted';
	readonly turnId: string;
	readonly partIndex?: number;
}

// #endregion

// #region Model

export class SdkChatModel extends Disposable {

	private readonly _turns: ISdkChatTurn[] = [];
	private _turnCounter = 0;

	private readonly _onDidChange = this._register(new Emitter<ISdkChatModelChange>());
	readonly onDidChange: Event<ISdkChatModelChange> = this._onDidChange.event;

	get turns(): readonly ISdkChatTurn[] {
		return this._turns;
	}

	/**
	 * Add a user message turn.
	 */
	addUserMessage(content: string): ISdkChatTurn {
		const turn: ISdkChatTurn = {
			id: `user-${++this._turnCounter}`,
			role: 'user',
			parts: [{
				kind: 'markdownContent',
				content: new MarkdownString(content),
				isStreaming: false,
			}],
			isComplete: true,
		};
		this._turns.push(turn);
		this._onDidChange.fire({ type: 'turnAdded', turnId: turn.id });
		return turn;
	}

	/**
	 * Process an SDK session event and update the model accordingly.
	 * Returns the affected turn (creates a new assistant turn if needed).
	 */
	handleEvent(event: ICopilotSessionEvent): ISdkChatTurn | undefined {
		const type = event.type as CopilotSessionEventType;

		switch (type) {
			case 'user.message':
				// Usually handled by addUserMessage before send, but handle replays
				return this._ensureUserTurn(event.data.content as string ?? '');

			case 'assistant.message_delta':
				return this._handleAssistantDelta(event.data.deltaContent ?? '');

			case 'assistant.message':
				return this._handleAssistantComplete(event.data.content ?? '');

			case 'assistant.reasoning_delta':
				return this._handleReasoningDelta(event.data.deltaContent ?? '');

			case 'assistant.reasoning':
				return this._handleReasoningComplete();

			case 'tool.execution_start':
				return this._handleToolStart(event.data.toolName ?? 'unknown', event.data.toolCallId as string | undefined);

			case 'tool.execution_complete':
				return this._handleToolComplete(event.data.toolName ?? 'unknown');

			case 'session.idle':
				return this._handleSessionIdle();

			case 'session.compaction_start':
				return this._addProgressToAssistantTurn('Compacting context...');

			case 'session.compaction_complete':
				return this._addProgressToAssistantTurn('Context compacted');

			default:
				return undefined;
		}
	}

	/**
	 * Clear all turns.
	 */
	clear(): void {
		this._turns.length = 0;
		this._turnCounter = 0;
	}

	// --- Private helpers ---

	private _ensureUserTurn(content: string): ISdkChatTurn {
		// If the last turn is already a user turn with matching content, skip
		const last = this._turns[this._turns.length - 1];
		if (last?.role === 'user') {
			return last;
		}
		return this.addUserMessage(content);
	}

	private _getOrCreateAssistantTurn(): ISdkChatTurn {
		const last = this._turns[this._turns.length - 1];
		if (last?.role === 'assistant' && !last.isComplete) {
			return last;
		}
		const turn: ISdkChatTurn = {
			id: `assistant-${++this._turnCounter}`,
			role: 'assistant',
			parts: [],
			isComplete: false,
		};
		this._turns.push(turn);
		this._onDidChange.fire({ type: 'turnAdded', turnId: turn.id });
		return turn;
	}

	private _handleAssistantDelta(delta: string): ISdkChatTurn {
		const turn = this._getOrCreateAssistantTurn();
		const lastPart = turn.parts[turn.parts.length - 1];

		if (lastPart?.kind === 'markdownContent' && lastPart.isStreaming) {
			// Append to existing streaming markdown part
			const current = lastPart.content.value;
			lastPart.content = new MarkdownString(current + delta, { supportThemeIcons: true });
			this._onDidChange.fire({ type: 'partUpdated', turnId: turn.id, partIndex: turn.parts.length - 1 });
		} else {
			// Start a new markdown part
			const part: ISdkMarkdownPart = {
				kind: 'markdownContent',
				content: new MarkdownString(delta, { supportThemeIcons: true }),
				isStreaming: true,
			};
			turn.parts.push(part);
			this._onDidChange.fire({ type: 'partAdded', turnId: turn.id, partIndex: turn.parts.length - 1 });
		}
		return turn;
	}

	private _handleAssistantComplete(content: string): ISdkChatTurn {
		const turn = this._getOrCreateAssistantTurn();
		const lastPart = turn.parts[turn.parts.length - 1];

		if (lastPart?.kind === 'markdownContent') {
			lastPart.isStreaming = false;
			if (content) {
				lastPart.content = new MarkdownString(content, { supportThemeIcons: true });
			}
			this._onDidChange.fire({ type: 'partUpdated', turnId: turn.id, partIndex: turn.parts.length - 1 });
		}
		return turn;
	}

	private _handleReasoningDelta(delta: string): ISdkChatTurn {
		const turn = this._getOrCreateAssistantTurn();
		const lastPart = turn.parts[turn.parts.length - 1];

		if (lastPart?.kind === 'thinking' && lastPart.isStreaming) {
			lastPart.content += delta;
			this._onDidChange.fire({ type: 'partUpdated', turnId: turn.id, partIndex: turn.parts.length - 1 });
		} else {
			const part: ISdkThinkingPart = {
				kind: 'thinking',
				content: delta,
				isStreaming: true,
			};
			turn.parts.push(part);
			this._onDidChange.fire({ type: 'partAdded', turnId: turn.id, partIndex: turn.parts.length - 1 });
		}
		return turn;
	}

	private _handleReasoningComplete(): ISdkChatTurn | undefined {
		const turn = this._turns[this._turns.length - 1];
		if (!turn || turn.role !== 'assistant') {
			return undefined;
		}
		const thinkingPart = turn.parts.findLast(p => p.kind === 'thinking' && p.isStreaming);
		if (thinkingPart && thinkingPart.kind === 'thinking') {
			thinkingPart.isStreaming = false;
			const idx = turn.parts.indexOf(thinkingPart);
			this._onDidChange.fire({ type: 'partUpdated', turnId: turn.id, partIndex: idx });
		}
		return turn;
	}

	private _handleToolStart(toolName: string, toolCallId?: string): ISdkChatTurn {
		const turn = this._getOrCreateAssistantTurn();
		const part: ISdkToolCallPart = {
			kind: 'toolInvocation',
			toolName,
			toolCallId,
			state: 'running',
		};
		turn.parts.push(part);
		this._onDidChange.fire({ type: 'partAdded', turnId: turn.id, partIndex: turn.parts.length - 1 });
		return turn;
	}

	private _handleToolComplete(toolName: string): ISdkChatTurn | undefined {
		const turn = this._turns[this._turns.length - 1];
		if (!turn || turn.role !== 'assistant') {
			return undefined;
		}
		const toolPart = turn.parts.findLast(p => p.kind === 'toolInvocation' && p.toolName === toolName && p.state === 'running');
		if (toolPart && toolPart.kind === 'toolInvocation') {
			toolPart.state = 'complete';
			const idx = turn.parts.indexOf(toolPart);
			this._onDidChange.fire({ type: 'partUpdated', turnId: turn.id, partIndex: idx });
		}
		return turn;
	}

	private _handleSessionIdle(): ISdkChatTurn | undefined {
		const turn = this._turns[this._turns.length - 1];
		if (turn?.role === 'assistant' && !turn.isComplete) {
			turn.isComplete = true;
			// Finalize any streaming parts
			for (const part of turn.parts) {
				if (part.kind === 'markdownContent' && part.isStreaming) {
					part.isStreaming = false;
				}
				if (part.kind === 'thinking' && part.isStreaming) {
					part.isStreaming = false;
				}
			}
			this._onDidChange.fire({ type: 'turnCompleted', turnId: turn.id });
		}
		return turn;
	}

	private _addProgressToAssistantTurn(message: string): ISdkChatTurn {
		const turn = this._getOrCreateAssistantTurn();
		const part: ISdkProgressPart = { kind: 'progress', message };
		turn.parts.push(part);
		this._onDidChange.fire({ type: 'partAdded', turnId: turn.id, partIndex: turn.parts.length - 1 });
		return turn;
	}
}

// #endregion
