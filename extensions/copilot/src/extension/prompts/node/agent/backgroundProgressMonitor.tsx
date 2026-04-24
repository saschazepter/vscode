/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, Raw, UserMessage } from '@vscode/prompt-tsx';
import ChatCompletionContentPartKind = Raw.ChatCompletionContentPartKind;
import ChatRole = Raw.ChatRole;
import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { ChatFetchResponseType, ChatLocation } from '../../../../platform/chat/common/commonTypes';
import { OpenAiFunctionTool } from '../../../../platform/networking/common/fetch';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { ILogService } from '../../../../platform/log/common/logService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ToolName } from '../../../tools/common/toolNames';
import { IToolsService } from '../../../tools/common/toolsService';
import { renderPromptElement } from '../base/promptRenderer';

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
const ROUNDS_CHECK_THRESHOLD = 5;

/** Maximum tokens for the background progress-check response. */
const PROGRESS_CHECK_MAX_TOKENS = 256;

/** Max chars to keep per tool-result text block in condensed messages. */
const TOOL_RESULT_TRUNCATE_CHARS = 200;

/** Max chars to keep per large text block in condensed messages. */
const TEXT_BLOCK_TRUNCATE_CHARS = 500;

/**
 * Builds an OpenAI function tool definition for the manage_todo_list tool
 * by looking it up from the registered tools at runtime, reusing the
 * existing schema and description from VS Code core.
 *
 * Follows the same two-step pattern as the main tool-calling loop:
 * LanguageModelToolInformation → OpenAiFunctionDef shape → OpenAiFunctionTool.
 */
function buildTodoToolDef(toolsService: IToolsService): OpenAiFunctionTool | undefined {
	const tool = toolsService.getTool(ToolName.CoreManageTodoList);
	if (!tool) {
		return undefined;
	}

	// Step 1: extract the intermediate OpenAiFunctionDef-shaped fields
	const name = tool.name;
	const description = tool.description;
	const parameters = tool.inputSchema;

	// Step 2: wrap into the OpenAiFunctionTool structure (matches
	// the promptContextTools mapping in ToolCallingLoop.runOne)
	return {
		type: 'function',
		function: {
			name,
			description,
			parameters: parameters && Object.keys(parameters).length ? parameters : undefined,
		},
	};
}

// ── Prompt-tsx component ─────────────────────────────────────────────────

interface BackgroundProgressCheckPromptProps extends BasePromptElementProps {
	planText: string;
}

/**
 * Prompt-tsx component that renders the user message for the background
 * progress check. Instructs the model to call the `manage_todo_list` tool
 * with updated step statuses.
 */
class BackgroundProgressCheckPrompt extends PromptElement<BackgroundProgressCheckPromptProps> {
	render() {
		return (
			<UserMessage>
				[INTERNAL — progress tracking, not visible to the user]{'\n\n'}
				You are tracking the progress of a multi-step coding task.{' '}
				The conversation above shows ONLY the recent work done since the last progress check — not the full conversation.{' '}
				The current status of each step (shown in brackets below) already reflects all prior progress.{' '}
				Your job is to determine if any steps have advanced based on the recent work shown above.{'\n\n'}
				Rules:{'\n'}
				- You MUST return EXACTLY the same steps listed below — same IDs, same titles, same count. Do NOT add, remove, or rename steps.{'\n'}
				- Only update the "status" field for each step.{'\n'}
				- A step is "completed" ONLY if ALL the work for that step is clearly finished based on the current status AND the recent conversation above.{'\n'}
				- A step is "in-progress" if the agent has started working on it but hasn't finished.{'\n'}
				- A step is "not-started" if there is no evidence of work on it yet.{'\n'}
				- The task is still in progress — do NOT mark all steps as completed. At least one step must be "in-progress" or "not-started".{'\n'}
				- Steps should progress in order: earlier steps should be completed before later steps are in-progress.{'\n'}
				- Be conservative — when in doubt, keep the current status.{'\n\n'}
				Plan (current status in brackets):{'\n'}
				{this.props.planText}{'\n\n'}
				Call the manage_todo_list tool with the updated todoList array containing all {this.props.planText.split('\n').length} steps.
			</UserMessage>
		);
	}
}

// ── Plan Parser ──────────────────────────────────────────────────────────

/**
 * Parses a numbered plan from the model's first response text.
 *
 * Looks for patterns like:
 *   1. Step description
 *   2. Step description
 *
 * Returns `undefined` if fewer than 2 numbered items are found.
 */
