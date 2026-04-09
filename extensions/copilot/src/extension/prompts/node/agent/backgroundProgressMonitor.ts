/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { toTextParts } from '../../../../platform/chat/common/globalStringUtils';
import { ChatFetchResponseType, ChatLocation } from '../../../../platform/chat/common/commonTypes';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { FinishedCallback, ICopilotToolCall, OpenAiFunctionTool } from '../../../../platform/networking/common/fetch';
import { ILogService } from '../../../../platform/log/common/logService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';

// ── Types ────────────────────────────────────────────────────────────────

export interface IParsedPlan {
	readonly steps: readonly IParsedPlanStep[];
}

export interface IParsedPlanStep {
	readonly id: number;
	readonly title: string;
}

export interface ITodoUpdate {
	readonly id: number;
	readonly title: string;
	readonly status: 'not-started' | 'in-progress' | 'completed';
}

/**
 * Callback to persist updated todo items. The caller is responsible for
 * bridging this to the workbench's `IChatTodoListService`.
 */
export type SetTodosFn = (todos: ITodoUpdate[]) => void;

// ── State ────────────────────────────────────────────────────────────────

const enum MonitorState {
	/** No plan detected yet. */
	Idle = 'Idle',
	/** Actively tracking progress. */
	Monitoring = 'Monitoring',
	/** Session ended or explicitly stopped. */
	Stopped = 'Stopped',
}

// ── Constants ────────────────────────────────────────────────────────────

/** How many new rounds to accumulate before triggering a background check. */
const ROUNDS_CHECK_THRESHOLD = 10;

/** Maximum tokens for the background progress-check response. */
const PROGRESS_CHECK_MAX_TOKENS = 2000;

/** Tool name as registered by the workbench. */
const MANAGE_TODO_LIST_TOOL_NAME = 'manage_todo_list';

// ── Plan Parser ──────────────────────────────────────────────────────────

/**
 * Parses a plan from a `manage_todo_list` tool call's `todoList` argument.
 *
 * Returns `undefined` if fewer than 2 items are found.
 */
export function parsePlanFromToolCall(todoList: readonly { id: number; title: string; status: string }[]): IParsedPlan | undefined {
	if (!todoList || todoList.length < 2) {
		return undefined;
	}

	const steps: IParsedPlanStep[] = todoList.map(item => ({
		id: item.id,
		title: item.title,
	}));

	return { steps };
}

// ── Background Progress Monitor ──────────────────────────────────────────

/**
 * Infers todo-step completion from tool-call rounds using a cheap background
 * LLM call, then writes the result to the todo list via a callback.
 *
 * Lifecycle:
 *   Idle → Monitoring  (plan detected in first response)
 *     Accumulating ↔ CheckingProgress
 *   Monitoring → Stopped  (session disposed / task complete)
 *
 * Background LLM calls are fire-and-forget — they never block the main agent
 * loop. The progress check appends a small user message to the same
 * conversation prefix used by the main agent, so Anthropic prompt caching
 * reuses the cached prefix tokens.
 */
export class BackgroundProgressMonitor {

	private _state: MonitorState = MonitorState.Idle;
	private _plan: IParsedPlan | undefined;
	private _roundsSinceLastCheck = 0;
	private _lastFedRoundIndex = -1;
	private _cts: CancellationTokenSource | undefined;
	private _checkInFlight = false;
	/** Status string per step id from the last _setTodos call, used to skip no-op updates. */
	private _lastEmittedStatuses = new Map<number, ITodoUpdate['status']>();

	/**
	 * Snapshot of the last rendered conversation messages from `buildPrompt`.
	 * Used as the prefix for the background progress-check call so that
	 * Anthropic prompt caching can reuse the same cached prefix.
	 */
	private _lastRenderedMessages: Raw.ChatMessage[] | undefined;

	/**
	 * The endpoint used by the main agent session. Re-used here so that the
	 * background progress check hits the same model and benefits from
	 * Anthropic prompt prefix caching.
	 */
	private _endpoint: IChatEndpoint | undefined;

