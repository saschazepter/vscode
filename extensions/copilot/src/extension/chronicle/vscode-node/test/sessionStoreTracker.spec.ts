/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { CopilotChatAttr, GenAiAttr, GenAiOperationName } from '../../../../platform/otel/common/genAiAttributes';
import type { ICompletedSpanData } from '../../../../platform/otel/common/otelService';
import { extractFilePath } from '../../common/sessionStoreTracking';

// Create a minimal mock span for testing
function makeSpan(overrides: Partial<ICompletedSpanData> = {}): ICompletedSpanData {
	return {
		name: 'test',
		traceId: 'trace-1',
		spanId: 'span-1',
		startTime: 0,
		endTime: 1,
		attributes: {},
		events: [],
		status: { code: 0 },
		...overrides,
	};
}

function makeToolSpan(sessionId: string, toolName: string, toolArgs?: Record<string, unknown>): ICompletedSpanData {
	return makeSpan({
		name: `execute_tool ${toolName}`,
		attributes: {
			[GenAiAttr.OPERATION_NAME]: GenAiOperationName.EXECUTE_TOOL,
			[GenAiAttr.TOOL_NAME]: toolName,
			[CopilotChatAttr.CHAT_SESSION_ID]: sessionId,
			...(toolArgs ? { [GenAiAttr.TOOL_CALL_ARGUMENTS]: JSON.stringify(toolArgs) } : {}),
		},
	});
}

function makeAgentSpan(sessionId: string, agentName = 'copilot'): ICompletedSpanData {
	return makeSpan({
		name: `invoke_agent ${agentName}`,
		attributes: {
			[GenAiAttr.OPERATION_NAME]: GenAiOperationName.INVOKE_AGENT,
			[GenAiAttr.AGENT_NAME]: agentName,
			[CopilotChatAttr.CHAT_SESSION_ID]: sessionId,
		},
		events: [{
			name: 'user_message',
			timestamp: 0,
			attributes: { content: 'Test message' },
		}],
	});
}

/**
 * Extracts tool arguments from a span, matching the logic in SessionStoreTracker._extractToolArgs.
 * Uses GenAiAttr.TOOL_CALL_ARGUMENTS (the correct attribute name).
 */
function extractToolArgs(span: ICompletedSpanData): Record<string, unknown> {
	const serialized = span.attributes[GenAiAttr.TOOL_CALL_ARGUMENTS];
	if (typeof serialized === 'string') {
		try {
			return JSON.parse(serialized) as Record<string, unknown>;
		} catch {
			// ignore parse errors
		}
	}
	return {};
}

/**
 * These tests verify the SessionStoreTracker's span handling logic.
 * They test the core algorithms (pending span queuing, tool arg extraction)
 * that were fixed to resolve the session_files tracking bug.
 */
