/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { chatSummaryFromState, MessageKind, ResponsePartKind, SessionStatus, ToolCallConfirmationReason, ToolCallStatus, type ChatState, type ResponsePart, type ToolCallState } from '../../../common/state/sessionState.js';

/** A tool call awaiting confirmation, optionally flagged for setting-driven auto-approval. */
function pendingToolCall(toolCallId: string, autoApprove: boolean): ResponsePart {
	const toolCall: ToolCallState = {
		status: ToolCallStatus.PendingConfirmation,
		toolCallId,
		toolName: 'browser_navigate',
		displayName: 'Navigate Browser',
		invocationMessage: 'Navigate',
		confirmationTitle: 'Navigate',
		...(autoApprove ? { _meta: { autoApproveBySetting: true } } : {}),
	};
	return { kind: ResponsePartKind.ToolCall, toolCall };
}

/**
 * A tool call awaiting *result* confirmation (a post-execution gate). Even when
 * the parameter confirmation was auto-approved (so `autoApproveBySetting` is
 * preserved on the call), the result gate is a genuine user prompt.
 */
function pendingResultToolCall(toolCallId: string, autoApprove: boolean): ResponsePart {
	const toolCall: ToolCallState = {
		status: ToolCallStatus.PendingResultConfirmation,
		toolCallId,
		toolName: 'browser_navigate',
		displayName: 'Navigate Browser',
		invocationMessage: 'Navigate',
		confirmed: ToolCallConfirmationReason.Setting,
		success: true,
		pastTenseMessage: 'Navigated',
		...(autoApprove ? { _meta: { autoApproveBySetting: true } } : {}),
	};
	return { kind: ResponsePartKind.ToolCall, toolCall };
}

/** A minimal {@link ChatState} with an active turn carrying the given response parts. */
function chatState(status: SessionStatus, parts: ResponsePart[]): ChatState {
	return {
		resource: 'agent-host-copilot:/session-1',
		title: 'Chat',
		status,
		modifiedAt: '2024-01-01T00:00:00.000Z',
		turns: [],
		activeTurn: { id: 'turn-1', message: { text: 'go', origin: { kind: MessageKind.User } }, responseParts: parts, usage: undefined },
	};
}

suite('chatSummaryFromState status projection', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('demotes InputNeeded to InProgress when caused solely by auto-approved confirmations', () => {
		// Preserves orthogonal flags (IsRead) while clearing the spurious InputNeeded activity.
		const state = chatState(SessionStatus.InputNeeded | SessionStatus.IsRead, [pendingToolCall('tc-auto', true)]);
		assert.strictEqual(chatSummaryFromState(state).status, SessionStatus.InProgress | SessionStatus.IsRead);
	});

	test('keeps InputNeeded for a genuine (non-auto-approved) confirmation', () => {
		const state = chatState(SessionStatus.InputNeeded, [pendingToolCall('tc-user', false)]);
		assert.strictEqual(chatSummaryFromState(state).status, SessionStatus.InputNeeded);
	});

	test('keeps InputNeeded when a genuine confirmation coexists with an auto-approved one', () => {
		const state = chatState(SessionStatus.InputNeeded, [pendingToolCall('tc-auto', true), pendingToolCall('tc-user', false)]);
		assert.strictEqual(chatSummaryFromState(state).status, SessionStatus.InputNeeded);
	});

	test('leaves non-InputNeeded statuses untouched', () => {
		const state = chatState(SessionStatus.InProgress, [pendingToolCall('tc-auto', true)]);
		assert.strictEqual(chatSummaryFromState(state).status, SessionStatus.InProgress);
	});

	test('keeps InputNeeded for a result confirmation even when the call was auto-approved', () => {
		// `autoApproveBySetting` describes the parameter gate; the post-execution
		// result gate is always a genuine user prompt and must not be demoted.
		const state = chatState(SessionStatus.InputNeeded, [pendingResultToolCall('tc-auto', true)]);
		assert.strictEqual(chatSummaryFromState(state).status, SessionStatus.InputNeeded);
	});
});