	constructor(
		private readonly _logService: ILogService,
		private readonly _telemetryService: ITelemetryService,
		private readonly _setTodos: SetTodosFn,
	) { }

	get isMonitoring(): boolean { return this._state === MonitorState.Monitoring; }

	// ── Public API ───────────────────────────────────────────────────────

	/**
	 * Updates the endpoint and the last-rendered conversation messages.
	 * Called from `buildPrompt` on every iteration so the background check
	 * always uses the freshest conversation state and the same endpoint as
	 * the main agent (enabling Anthropic prompt prefix caching).
	 */
	updateSessionContext(endpoint: IChatEndpoint, renderedMessages: Raw.ChatMessage[]): void {
		this._endpoint = endpoint;
		this._lastRenderedMessages = renderedMessages;
		this._logService.info(`[BackgroundProgressMonitor] Session context updated: endpoint=${endpoint.model}, messageCount=${renderedMessages.length}`);
	}

	/**
	 * Starts monitoring with the detected plan.
	 * Seeds the todo list with the first step in-progress.
	 */
	start(plan: IParsedPlan, parentToken?: CancellationToken): void {
		if (this._state !== MonitorState.Idle) {
			return;
		}

		this._plan = plan;
		this._state = MonitorState.Monitoring;
		this._cts = new CancellationTokenSource(parentToken);
		this._roundsSinceLastCheck = 0;
		this._lastFedRoundIndex = -1;

		// Seed initial todos — first step in-progress since the agent is
		// already working by the time we parse the plan from round 0.
		const initialTodos: ITodoUpdate[] = plan.steps.map((step, i) => ({
			id: step.id,
			title: step.title,
			status: i === 0 ? 'in-progress' as const : 'not-started' as const,
		}));
		this._emitIfChanged(initialTodos);
		this._logService.info(`[BackgroundProgressMonitor] Started with ${plan.steps.length} steps`);
	}

	/**
	 * Feeds completed tool-call rounds to the monitor.
	 * Called from `buildPrompt` on each iteration. Only new rounds (since the
	 * last call) are counted. When the accumulation threshold is hit a
	 * background check is fired asynchronously.
	 */
	feedRounds(roundCount: number): void {
		if (this._state !== MonitorState.Monitoring || !this._plan) {
			this._logService.info(`[BackgroundProgressMonitor] feedRounds(${roundCount}) — skipped (state=${this._state}, plan=${!!this._plan})`);
			return;
		}

		const newRounds = roundCount - (this._lastFedRoundIndex + 1);
		if (newRounds > 0) {
			this._roundsSinceLastCheck += newRounds;
			this._lastFedRoundIndex = roundCount - 1;
		}

		this._logService.info(`[BackgroundProgressMonitor] feedRounds(${roundCount}): newRounds=${newRounds}, roundsSinceLastCheck=${this._roundsSinceLastCheck}, checkInFlight=${this._checkInFlight}, hasEndpoint=${!!this._endpoint}, hasMessages=${!!this._lastRenderedMessages?.length}`);

		if (this._roundsSinceLastCheck >= ROUNDS_CHECK_THRESHOLD && !this._checkInFlight) {
			this._triggerCheck();
		}
	}

	/**
	 * Stops the monitor and cleans up resources.
	 */
	stop(): void {
		this._state = MonitorState.Stopped;
		this._cts?.cancel();
		this._cts?.dispose();
		this._cts = undefined;
		this._plan = undefined;
		this._lastEmittedStatuses.clear();
	}

	// ── Background check ─────────────────────────────────────────────────

	/**
	 * Calls `_setTodos` only when at least one step's status differs from
	 * the last emission. Returns `true` if the update was emitted.
	 */
	private _emitIfChanged(todos: ITodoUpdate[]): boolean {
		let changed = todos.length !== this._lastEmittedStatuses.size;
		if (!changed) {
			for (const todo of todos) {
				if (this._lastEmittedStatuses.get(todo.id) !== todo.status) {
					changed = true;
					break;
				}
			}
		}
		if (!changed) {
			return false;
		}
		this._lastEmittedStatuses.clear();
		for (const todo of todos) {
			this._lastEmittedStatuses.set(todo.id, todo.status);
		}
		this._setTodos(todos);
		return true;
	}

