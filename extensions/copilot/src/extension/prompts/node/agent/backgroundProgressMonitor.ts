/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { toTextParts } from '../../../../platform/chat/common/globalStringUtils';
import { ChatFetchResponseType, ChatLocation } from '../../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../../platform/log/common/logService';
import { IToolCallRound } from '../../../prompt/common/intents';

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
const ROUNDS_CHECK_THRESHOLD = 1;

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
 * loop.
 */
export class BackgroundProgressMonitor {

	private _state: MonitorState = MonitorState.Idle;
	private _plan: IParsedPlan | undefined;
	private _roundsSinceLastCheck = 0;
	private _accumulatedRounds: IToolCallRound[] = [];
	private _lastFedRoundIndex = -1;
	private _cts: CancellationTokenSource | undefined;
	private _checkInFlight = false;
	/** Status string per step id from the last _setTodos call, used to skip no-op updates. */
	private _lastEmittedStatuses = new Map<number, ITodoUpdate['status']>();

	constructor(
		private readonly _endpointProvider: IEndpointProvider,
		private readonly _logService: ILogService,
		private readonly _setTodos: SetTodosFn,
	) { }

	get isMonitoring(): boolean { return this._state === MonitorState.Monitoring; }

	// ── Public API ───────────────────────────────────────────────────────

	/**
	 * Starts monitoring with the detected plan.
	 * Seeds the todo list with all steps as `not-started`.
	 */
	start(plan: IParsedPlan, parentToken?: CancellationToken): void {
		if (this._state !== MonitorState.Idle) {
			return;
		}

		this._plan = plan;
		this._state = MonitorState.Monitoring;
		this._cts = new CancellationTokenSource(parentToken);
		this._roundsSinceLastCheck = 0;
		this._accumulatedRounds = [];
		this._lastFedRoundIndex = -1;

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
	 * last call) are consumed. When the accumulation threshold is hit a
	 * background check is fired asynchronously.
	 */
	feedRounds(rounds: readonly IToolCallRound[]): void {
		if (this._state !== MonitorState.Monitoring || !this._plan) {
			return;
		}

		for (let i = this._lastFedRoundIndex + 1; i < rounds.length; i++) {
			this._accumulatedRounds.push(rounds[i]);
			this._roundsSinceLastCheck++;
			this._lastFedRoundIndex = i;
		}

		if (this._roundsSinceLastCheck >= ROUNDS_CHECK_THRESHOLD && !this._checkInFlight) {
			this._triggerCheck();
		}
	}

	/**
	 * Marks all plan steps as completed and writes the final state to the
	 * todo list. Call this when the tool-calling loop finishes (the agent
	 * response is done) so the UI reflects 100% completion.
	 *
	 * This is a synchronous, local operation — no LLM call is made.
	 */
	complete(): void {
		if (this._state !== MonitorState.Monitoring || !this._plan) {
			return;
		}

		const finalTodos: ITodoUpdate[] = this._plan.steps.map(step => ({
			id: step.id,
			title: step.title,
			status: 'completed' as const,
		}));
		this._emitIfChanged(finalTodos);
		this._logService.debug('[BackgroundProgressMonitor] Marked all steps completed (loop finished)');
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
		this._accumulatedRounds = [];
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
			return;
		}

		this._checkInFlight = true;
		this._roundsSinceLastCheck = 0;

		const plan = this._plan;
		const rounds = [...this._accumulatedRounds];
		const token = this._cts.token;

		this._doCheckProgress(plan, rounds, token).then(
			updatedTodos => {
				this._checkInFlight = false;
				if (updatedTodos && this._state === MonitorState.Monitoring) {
					if (this._emitIfChanged(updatedTodos)) {
						this._logService.debug(
							`[BackgroundProgressMonitor] Updated todos: ${updatedTodos.map(t => `${t.id}:${t.status}`).join(', ')}`,
						);
					}
				}
			},
			err => {
				this._checkInFlight = false;
				this._logService.error(err, '[BackgroundProgressMonitor] Background progress check failed');
			},
		);
	}

	private async _doCheckProgress(
		plan: IParsedPlan,
		rounds: IToolCallRound[],
		token: CancellationToken,
	): Promise<ITodoUpdate[] | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		try {
			const endpoint = await this._endpointProvider.getChatEndpoint('copilot-fast');

			const actionsSummary = rounds
				.map((round, i) => {
					const toolNames = round.toolCalls.map(tc => tc.name).join(', ');
					const snippet = typeof round.response === 'string'
						? round.response.slice(0, 200)
						: '';
					return `Round ${i + 1}: tools=[${toolNames}]${snippet ? ` response="${snippet}"` : ''}`;
				})
				.join('\n');

			const planText = plan.steps.map(s => `${s.id}. ${s.title}`).join('\n');

			const messages: Raw.ChatMessage[] = [
				{
					role: Raw.ChatRole.System,
					content: toTextParts(
						'You are a progress tracker. Given a plan and a list of tool actions, determine the status of each step. ' +
						'Respond ONLY with a JSON array of objects with "id" (number), "title" (string), and ' +
						'"status" ("not-started" | "in-progress" | "completed"). ' +
						'Be conservative: only mark a step "completed" if the actions clearly show it is done. ' +
						'Mark the step currently being worked on as "in-progress".',
					),
				},
				{
					role: Raw.ChatRole.User,
					content: toTextParts(`Plan:\n${planText}\n\nActions taken:\n${actionsSummary}\n\nRespond with the JSON array only, no markdown fences.`),
				},
			];

			const fetchResult = await endpoint.makeChatRequest(
				'backgroundProgressMonitor',
				messages,
				undefined,
				token,
				ChatLocation.Other,
			);

			if (fetchResult.type !== ChatFetchResponseType.Success) {
				this._logService.warn(
					`[BackgroundProgressMonitor] LLM call returned non-success: ${fetchResult.type}`,
				);
				return undefined;
			}

			return this._parseProgressResponse(fetchResult.value, plan);
		} catch (err) {
			if (!token.isCancellationRequested) {
				this._logService.error(err, '[BackgroundProgressMonitor] Error during progress check');
			}
			return undefined;
		}
	}

	private _parseProgressResponse(
		responseText: string,
		plan: IParsedPlan,
	): ITodoUpdate[] | undefined {
		const trimmed = responseText.trim();
		if (!trimmed) {
			return undefined;
		}

		try {
			const parsed = JSON.parse(trimmed);
			if (!Array.isArray(parsed)) {
				return undefined;
			}

			const validStatuses = new Set(['not-started', 'in-progress', 'completed']);
			return parsed.map((item: { id: number; title?: string; status?: string }) => ({
				id: item.id,
				title: item.title || plan.steps.find(s => s.id === item.id)?.title || `Step ${item.id}`,
				status: (validStatuses.has(item.status ?? '') ? item.status! : 'not-started') as ITodoUpdate['status'],
			}));
		} catch {
			this._logService.warn(
				`[BackgroundProgressMonitor] Failed to parse LLM response: ${trimmed.slice(0, 200)}`,
			);
			return undefined;
		}
	}
}