export function parsePlanFromResponse(responseText: string): IParsedPlan | undefined {
	const lines = responseText.split('\n');
	const steps: IParsedPlanStep[] = [];
	const numberedLineRegex = /^\s*(?<num>\d+)\.\s+(?<text>.+)/;

	for (const line of lines) {
		const match = numberedLineRegex.exec(line);
		if (match?.groups) {
			steps.push({
				id: steps.length + 1,
				title: match.groups['text'].replace(/\*\*/g, '').trim(),
			});
		}
	}

	if (steps.length < 2) {
		return undefined;
	}

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
 * loop. To reduce token usage, only messages added since the last check
 * (the delta) are sent — not the full conversation history. The plan text
 * in the prompt carries current step statuses so the model has enough
 * context to assess progress from just the recent work.
 */
export class BackgroundProgressMonitor {

	private _state: MonitorState = MonitorState.Idle;
	private _plan: IParsedPlan | undefined;
	private _roundsSinceLastCheck = 0;
	private _lastFedRoundIndex = -1;
	private _cts: CancellationTokenSource | undefined;
	private _checkInFlight = false;
	/** When true, `complete()` was called while a check was in-flight and will be retried. */
	private _completePending = false;
	/** Status string per step id from the last _setTodos call, used to skip no-op updates. */
	private _lastEmittedStatuses = new Map<number, ITodoUpdate['status']>();
	/** Number of prefix messages included in the last background check, used to compute the delta. */
	private _lastCheckMessageCount = 0;

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
		private readonly _instantiationService: IInstantiationService,
		private readonly _toolsService: IToolsService,
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
		this._logService.debug(`[BackgroundProgressMonitor] Session context updated: endpoint=${endpoint.model}, messageCount=${renderedMessages.length}`);
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
		this._completePending = false;
		this._lastCheckMessageCount = 0;

		// Seed initial todos — first step in-progress since the agent is
		// already working by the time we parse the plan from round 0.
		const initialTodos: ITodoUpdate[] = plan.steps.map((step, i) => ({
			id: step.id,
			title: step.title,
			status: i === 0 ? 'in-progress' as const : 'not-started' as const,
		}));
		this._emitIfChanged(initialTodos);
		this._logService.debug(`[BackgroundProgressMonitor] Started with ${plan.steps.length} steps`);
	}

	/**
	 * Feeds completed tool-call rounds to the monitor.
	 * Called from `buildPrompt` on each iteration. Only new rounds (since the
	 * last call) are counted. When the accumulation threshold is hit a
	 * background check is fired asynchronously.
	 */
	feedRounds(roundCount: number): void {
		if (this._state !== MonitorState.Monitoring || !this._plan) {
			this._logService.debug(`[BackgroundProgressMonitor] feedRounds(${roundCount}) — skipped (state=${this._state}, plan=${!!this._plan})`);
			return;
		}

		const newRounds = roundCount - (this._lastFedRoundIndex + 1);
		if (newRounds > 0) {
			this._roundsSinceLastCheck += newRounds;
			this._lastFedRoundIndex = roundCount - 1;
		}

		this._logService.debug(`[BackgroundProgressMonitor] feedRounds(${roundCount}): newRounds=${newRounds}, roundsSinceLastCheck=${this._roundsSinceLastCheck}, checkInFlight=${this._checkInFlight}, hasEndpoint=${!!this._endpoint}, hasMessages=${!!this._lastRenderedMessages?.length}`);

		if (this._roundsSinceLastCheck >= ROUNDS_CHECK_THRESHOLD && !this._checkInFlight) {
			this._triggerCheck();
		}
	}

	/**
	 * Marks all plan steps as completed and writes the final state to the
	 * todo list. Call this when the tool-calling loop finishes (the agent
	 * response is done) so the UI reflects 100% completion.
	 *
	 * If a background check is in-flight, defers completion until it settles.
	 */
	complete(): void {
		this._logService.debug(`[BackgroundProgressMonitor] complete() called — state=${this._state}, checkInFlight=${this._checkInFlight}, currentStatuses=${[...this._lastEmittedStatuses.entries()].map(([id, s]) => `${id}:${s}`).join(', ')}`);

		if (this._state !== MonitorState.Monitoring || !this._plan) {
			this._logService.debug('[BackgroundProgressMonitor] complete() — skipped (not monitoring or no plan)');
			return;
		}

		if (this._checkInFlight) {
			this._logService.debug('[BackgroundProgressMonitor] complete() — deferred (check in-flight)');
			this._completePending = true;
			return;
		}

		// The loop finishing is the definitive signal that the agent
		// considers the task done. Mark all steps as completed regardless
		// of their current status — background checks may not have caught
		// up to the agent's actual progress.
		const finalTodos: ITodoUpdate[] = this._plan.steps.map(step => ({
			id: step.id,
			title: step.title,
			status: 'completed' as const,
		}));
		this._emitIfChanged(finalTodos);
		this._logService.debug(`[BackgroundProgressMonitor] Finalized steps: ${finalTodos.map(t => `${t.id}:${t.status}`).join(', ')}`);
		this.stop();
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
		this._completePending = false;
		this._lastEmittedStatuses.clear();
		this._lastCheckMessageCount = 0;
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
			this._logService.debug('[BackgroundProgressMonitor] _triggerCheck — skipped (no plan, no cts, or cancelled)');
			return;
		}

		// Guard: skip check if session context hasn't been provided yet.
		// _roundsSinceLastCheck is left unmodified so the next feedRounds
		// call will retry.
		if (!this._endpoint || !this._lastRenderedMessages?.length) {
			this._logService.debug(`[BackgroundProgressMonitor] _triggerCheck — deferred (hasEndpoint=${!!this._endpoint}, messageCount=${this._lastRenderedMessages?.length ?? 0})`);
			return;
		}

		this._logService.debug(`[BackgroundProgressMonitor] _triggerCheck — firing background check (roundsSinceLastCheck=${this._roundsSinceLastCheck}, prefixMessages=${this._lastRenderedMessages.length})`);
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
				this._logService.debug(`[BackgroundProgressMonitor] Check completed in ${durationMs}ms — result=${updatedTodos ? updatedTodos.map(t => `${t.id}:${t.status}`).join(', ') : 'undefined'}`);
				if (updatedTodos && this._state === MonitorState.Monitoring) {
					const emitted = this._emitIfChanged(updatedTodos);
					if (emitted) {
						this._logService.debug(
							`[BackgroundProgressMonitor] Updated todos: ${updatedTodos.map(t => `${t.id}:${t.status}`).join(', ')}`,
						);
					}
					this._sendTelemetry('success', durationMs, roundsInThisCheck, updatedTodos);
				} else {
					this._sendTelemetry('skipped', durationMs, roundsInThisCheck, undefined);
				}
				// If complete() was called while we were in-flight, run it now.
				if (this._completePending) {
					this._completePending = false;
					this.complete();
				}
			},
			err => {
				this._checkInFlight = false;
				const durationMs = Date.now() - startTime;
				this._logService.error(err, '[BackgroundProgressMonitor] Background progress check failed');
				this._sendTelemetry('llmError', durationMs, roundsInThisCheck, undefined);
				// If complete() was called while we were in-flight, run it now.
				if (this._completePending) {
					this._completePending = false;
					this.complete();
				}
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
			// Build the tool definition from the registered tool at runtime.
			const toolDef = buildTodoToolDef(this._toolsService);
			if (!toolDef) {
				this._logService.warn('[BackgroundProgressMonitor] manage_todo_list tool not found in registered tools');
				return undefined;
			}
			const toolName = toolDef.function.name;

			const planText = plan.steps.map(s => {
				const currentStatus = this._lastEmittedStatuses.get(s.id) ?? 'not-started';
				return `${s.id}. [${currentStatus}] ${s.title}`;
			}).join('\n');

			// Build the progress-check message using prompt-tsx. Render
			// the component, then append the resulting message to the
			// conversation delta. Instead of sending the full conversation
			// history on every check, we only send messages added since the
			// last check (the delta). The plan text already contains the
			// current status of each step, so the model has enough context
			// to determine progress from just the recent work. The model is
			// forced to call the manage_todo_list tool via tool_choice.
			const { messages: renderedMessages } = await renderPromptElement(
				this._instantiationService,
				endpoint,
				BackgroundProgressCheckPrompt,
				{ planText },
			);

			// Send only messages added since the last check (delta) to
			// reduce token usage. On the first check _lastCheckMessageCount
			// is 0, so the full history is sent. Subsequent checks only
			// include new messages.
			const deltaStart = Math.min(this._lastCheckMessageCount, prefixMessages.length);
			const deltaMessages = prefixMessages.slice(deltaStart);
			this._lastCheckMessageCount = prefixMessages.length;

			// Condense the delta: strip system messages, thinking blocks,
			// opaque parts, and truncate large tool-result / text content.
			// The progress-check prompt carries the plan + current statuses,
			// so the model only needs a summary of recent actions.
			const condensedDelta = this._condenseMessagesForCheck(deltaMessages);

			const messages = [...condensedDelta, ...renderedMessages];

			// Collect tool calls from the streaming response.
			// Use the same { name, arguments } shape the main loop collects,
			// normalising empty arguments to '{}' to avoid downstream
			// JSON.parse failures (mirrors ToolCallingLoop.finishedCb).
			const toolCalls: { name: string; arguments: string }[] = [];

			this._logService.debug(`[BackgroundProgressMonitor] Sending progress check: deltaMessages=${deltaMessages.length} → condensed=${condensedDelta.length} (from index ${deltaStart} of ${prefixMessages.length}), totalMessages=${messages.length}, endpoint=${endpoint.model}, max_tokens=${PROGRESS_CHECK_MAX_TOKENS}, tool=${toolName}`);
			this._logService.debug(`[BackgroundProgressMonitor] Plan text sent in request:\n${planText}`);
			this._logService.debug(`[BackgroundProgressMonitor] Condensed message roles: ${condensedDelta.map(m => m.role).join(', ')}`);

			const fetchResult = await endpoint.makeChatRequest(
				'backgroundProgressMonitor',
				messages,
				async (_text, _index, delta) => {
					if (delta.copilotToolCalls) {
						toolCalls.push(...delta.copilotToolCalls.map(call => ({
							name: call.name,
							arguments: call.arguments === '' ? '{}' : call.arguments,
						})));
					}
					return undefined;
				},
				token,
				ChatLocation.Other,
				undefined,
				{
					max_tokens: PROGRESS_CHECK_MAX_TOKENS,
					tools: [toolDef],
					tool_choice: { type: 'function', function: { name: toolName } },
				},
			);

			if (fetchResult.type !== ChatFetchResponseType.Success) {
				this._logService.warn(
					`[BackgroundProgressMonitor] LLM call returned non-success: type=${fetchResult.type}`,
				);
				return undefined;
			}

			this._logService.debug(`[BackgroundProgressMonitor] LLM response text (${fetchResult.value.length} chars): ${fetchResult.value}`);
			this._logService.debug(`[BackgroundProgressMonitor] Tool calls received: ${toolCalls.length} — ${toolCalls.map(tc => `${tc.name}(${tc.arguments.slice(0, 200)})`).join(', ')}`);

			// Find the manage_todo_list tool call.
			const todoToolCall = toolCalls.find(tc => tc.name === toolName);
			if (!todoToolCall) {
				this._logService.warn('[BackgroundProgressMonitor] No manage_todo_list tool call found in response');
				return undefined;
			}

			const result = this._parseToolCallResult(todoToolCall.arguments, plan);
			if (!result) {
				this._logService.warn(`[BackgroundProgressMonitor] Failed to parse tool call arguments: ${todoToolCall.arguments.slice(0, 300)}`);
			}
			return result;
		} catch (err: unknown) {
			if (!token.isCancellationRequested) {
				this._logService.error(err instanceof Error ? err : String(err), '[BackgroundProgressMonitor] Error during progress check');
			}
			return undefined;
		}
	}

	// ── Message condensing ───────────────────────────────────────────────

	/**
	 * Strips noise from the conversation delta so the background
	 * progress-check model sees only what it needs:
	 *
	 *  - System messages → removed (the check has its own instructions)
	 *  - Thinking / opaque parts → removed (internal reasoning, not useful)
	 *  - Tool-result text → truncated to {@link TOOL_RESULT_TRUNCATE_CHARS}
	 *  - Large text blocks → truncated to {@link TEXT_BLOCK_TRUNCATE_CHARS}
	 *  - Tool calls in assistant messages → kept (show agent intent)
	 *  - Cache breakpoints → removed (only useful for the main request)
	 */
	private _condenseMessagesForCheck(messages: Raw.ChatMessage[]): Raw.ChatMessage[] {
		const condensed: Raw.ChatMessage[] = [];
		for (const msg of messages) {
			if (msg.role === ChatRole.System) {
				continue;
			}

			const isToolResult = msg.role === ChatRole.Tool;
			const truncateLimit = isToolResult ? TOOL_RESULT_TRUNCATE_CHARS : TEXT_BLOCK_TRUNCATE_CHARS;

			const parts: Raw.ChatCompletionContentPart[] = [];
			for (const part of msg.content) {
				if (part.type === ChatCompletionContentPartKind.Opaque || part.type === ChatCompletionContentPartKind.CacheBreakpoint) {
					continue;
				}
				if (part.type === ChatCompletionContentPartKind.Text) {
					if (part.text.length > truncateLimit) {
						parts.push({ ...part, text: part.text.slice(0, truncateLimit) + `\n…[truncated ${part.text.length - truncateLimit} chars]` });
					} else {
						parts.push(part);
					}
					continue;
				}
				// Image / Document / others — keep as-is (rare in agentic conversations)
				parts.push(part);
			}

			if (parts.length > 0 || (msg.role === ChatRole.Assistant && (msg as Raw.AssistantChatMessage).toolCalls?.length)) {
				condensed.push({ ...msg, content: parts } as Raw.ChatMessage);
			}
		}
		return condensed;
	}

	/**
	 * Parses the manage_todo_list tool call arguments and applies
	 * anti-regression and ordering safeguards.
	 */
	private _parseToolCallResult(
		toolArguments: string,
		plan: IParsedPlan,
	): ITodoUpdate[] | undefined {
		try {
			const parsed = JSON.parse(toolArguments);
			const todoList: { id: number; title?: string; status?: string }[] = parsed?.todoList ?? parsed;
			if (!Array.isArray(todoList)) {
				this._logService.warn('[BackgroundProgressMonitor] Tool call arguments do not contain a valid todoList array');
				return undefined;
			}

			const validStatuses = new Set(['not-started', 'in-progress', 'completed']);
			const statusByIndex = new Map<number, ITodoUpdate['status']>();
			for (const item of todoList) {
				const planIdx = plan.steps.findIndex(s => s.id === item.id);
				if (planIdx >= 0) {
					const raw = validStatuses.has(item.status ?? '') ? item.status! as ITodoUpdate['status'] : 'not-started';
					statusByIndex.set(planIdx, raw);
				}
			}

			// Reject if the model returned a different number of steps than
			// the plan. This usually indicates the model fabricated a new
			// plan rather than updating the existing one, making the
			// per-step status assessments unreliable.
			if (todoList.length !== plan.steps.length) {
				this._logService.warn(`[BackgroundProgressMonitor] Step count mismatch: model returned ${todoList.length} steps, plan has ${plan.steps.length} — discarding result`);
				this._sendTelemetry('parseFailure', 0, 0, undefined);
				return undefined;
			}

			// Status ordering for anti-regression comparison.
			const statusRank: Record<ITodoUpdate['status'], number> = {
				'not-started': 0,
				'in-progress': 1,
				'completed': 2,
			};

			// Build result using the LLM's per-step assessments, but with
			// two safeguards:
			//   1. Anti-regression — a step can only advance forward
			//      (not-started → in-progress → completed), never backwards.
			//   2. No all-completed — at least one step must remain
			//      "in-progress" or "not-started"; only `complete()` can
			//      mark everything done.
			const result: { id: number; title: string; status: ITodoUpdate['status'] }[] = plan.steps.map((step, i) => {
				const llmStatus = statusByIndex.get(i) ?? 'not-started';
				const previousStatus = this._lastEmittedStatuses.get(step.id) ?? 'not-started';
				// Anti-regression: keep whichever status is further along.
				const status = statusRank[llmStatus] >= statusRank[previousStatus] ? llmStatus : previousStatus;
				return { id: step.id, title: step.title, status };
			});

			// Enforce ordering: if step N is "in-progress" or "completed",
			// all steps before it must be "completed". Walk backwards from
			// the last active step and fill in predecessors.
			for (let i = result.length - 1; i >= 0; i--) {
				if (result[i].status === 'in-progress' || result[i].status === 'completed') {
					for (let j = 0; j < i; j++) {
						if (result[j].status !== 'completed') {
							result[j].status = 'completed';
						}
					}
					break;
				}
			}

			// Guard: a background check must NEVER mark all steps completed.
			// If the LLM said everything is done, keep the last non-completed
			// step as "in-progress" instead.
			if (result.every(t => t.status === 'completed')) {
				const lastStep = result[result.length - 1];
				lastStep.status = 'in-progress';
				this._logService.debug('[BackgroundProgressMonitor] Capped all-completed response — last step forced to in-progress');
			}

			this._logService.debug(`[BackgroundProgressMonitor] Parsed response — LLM raw statuses: ${[...statusByIndex.entries()].map(([i, s]) => `${i}:${s}`).join(', ')}, previous: ${[...this._lastEmittedStatuses.entries()].map(([id, s]) => `${id}:${s}`).join(', ')}, final: ${result.map(t => `${t.id}:${t.status}`).join(', ')}`);
			return result;
		} catch {
			this._logService.warn(
				`[BackgroundProgressMonitor] Failed to parse tool call arguments: ${toolArguments.slice(0, 200)}`,
			);
			return undefined;
		}
	}
}