	/**
	 * Fire-and-forget: launches an async LLM call and updates the todo list
	 * when it completes. Never blocks the caller.
	 */
	private _triggerCheck(): void {
		if (!this._plan || !this._cts || this._cts.token.isCancellationRequested) {
			this._logService.info('[BackgroundProgressMonitor] _triggerCheck — skipped (no plan, no cts, or cancelled)');
			return;
		}

		// Guard: skip check if session context hasn't been provided yet.
		// _roundsSinceLastCheck is left unmodified so the next feedRounds
		// call will retry.
		if (!this._endpoint || !this._lastRenderedMessages?.length) {
			this._logService.info(`[BackgroundProgressMonitor] _triggerCheck — deferred (hasEndpoint=${!!this._endpoint}, messageCount=${this._lastRenderedMessages?.length ?? 0})`);
			return;
		}

		this._logService.info(`[BackgroundProgressMonitor] _triggerCheck — firing background check (roundsSinceLastCheck=${this._roundsSinceLastCheck}, prefixMessages=${this._lastRenderedMessages.length})`);
		this._checkInFlight = true;
		const roundsInThisCheck = this._roundsSinceLastCheck;
		this._roundsSinceLastCheck = 0;

		const plan = this._plan;
		const token = this._cts.token;
		const startTime = Date.now();

		this._doCheckProgress(plan, token).then(
			updatedTodos => {
				this._checkInFlight = false;
				const durationMs = Date.now() - startTime;
				this._logService.info(`[BackgroundProgressMonitor] Check completed in ${durationMs}ms — result=${updatedTodos ? updatedTodos.map(t => `${t.id}:${t.status}`).join(', ') : 'undefined'}`);
				if (updatedTodos && this._state === MonitorState.Monitoring) {
					const emitted = this._emitIfChanged(updatedTodos);
					if (emitted) {
						this._logService.info(
							`[BackgroundProgressMonitor] Updated todos: ${updatedTodos.map(t => `${t.id}:${t.status}`).join(', ')}`,
						);
					}
					this._sendTelemetry('success', durationMs, roundsInThisCheck, updatedTodos);
				} else {
					this._sendTelemetry('skipped', durationMs, roundsInThisCheck, undefined);
				}
			},
			err => {
				this._checkInFlight = false;
				const durationMs = Date.now() - startTime;
				this._logService.error(err, '[BackgroundProgressMonitor] Background progress check failed');
				this._sendTelemetry('llmError', durationMs, roundsInThisCheck, undefined);
			},
		);
	}

