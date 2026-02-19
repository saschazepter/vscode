/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { IChatDebugEvent } from '../../common/chatDebugService.js';

export interface ISubagentData {
	name: string;
	description?: string;
	status?: string;
	toolCalls: number;
	modelTurns: number;
	durationMs?: number;
	childEvents: readonly IChatDebugEvent[];
}

/**
 * Derive subagent info from events:
 * - Explicit `subagentInvocation` events
 * - `toolCall` events where toolName is 'runSubagent'
 * - `toolCall` events that have a parentEventId matching a subagent
 */
export function deriveSubagentData(events: readonly IChatDebugEvent[]): ISubagentData[] {
	const subagents: Map<string, { name: string; description?: string; status?: string; toolCalls: number; modelTurns: number; durationMs?: number; childEvents: IChatDebugEvent[] }> = new Map();

	// Collect from explicit subagentInvocation events
	for (const event of events) {
		if (event.kind === 'subagentInvocation') {
			const key = event.id ?? event.agentName;
			subagents.set(key, {
				name: event.agentName,
				description: event.description,
				status: event.status,
				toolCalls: event.toolCallCount ?? 0,
				modelTurns: event.modelTurnCount ?? 0,
				durationMs: event.durationInMillis,
				childEvents: [],
			});
		}
	}

	// Collect from runSubagent tool calls
	for (const event of events) {
		if (event.kind === 'toolCall' && event.toolName === 'runSubagent') {
			const key = event.id ?? `runSubagent-${event.created.getTime()}`;
			if (!subagents.has(key)) {
				// Try to extract agent name from input JSON
				let agentName = 'Subagent';
				let description: string | undefined;
				if (event.input) {
					try {
						const parsed: { agentName?: string; description?: string } = JSON.parse(event.input);
						agentName = parsed.agentName ?? 'Subagent';
						description = parsed.description;
					} catch {
						// best effort
					}
				}
				subagents.set(key, {
					name: agentName,
					description,
					status: event.result,
					toolCalls: 0,
					modelTurns: 0,
					durationMs: event.durationInMillis,
					childEvents: [],
				});
			}
		}
	}

	// Attach child events (by parentEventId)
	for (const event of events) {
		if (event.parentEventId && subagents.has(event.parentEventId)) {
			const sub = subagents.get(event.parentEventId)!;
			(sub.childEvents as IChatDebugEvent[]).push(event);
			if (event.kind === 'toolCall') {
				sub.toolCalls++;
			} else if (event.kind === 'modelTurn') {
				sub.modelTurns++;
			}
		}
	}

	return [...subagents.values()];
}

/**
 * Generate a Mermaid flowchart from events, showing main agent flow
 * with subagent invocations as subgraphs.
 */
export function generateSubagentFlowchart(events: readonly IChatDebugEvent[]): string {
	const subagents = deriveSubagentData(events);
	const modelTurns = events.filter(e => e.kind === 'modelTurn');
	const mainToolCalls = events.filter(e => e.kind === 'toolCall' && e.toolName !== 'runSubagent' && !e.parentEventId);

	const lines: string[] = [];
	lines.push('flowchart TD');

	// Start node
	lines.push('    start([Start]) --> mainAgent');
	lines.push(`    mainAgent["Main Agent<br/>${modelTurns.length} model turns<br/>${mainToolCalls.length} tool calls"]`);

	if (subagents.length === 0) {
		lines.push('    mainAgent --> finish([End])');
	} else {
		// Connect main agent to each subagent
		for (let i = 0; i < subagents.length; i++) {
			const sub = subagents[i];
			const nodeId = `sub${i}`;
			const statusIcon = sub.status === 'failed' ? '&#10060;' : sub.status === 'completed' ? '&#9989;' : '&#9654;';

			lines.push('');
			lines.push(`    mainAgent --> ${nodeId}`);
			lines.push(`    subgraph ${nodeId}_group["${sub.name}"]`);
			lines.push(`        ${nodeId}["${statusIcon} ${sub.name}<br/>${sub.description ? sub.description.substring(0, 50) + '<br/>' : ''}${sub.modelTurns} model turns, ${sub.toolCalls} tool calls${sub.durationMs !== undefined ? '<br/>' + sub.durationMs + 'ms' : ''}"]`);

			// Show top tool calls for this subagent
			const childTools = sub.childEvents.filter(e => e.kind === 'toolCall');
			const toolNames = new Map<string, number>();
			for (const tc of childTools) {
				if (tc.kind === 'toolCall') {
					toolNames.set(tc.toolName, (toolNames.get(tc.toolName) ?? 0) + 1);
				}
			}
			if (toolNames.size > 0) {
				const toolSummary = [...toolNames.entries()]
					.sort((a, b) => b[1] - a[1])
					.slice(0, 5)
					.map(([name, count]) => `${name} x${count}`)
					.join('<br/>');
				lines.push(`        ${nodeId}_tools["Tools:<br/>${toolSummary}"]`);
				lines.push(`        ${nodeId} --> ${nodeId}_tools`);
			}

			lines.push('    end');
			lines.push(`    ${nodeId}_group --> mainAgent_return${i}(["Return to Main Agent"])`);
		}

		// Final node
		const lastIdx = subagents.length - 1;
		lines.push(`    mainAgent_return${lastIdx} --> finish([End])`);

		// Connect intermediate returns
		for (let i = 0; i < lastIdx; i++) {
			lines.push(`    mainAgent_return${i} --> mainAgent`);
		}
	}

	// Styling
	lines.push('');
	lines.push('    classDef mainNode fill:#4a9eff,stroke:#2b7de9,color:#fff');
	lines.push('    classDef subNode fill:#9c27b0,stroke:#7b1fa2,color:#fff');
	lines.push('    classDef toolNode fill:#455a64,stroke:#37474f,color:#cfd8dc');
	lines.push('    classDef returnNode fill:#66bb6a,stroke:#43a047,color:#fff');
	lines.push('    class mainAgent mainNode');

	for (let i = 0; i < subagents.length; i++) {
		lines.push(`    class sub${i} subNode`);
		lines.push(`    class sub${i}_tools toolNode`);
		lines.push(`    class mainAgent_return${i} returnNode`);
	}

	return lines.join('\n');
}