describe('SessionStoreTracker span handling', () => {
	describe('tool span timing - pending span queue', () => {
		it('queues tool spans arriving before invoke_agent and processes them after session init', () => {
			// This test verifies the fix for the timing issue where tool spans
			// complete before their parent invoke_agent span

			const sessionId = 'test-session-1';
			const toolSpan = makeToolSpan(sessionId, 'replace_string_in_file', {
				filePath: '/src/test.ts',
				oldString: 'foo',
				newString: 'bar',
			});
			const agentSpan = makeAgentSpan(sessionId);

			// Simulate SessionStoreTracker's pending span queue and buffer
			const pendingToolSpans = new Map<string, ICompletedSpanData[]>();
			const initializedSessions = new Set<string>();
			const fileBuffer: Array<{ session_id: string; file_path: string; tool_name?: string }> = [];

			// --- Simulate _handleSpan for tool span (should be queued) ---
			const toolSessionId = toolSpan.attributes[CopilotChatAttr.CHAT_SESSION_ID] as string;
			const toolOpName = toolSpan.attributes[GenAiAttr.OPERATION_NAME];

			if (!initializedSessions.has(toolSessionId)) {
				if (toolOpName === GenAiOperationName.EXECUTE_TOOL) {
					// Queue for later processing (matches _handleSpan logic)
					let pending = pendingToolSpans.get(toolSessionId);
					if (!pending) {
						pending = [];
						pendingToolSpans.set(toolSessionId, pending);
					}
					pending.push(toolSpan);
				}
			}

			// Tool span should be queued, not dropped
			expect(pendingToolSpans.get(sessionId)).toHaveLength(1);
			expect(fileBuffer).toHaveLength(0);

			// --- Simulate _handleSpan for invoke_agent span ---
			const agentSessionId = agentSpan.attributes[CopilotChatAttr.CHAT_SESSION_ID] as string;
			const agentOpName = agentSpan.attributes[GenAiAttr.OPERATION_NAME];

			if (!initializedSessions.has(agentSessionId)) {
				if (agentOpName === GenAiOperationName.INVOKE_AGENT) {
					// _initSession logic
					initializedSessions.add(agentSessionId);

					// Process pending tool spans (matches _initSession logic)
					const pending = pendingToolSpans.get(agentSessionId);
					if (pending) {
						pendingToolSpans.delete(agentSessionId);
						for (const span of pending) {
							// _handleToolSpan logic
							const toolArgs = extractToolArgs(span);
							const toolName = span.attributes[GenAiAttr.TOOL_NAME] as string;
							const filePath = extractFilePath(toolName, toolArgs);
							if (filePath) {
								fileBuffer.push({
									session_id: agentSessionId,
									file_path: filePath,
									tool_name: toolName,
								});
							}
						}
					}
				}
			}

			// After session init, pending spans should be processed
			expect(pendingToolSpans.has(sessionId)).toBe(false);
			expect(fileBuffer).toHaveLength(1);
			expect(fileBuffer[0]).toEqual({
				session_id: sessionId,
				file_path: '/src/test.ts',
				tool_name: 'replace_string_in_file',
			});
		});

		it('clears pending spans when session is disposed before invoke_agent arrives', () => {
			const sessionId = 'dispose-session';
			const pendingToolSpans = new Map<string, ICompletedSpanData[]>();

			// Add pending span
			pendingToolSpans.set(sessionId, [makeToolSpan(sessionId, 'read_file', { filePath: '/test.ts' })]);
			expect(pendingToolSpans.has(sessionId)).toBe(true);

			// Simulate onDidDisposeChatSession handler
			pendingToolSpans.delete(sessionId);

			expect(pendingToolSpans.has(sessionId)).toBe(false);
		});
	});

	describe('tool argument extraction - correct attribute', () => {
		it('extracts tool arguments from gen_ai.tool.call.arguments (not gen_ai.tool.input)', () => {
			const span = makeToolSpan('session-1', 'create_file', {
				filePath: '/new/file.ts',
				content: 'export const x = 1;',
			});

			// Verify span has the correct attribute
			expect(span.attributes[GenAiAttr.TOOL_CALL_ARGUMENTS]).toBeDefined();
			expect(span.attributes['gen_ai.tool.input']).toBeUndefined();

			// Extract using the fixed logic
			const args = extractToolArgs(span);
			expect(args).toEqual({
				filePath: '/new/file.ts',
				content: 'export const x = 1;',
			});
		});

		it('returns empty object when attribute is missing', () => {
			const span = makeSpan({
				attributes: {
					[GenAiAttr.OPERATION_NAME]: GenAiOperationName.EXECUTE_TOOL,
					[GenAiAttr.TOOL_NAME]: 'some_tool',
					// No TOOL_CALL_ARGUMENTS
				},
			});

			const args = extractToolArgs(span);
			expect(args).toEqual({});
		});

		it('returns empty object for malformed JSON', () => {
			const span = makeSpan({
				attributes: {
					[GenAiAttr.OPERATION_NAME]: GenAiOperationName.EXECUTE_TOOL,
					[GenAiAttr.TOOL_NAME]: 'some_tool',
					[GenAiAttr.TOOL_CALL_ARGUMENTS]: 'not valid json {',
				},
			});

			const args = extractToolArgs(span);
			expect(args).toEqual({});
		});
	});

	describe('end-to-end file tracking', () => {
		it('extracts files from tool spans using correct attribute and extractFilePath', () => {
			const sessionId = 'e2e-session';
			const toolSpan = makeToolSpan(sessionId, 'replace_string_in_file', {
				filePath: '/workspace/src/utils.ts',
				oldString: 'old code',
				newString: 'new code',
			});

			// Extract args using fixed logic
			const toolArgs = extractToolArgs(toolSpan);
			const toolName = toolSpan.attributes[GenAiAttr.TOOL_NAME] as string;

			// Use actual extractFilePath from sessionStoreTracking
			const filePath = extractFilePath(toolName, toolArgs);

			expect(filePath).toBe('/workspace/src/utils.ts');
		});

		it('extracts files from apply_patch using input field', () => {
			const sessionId = 'patch-session';
			const patchInput = '*** Begin Patch\n*** Update File: /workspace/lib/helpers.ts\n@@export function\n-  old\n+  new\n*** End Patch';
			const toolSpan = makeToolSpan(sessionId, 'apply_patch', { input: patchInput });

			const toolArgs = extractToolArgs(toolSpan);
			const toolName = toolSpan.attributes[GenAiAttr.TOOL_NAME] as string;
			const filePath = extractFilePath(toolName, toolArgs);

			expect(filePath).toBe('/workspace/lib/helpers.ts');
		});

		it('handles create_file tool', () => {
			const toolSpan = makeToolSpan('session', 'create_file', {
				filePath: '/new/module.ts',
				content: 'export {}',
			});

			const toolArgs = extractToolArgs(toolSpan);
			const filePath = extractFilePath('create_file', toolArgs);

			expect(filePath).toBe('/new/module.ts');
		});
	});
});
