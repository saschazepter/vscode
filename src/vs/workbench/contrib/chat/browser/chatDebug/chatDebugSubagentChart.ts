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

export interface IDeriveSubagentResult {
	subagents: ISubagentData[];
	/** Set of event IDs that belong to a subagent (invocation IDs + child event IDs). */
	subagentEventIds: Set<string>;
}

/**
 * Derive subagent info from events:
 * - Explicit `subagentInvocation` events
 * - `toolCall` events where toolName is 'runSubagent'
 * - `toolCall` events that have a parentEventId matching a subagent
 */
export function deriveSubagentData(events: readonly IChatDebugEvent[]): IDeriveSubagentResult {
	const subagents: Map<string, { name: string; description?: string; status?: string; toolCalls: number; modelTurns: number; durationMs?: number; childEvents: IChatDebugEvent[] }> = new Map();

	// Build an id-lookup for correlation
	const eventsById = new Map<string, IChatDebugEvent>();
	for (const event of events) {
		if (event.id) {
			eventsById.set(event.id, event);
		}
	}

	// 1. Collect from explicit subagentInvocation events (primary source).
	//    The system may emit two events per subagent invocation (status
	//    "running" then "completed"/"failed") with different ids. We use
	//    per-invocation counter keys and pair running→completed events by
	//    FIFO order per agentName.
	const agentEventIds = new Map<string, string>(); // eventId → subagent map key
	let subagentCounter = 0;
	const runningEntries = new Map<string, string[]>(); // agentName → [mapKey, ...] FIFO
	for (const event of events) {
		if (event.kind === 'subagentInvocation' && event.agentName !== 'runSubagent') {
			if (event.status === 'completed' || event.status === 'failed') {
				// Try to merge with an existing "running" entry for this agentName
				const running = runningEntries.get(event.agentName);
				if (running && running.length > 0) {
					const matchKey = running.shift()!;
					const existing = subagents.get(matchKey)!;
					existing.status = event.status;
					existing.toolCalls = Math.max(existing.toolCalls, event.toolCallCount ?? 0);
					existing.modelTurns = Math.max(existing.modelTurns, event.modelTurnCount ?? 0);
					existing.durationMs = event.durationInMillis ?? existing.durationMs;
					existing.description = event.description ?? existing.description;
					if (event.id) {
						agentEventIds.set(event.id, matchKey);
					}
					continue;
				}
			}
			// New invocation (or standalone completed/failed with no running pair)
			const key = `subagent-${subagentCounter++}`;
			if (event.id) {
				agentEventIds.set(event.id, key);
			}
			subagents.set(key, {
				name: event.agentName,
				description: event.description,
				status: event.status,
				toolCalls: event.toolCallCount ?? 0,
				modelTurns: event.modelTurnCount ?? 0,
				durationMs: event.durationInMillis,
				childEvents: [],
			});
			if (event.status === 'running' || !event.status) {
				const running = runningEntries.get(event.agentName) ?? [];
				running.push(key);
				runningEntries.set(event.agentName, running);
			}
		}
	}

	// 1b. Map runSubagent toolCall event IDs to the corresponding subagent.
	//     SubagentInvocation events are internally implemented as tool calls,
	//     so child events may reference the runSubagent toolCall ID as their
	//     parentEventId. We must track these IDs so transitive ownership works.
	//     Match by description from the toolCall input, falling back to order.
	const unmatchedSubagentKeys = [...subagents.keys()];
	let unmatchedIdx = 0;
	for (const event of events) {
		if (event.kind === 'toolCall' && event.toolName === 'runSubagent' && event.id && !agentEventIds.has(event.id)) {
			let matchedKey: string | undefined;
			let parsedDescription: string | undefined;
			if (event.input) {
				try {
					const parsed: { agentName?: string; description?: string } = JSON.parse(event.input);
					parsedDescription = parsed.description;
					if (parsed.description) {
						for (const key of unmatchedSubagentKeys) {
							const sub = subagents.get(key);
							if (sub && sub.description === parsed.description) {
								matchedKey = key;
								break;
							}
						}
					}
					// Fallback: match by agentName if only one entry has that name
					if (!matchedKey && parsed.agentName) {
						const candidates = unmatchedSubagentKeys.filter(k => subagents.get(k)?.name === parsed.agentName);
						if (candidates.length === 1) {
							matchedKey = candidates[0];
						}
					}
				} catch {
					// best effort
				}
			}
			// Fallback: match by order
			if (!matchedKey && unmatchedIdx < unmatchedSubagentKeys.length) {
				matchedKey = unmatchedSubagentKeys[unmatchedIdx];
			}
			if (matchedKey) {
				agentEventIds.set(event.id, matchedKey);
				// Enrich subagent description from toolCall input if missing
				const sub = subagents.get(matchedKey);
				if (sub && !sub.description && parsedDescription) {
					sub.description = parsedDescription;
				}
				const idx = unmatchedSubagentKeys.indexOf(matchedKey);
				if (idx >= 0) {
					unmatchedSubagentKeys.splice(idx, 1);
				} else {
					unmatchedIdx++;
				}
			}
		}
	}

	// 2. Collect from runSubagent tool calls - only as a fallback when no
	//    subagentInvocation events were found. When both exist they represent
	//    the same logical subagent; showing both is confusing.
	if (subagents.size === 0) {
		for (const event of events) {
			if (event.kind === 'toolCall' && event.toolName === 'runSubagent') {
				const key = event.id ?? `runSubagent-${event.created.getTime()}`;
				if (!subagents.has(key)) {
					let agentName = 'Subagent';
					let description: string | undefined;
					if (event.input) {
						try {
							const parsed: { agentName?: string; description?: string; prompt?: string } = JSON.parse(event.input);
							description = parsed.description;
							agentName = parsed.agentName ?? 'Subagent';
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
	}


	// 3. Infer subagents from orphaned parentEventId references, but only
	//    when the parent event is actually subagent-related.
	//    Skip runSubagent toolCall parents when subagentInvocation entries
	//    already exist - they represent the same logical subagent.
	//    Also skip if agentEventIds already maps this parentEventId to a
	//    known subagent (i.e., the parent was a subagentInvocation we merged).
	const hasExplicitSubagents = subagents.size > 0;
	for (const event of events) {
		if (event.parentEventId && !subagents.has(event.parentEventId) && !agentEventIds.has(event.parentEventId)) {
			const parentEvent = eventsById.get(event.parentEventId);
			if (parentEvent?.kind === 'subagentInvocation') {
				subagents.set(event.parentEventId, {
					name: parentEvent.agentName,
					description: parentEvent.description,
					status: parentEvent.status,
					toolCalls: 0,
					modelTurns: 0,
					durationMs: parentEvent.durationInMillis,
					childEvents: [],
				});
			} else if (!hasExplicitSubagents && parentEvent?.kind === 'toolCall' && parentEvent.toolName === 'runSubagent') {
				let agentName = 'Subagent';
				let description: string | undefined;
				if (parentEvent.input) {
					try {
						const parsed: { agentName?: string; description?: string } = JSON.parse(parentEvent.input);
						description = parsed.description;
						agentName = parsed.agentName ?? 'Subagent';
					} catch {
						// best effort
					}
				}
				subagents.set(event.parentEventId, {
					name: agentName,
					description,
					status: undefined,
					toolCalls: 0,
					modelTurns: 0,
					durationMs: parentEvent.durationInMillis,
					childEvents: [],
				});
			}
		}
	}


	// Attach child events transitively: any event whose parentEventId
	// chain leads to a subagent is considered owned by that subagent.
	// We build a mapping from event ID → subagent key for resolved events,
	// then iterate until no new assignments are made.
	const eventOwner = new Map<string, string>(); // eventId → subagent map key

	// Seed with known subagent invocation event IDs
	for (const [eventId, agentKey] of agentEventIds) {
		eventOwner.set(eventId, agentKey);
	}
	// Also seed with subagent map keys (in case parentEventId points to the key directly)
	for (const key of subagents.keys()) {
		eventOwner.set(key, key);
	}

	// Iteratively resolve ownership: if an event's parentEventId is owned
	// by a subagent, the event itself is owned by the same subagent.
	let changed = true;
	while (changed) {
		changed = false;
		for (const event of events) {
			if (event.id && !eventOwner.has(event.id) && event.parentEventId && eventOwner.has(event.parentEventId)) {
				eventOwner.set(event.id, eventOwner.get(event.parentEventId)!);
				changed = true;
			}
		}
	}

	// Now attach all owned events as children, and enrich descriptions
	// from runSubagent toolCall inputs where available.
	for (const event of events) {
		const ownerKey = event.id ? eventOwner.get(event.id) : undefined;
		const parentOwnerKey = event.parentEventId ? eventOwner.get(event.parentEventId) : undefined;
		const resolvedKey = ownerKey ?? parentOwnerKey;
		if (resolvedKey && subagents.has(resolvedKey)) {
			const sub = subagents.get(resolvedKey)!;
			// Enrich description from runSubagent toolCall input
			if (event.kind === 'toolCall' && event.toolName === 'runSubagent' && !sub.description && event.input) {
				try {
					const parsed: { description?: string } = JSON.parse(event.input);
					if (parsed.description) {
						sub.description = parsed.description;
					}
				} catch {
					// best effort
				}
			}
			// Avoid adding the subagent invocation event itself
			if (event.kind !== 'subagentInvocation') {
				(sub.childEvents as IChatDebugEvent[]).push(event);
				if (event.kind === 'toolCall') {
					sub.toolCalls++;
				} else if (event.kind === 'modelTurn') {
					sub.modelTurns++;
				}
			}
		}
	}

	const result = [...subagents.values()];

	// Build a set of all event IDs owned by subagents so callers can
	// distinguish main-agent events from subagent-child events.
	const subagentEventIds = new Set<string>(eventOwner.keys());

	return { subagents: result, subagentEventIds };
}

/**
 * Generate a Mermaid flowchart from events, showing the agent flow
 * with tool call breakdown and subagent invocations as subgraphs.
 */
export function generateSubagentFlowchart(events: readonly IChatDebugEvent[]): string {
	const { subagents, subagentEventIds } = deriveSubagentData(events);
	const isSubagentOwned = (e: IChatDebugEvent) =>
		(e.id !== undefined && subagentEventIds.has(e.id)) ||
		(e.parentEventId !== undefined && subagentEventIds.has(e.parentEventId));
	const modelTurns = events.filter(e => e.kind === 'modelTurn' && !isSubagentOwned(e));
	const mainToolCalls = events.filter(e => e.kind === 'toolCall' && e.toolName !== 'runSubagent' && !isSubagentOwned(e));

	// Summarize top tool calls for the main agent
	const mainToolNames = new Map<string, number>();
	for (const tc of mainToolCalls) {
		if (tc.kind === 'toolCall') {
			mainToolNames.set(tc.toolName, (mainToolNames.get(tc.toolName) ?? 0) + 1);
		}
	}

	const lines: string[] = [];
	lines.push('flowchart TD');

	// Start node
	lines.push('    start([Start]) --> mainAgent');
	lines.push(`    mainAgent["Main Agent<br/>${modelTurns.length} model turns<br/>${mainToolCalls.length} tool calls"]`);

	// Main agent tool breakdown
	if (mainToolNames.size > 0) {
		const toolSummary = [...mainToolNames.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8)
			.map(([name, count]) => `${name} x${count}`)
			.join('<br/>');
		lines.push(`    mainAgent --> mainTools["Tools:<br/>${toolSummary}"]`);
	}

	if (subagents.length === 0) {
		if (mainToolNames.size > 0) {
			lines.push('    mainTools --> finish([End])');
		} else {
			lines.push('    mainAgent --> finish([End])');
		}
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
	if (mainToolNames.size > 0) {
		lines.push('    class mainTools toolNode');
	}

	for (let i = 0; i < subagents.length; i++) {
		lines.push(`    class sub${i} subNode`);
		lines.push(`    class sub${i}_tools toolNode`);
		lines.push(`    class mainAgent_return${i} returnNode`);
	}

	return lines.join('\n');
}

/**
 * Render a visual HTML/CSS flow representation of the agent execution,
 * showing main agent activity and subagent invocations when present.
 */
export function renderVisualFlow(container: HTMLElement, events: readonly IChatDebugEvent[]): void {

	const { subagents, subagentEventIds } = deriveSubagentData(events);
	const isSubagentOwned = (e: IChatDebugEvent) =>
		(e.id !== undefined && subagentEventIds.has(e.id)) ||
		(e.parentEventId !== undefined && subagentEventIds.has(e.parentEventId));
	const modelTurns = events.filter(e => e.kind === 'modelTurn' && !isSubagentOwned(e));
	const mainToolCalls = events.filter(e => e.kind === 'toolCall' && e.toolName !== 'runSubagent' && !isSubagentOwned(e));
	// Main agent node with stats
	const mainNode = document.createElement('div');
	mainNode.className = 'chat-debug-flow-node chat-debug-flow-main';

	const mainTitle = document.createElement('div');
	mainTitle.className = 'chat-debug-flow-subagent-name';
	mainTitle.textContent = localize('chatDebug.mainAgent', "Main Agent");
	mainNode.appendChild(mainTitle);

	const mainStats = document.createElement('div');
	mainStats.className = 'chat-debug-flow-subagent-stats';
	const mainParts: string[] = [];
	if (modelTurns.length > 0) {
		mainParts.push(localize('chatDebug.flowModelTurns', "{0} model turns", modelTurns.length));
	}
	if (mainToolCalls.length > 0) {
		mainParts.push(localize('chatDebug.flowToolCalls', "{0} tool calls", mainToolCalls.length));
	}
	mainStats.textContent = mainParts.join(' \u00B7 ');
	mainNode.appendChild(mainStats);

	// Tool call chips for main agent
	appendToolChips(mainNode, mainToolCalls);

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
		if (sub.description) {
			subNode.title = sub.description;
		}

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

		// Tool call chips for subagent
		const subToolCalls = sub.childEvents.filter(e => e.kind === 'toolCall');
		appendToolChips(subNode, subToolCalls);

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

/**
 * Append tool call chips to a flow node, grouped by tool name with counts.
 */
function appendToolChips(parent: HTMLElement, toolCalls: readonly IChatDebugEvent[]): void {
	if (toolCalls.length === 0) {
		return;
	}

	const toolNames = new Map<string, number>();
	for (const tc of toolCalls) {
		if (tc.kind === 'toolCall') {
			toolNames.set(tc.toolName, (toolNames.get(tc.toolName) ?? 0) + 1);
		}
	}

	const chipsContainer = document.createElement('div');
	chipsContainer.className = 'chat-debug-flow-tool-chips';

	const sorted = [...toolNames.entries()].sort((a, b) => b[1] - a[1]);
	const maxVisible = 6;
	const visible = sorted.slice(0, maxVisible);

	for (const [name, count] of visible) {
		const chip = document.createElement('span');
		chip.className = 'chat-debug-flow-tool-chip';
		chip.textContent = count > 1 ? `${name} \u00D7${count}` : name;
		chip.title = `${name}: ${count} call${count > 1 ? 's' : ''}`;
		chipsContainer.appendChild(chip);
	}

	if (sorted.length > maxVisible) {
		const moreChip = document.createElement('span');
		moreChip.className = 'chat-debug-flow-tool-chip chat-debug-flow-tool-chip-more';
		const remaining = sorted.length - maxVisible;
		moreChip.textContent = localize('chatDebug.moreTools', "+{0} more", remaining);
		moreChip.title = sorted.slice(maxVisible).map(([n, c]) => `${n} \u00D7${c}`).join(', ');
		chipsContainer.appendChild(moreChip);
	}

	parent.appendChild(chipsContainer);
}