/**
 * Render a simple visual HTML/CSS flow representation of the subagent invocations.
 */
export function renderVisualFlow(container: HTMLElement, events: readonly IChatDebugEvent[]): void {
	const subagents = deriveSubagentData(events);

	if (subagents.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'chat-debug-subagent-flow-empty';
		empty.textContent = localize('chatDebug.noSubagents', "No subagent invocations detected in this session.");
		container.appendChild(empty);
		return;
	}

	// Main agent node
	const mainNode = document.createElement('div');
	mainNode.className = 'chat-debug-flow-node chat-debug-flow-main';
	mainNode.textContent = localize('chatDebug.mainAgent', "Main Agent");
	container.appendChild(mainNode);

	for (const sub of subagents) {
		// Arrow
		const arrow = document.createElement('div');
		arrow.className = 'chat-debug-flow-arrow';
		arrow.textContent = '\u2193'; // ↓
		container.appendChild(arrow);

		// Subagent node
		const subNode = document.createElement('div');
		subNode.className = 'chat-debug-flow-node chat-debug-flow-subagent';

		const nameEl = document.createElement('div');
		nameEl.className = 'chat-debug-flow-subagent-name';
		const statusIcon = sub.status === 'failed' ? '\u274C' : sub.status === 'completed' ? '\u2705' : '\u25B6';
		nameEl.textContent = `${statusIcon} ${sub.name}`;
		subNode.appendChild(nameEl);

		if (sub.description) {
			const descEl = document.createElement('div');
			descEl.className = 'chat-debug-flow-subagent-desc';
			descEl.textContent = sub.description.length > 60 ? sub.description.substring(0, 60) + '...' : sub.description;
			subNode.appendChild(descEl);
		}

		const statsEl = document.createElement('div');
		statsEl.className = 'chat-debug-flow-subagent-stats';
		const parts: string[] = [];
		if (sub.modelTurns > 0) {
			parts.push(localize('chatDebug.flowModelTurns', "{0} model turns", sub.modelTurns));
		}
		if (sub.toolCalls > 0) {
			parts.push(localize('chatDebug.flowToolCalls', "{0} tool calls", sub.toolCalls));
		}
		if (sub.durationMs !== undefined) {
			parts.push(`${sub.durationMs}ms`);
		}
		statsEl.textContent = parts.join(' \u00B7 ');
		subNode.appendChild(statsEl);

		container.appendChild(subNode);

		// Return arrow
		const returnArrow = document.createElement('div');
		returnArrow.className = 'chat-debug-flow-arrow chat-debug-flow-arrow-return';
		returnArrow.textContent = '\u2193'; // ↓
		container.appendChild(returnArrow);
	}

	// End node
	const endNode = document.createElement('div');
	endNode.className = 'chat-debug-flow-node chat-debug-flow-end';
	endNode.textContent = localize('chatDebug.end', "End");
	container.appendChild(endNode);
}
