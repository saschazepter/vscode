/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatDebugEvent } from '../../common/chatDebugService.js';

/**
 * Format the detail text for a debug event (used when no resolved content is available).
 */
export function formatEventDetail(event: IChatDebugEvent): string {
	switch (event.kind) {
		case 'toolCall': {
			const parts = [`Tool: ${event.toolName}`];
			if (event.toolCallId) { parts.push(`Call ID: ${event.toolCallId}`); }
			if (event.result) { parts.push(`Result: ${event.result}`); }
			if (event.durationInMillis !== undefined) { parts.push(`Duration: ${event.durationInMillis}ms`); }
			if (event.input) { parts.push(`\nInput:\n${event.input}`); }
			if (event.output) { parts.push(`\nOutput:\n${event.output}`); }
			return parts.join('\n');
		}
		case 'modelTurn': {
			const parts = [event.model ?? 'Model Turn'];
			if (event.inputTokens !== undefined) { parts.push(`Input tokens: ${event.inputTokens}`); }
			if (event.outputTokens !== undefined) { parts.push(`Output tokens: ${event.outputTokens}`); }
			if (event.totalTokens !== undefined) { parts.push(`Total tokens: ${event.totalTokens}`); }
			if (event.cost !== undefined) { parts.push(`Cost: $${event.cost.toFixed(4)}`); }
			if (event.durationInMillis !== undefined) { parts.push(`Duration: ${event.durationInMillis}ms`); }
			return parts.join('\n');
		}
		case 'generic':
			return `${event.name}\n${event.details ?? ''}`;
		case 'subagentInvocation': {
			const parts = [`Agent: ${event.agentName}`];
			if (event.description) { parts.push(`Description: ${event.description}`); }
			if (event.status) { parts.push(`Status: ${event.status}`); }
			if (event.durationInMillis !== undefined) { parts.push(`Duration: ${event.durationInMillis}ms`); }
			if (event.toolCallCount !== undefined) { parts.push(`Tool calls: ${event.toolCallCount}`); }
			if (event.modelTurnCount !== undefined) { parts.push(`Model turns: ${event.modelTurnCount}`); }
			return parts.join('\n');
		}
		case 'userMessage': {
			const parts = [`User Message: ${event.message}`];
			for (const section of event.sections) {
				parts.push(`\n--- ${section.name} ---\n${section.content}`);
			}
			return parts.join('\n');
		}
		case 'agentResponse': {
			const parts = [`Agent Response: ${event.message}`];
			for (const section of event.sections) {
				parts.push(`\n--- ${section.name} ---\n${section.content}`);
			}
			return parts.join('\n');
		}
	}
}