	private _sendTelemetry(
		outcome: 'success' | 'parseFailure' | 'llmError' | 'skipped',
		durationMs: number,
		roundsSinceLastCheck: number,
		todos: ITodoUpdate[] | undefined,
	): void {
		const stepCount = this._plan?.steps.length ?? 0;
		const completedCount = todos?.filter(t => t.status === 'completed').length ?? 0;
		/* __GDPR__
			"backgroundProgressMonitorCheck" : {
				"owner": "vritant24",
				"comment": "Tracks background progress monitor check outcomes.",
				"outcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The result of the background check." },
				"durationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Duration of the background LLM call in ms." },
				"stepCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total steps in the plan." },
				"completedCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Steps marked completed after this check." },
				"roundsSinceLastCheck": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Tool call rounds accumulated before this check." }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('backgroundProgressMonitorCheck', {
			outcome,
		}, {
			durationMs,
			stepCount,
			completedCount,
			roundsSinceLastCheck,
		});
	}

	private async _doCheckProgress(
		plan: IParsedPlan,
		token: CancellationToken,
	): Promise<ITodoUpdate[] | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const endpoint = this._endpoint;
		const prefixMessages = this._lastRenderedMessages;
		if (!endpoint || !prefixMessages?.length) {
			this._logService.warn('[BackgroundProgressMonitor] No endpoint or messages available, skipping check');
			return undefined;
		}

		try {
			const planText = plan.steps.map(s => {
				const currentStatus = this._lastEmittedStatuses.get(s.id) ?? 'not-started';
				return `${s.id}. [${currentStatus}] ${s.title}`;
			}).join('\n');

			// Build the progress-check messages by appending to the existing
			// conversation prefix. The prefix already contains the full
			// conversation history (system prompt + tool calls + results),
			// so the model can infer progress from what it sees. With
			// Anthropic, prompt caching reuses the cached prefix tokens.
			const progressCheckMessage: Raw.ChatMessage = {
				role: Raw.ChatRole.User,
				content: toTextParts(
					'[INTERNAL — progress tracking, not visible to the user]\n\n' +
					'You are a progress tracker. Your ONLY job is to call the manage_todo_list tool. ' +
					'Do NOT call any other tools. Do NOT read files. Do NOT search. Do NOT write text.\n\n' +
					'The conversation above shows work done by a coding agent. ' +
					'Review what has been accomplished and call manage_todo_list with updated statuses.\n\n' +
					'Rules:\n' +
					'- "completed": ALL work for the step is clearly finished.\n' +
					'- "in-progress": work has started but is not finished.\n' +
					'- "not-started": no evidence of work yet.\n' +
					'- Do NOT mark all steps completed. At least one must be "in-progress" or "not-started".\n' +
					'- Be conservative — when in doubt, keep the current status.\n\n' +
					`Current plan:\n${planText}\n\n` +
					'Now call manage_todo_list with the updated todoList. Nothing else.',
				),
			};

			const messages = [...prefixMessages, progressCheckMessage];

			// Build the manage_todo_list tool definition inline to avoid
			// cross-layer imports from the workbench.
			const todoTool: OpenAiFunctionTool = {
				type: 'function',
				function: {
					name: MANAGE_TODO_LIST_TOOL_NAME,
					description: 'Update the todo list with current progress statuses.',
					parameters: {
						type: 'object',
						properties: {
							todoList: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										id: { type: 'number' },
										title: { type: 'string' },
										status: { type: 'string', enum: ['not-started', 'in-progress', 'completed'] },
									},
									required: ['id', 'title', 'status'],
								},
							},
						},
						required: ['todoList'],
					},
				},
			};

			// Capture tool calls from the streaming response via finishedCb.
			const collectedToolCalls: ICopilotToolCall[] = [];
			const finishedCb: FinishedCallback = async (_text, _index, delta) => {
				if (delta.copilotToolCalls) {
					collectedToolCalls.push(...delta.copilotToolCalls);
				}
				return undefined;
			};

			this._logService.info(`[BackgroundProgressMonitor] Sending progress check: prefixMessages=${prefixMessages.length}, endpoint=${endpoint.model}`);

			const fetchResult = await endpoint.makeChatRequest(
				'backgroundProgressMonitor',
				messages,
				finishedCb,
				token,
				ChatLocation.Other,
				undefined,
				{
					max_tokens: PROGRESS_CHECK_MAX_TOKENS,
					tools: [todoTool],
					tool_choice: { type: 'function', function: { name: MANAGE_TODO_LIST_TOOL_NAME } },
				},
			);

			if (fetchResult.type !== ChatFetchResponseType.Success) {
				this._logService.warn(
					`[BackgroundProgressMonitor] LLM call returned non-success: ${fetchResult.type}`,
				);
				return undefined;
			}

			// Extract the todoList from the tool call arguments.
			const toolCall = collectedToolCalls.find(tc => tc.name === MANAGE_TODO_LIST_TOOL_NAME);
			if (!toolCall) {
				this._logService.warn('[BackgroundProgressMonitor] No manage_todo_list tool call in response');
				// Fall back to parsing the text response as JSON for robustness.
				return this._parseProgressResponse(fetchResult.value, plan);
			}

			this._logService.info(`[BackgroundProgressMonitor] Tool call captured: ${toolCall.arguments.slice(0, 300)}`);
			return this._parseToolCallResult(toolCall.arguments, plan);
		} catch (err) {
			if (!token.isCancellationRequested) {
				this._logService.error(err, '[BackgroundProgressMonitor] Error during progress check');
			}
			return undefined;
		}
	}

	/**
	 * Parses the `todoList` argument from a `manage_todo_list` tool call
	 * and applies monotonic forward progression.
	 */
	private _parseToolCallResult(
		toolCallArgs: string,
		plan: IParsedPlan,
	): ITodoUpdate[] | undefined {
		try {
			const parsed = JSON.parse(toolCallArgs);
			const todoList = parsed.todoList;
			if (!Array.isArray(todoList)) {
				return undefined;
			}
			return this._applyMonotonicProgression(todoList, plan);
		} catch {
			this._logService.warn(
				`[BackgroundProgressMonitor] Failed to parse tool call args: ${toolCallArgs.slice(0, 200)}`,
			);
			return undefined;
		}
	}

	/**
	 * Fallback: parses a JSON text response into todo updates.
	 * Used when the model responds with text instead of a tool call.
	 */
	private _parseProgressResponse(
		responseText: string,
		plan: IParsedPlan,
	): ITodoUpdate[] | undefined {
		const trimmed = responseText.trim();
		if (!trimmed) {
			return undefined;
		}

		try {
			let jsonText = trimmed;
			const fenceMatch = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(jsonText);
			if (fenceMatch) {
				this._logService.info('[BackgroundProgressMonitor] Stripped markdown fences from response');
				jsonText = fenceMatch[1].trim();
			}

			const parsed = JSON.parse(jsonText);
			if (!Array.isArray(parsed)) {
				return undefined;
			}

			return this._applyMonotonicProgression(parsed, plan);
		} catch {
			this._logService.warn(
				`[BackgroundProgressMonitor] Failed to parse LLM response: ${trimmed.slice(0, 200)}`,
			);
			return undefined;
		}
	}

	/**
	 * Applies monotonic forward progression to raw status data from the LLM.
	 * Ensures a background check can NEVER mark all steps completed —
	 * only `complete()` can do that.
	 */
	private _applyMonotonicProgression(
		items: { id: number; status?: string }[],
		plan: IParsedPlan,
	): ITodoUpdate[] | undefined {
		const validStatuses = new Set(['not-started', 'in-progress', 'completed']);
		const statusByIndex = new Map<number, ITodoUpdate['status']>();
		for (const item of items) {
			const planIdx = plan.steps.findIndex(s => s.id === item.id);
			if (planIdx >= 0) {
				const raw = validStatuses.has(item.status ?? '') ? item.status! as ITodoUpdate['status'] : 'not-started';
				statusByIndex.set(planIdx, raw);
			}
		}

		let frontierIndex = 0;
		for (let i = plan.steps.length - 1; i >= 0; i--) {
			const s = statusByIndex.get(i);
			if (s === 'in-progress' || s === 'completed') {
				frontierIndex = i;
				break;
			}
		}

		const frontierStatus = statusByIndex.get(frontierIndex);
		if (frontierStatus === 'completed' && frontierIndex < plan.steps.length - 1) {
			frontierIndex++;
		}

		const result = plan.steps.map((step, i) => ({
			id: step.id,
			title: step.title,
			status:
				i < frontierIndex ? 'completed' as const :
					i === frontierIndex ? 'in-progress' as const :
						'not-started' as const,
		}));
		this._logService.info(`[BackgroundProgressMonitor] Monotonic progression — LLM raw: ${[...statusByIndex.entries()].map(([i, s]) => `${i}:${s}`).join(', ')}, frontier=${frontierIndex}, final: ${result.map(t => `${t.id}:${t.status}`).join(', ')}`);
		return result;
	}
}
