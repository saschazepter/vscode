/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { IOTelSqliteStore, type OTelSqliteStore, type UsageSummary } from '../../../platform/otel/node/sqlite/otelSqliteStore';
import { ChatLocation } from '../../../platform/chat/common/commonTypes';

/** Subcommands map to a time window in milliseconds. */
const WINDOWS_MS = {
	today: 24 * 60 * 60 * 1000,
	week: 7 * 24 * 60 * 60 * 1000,
	month: 30 * 24 * 60 * 60 * 1000,
} as const;

export type UsageSubcommand = keyof typeof WINDOWS_MS;

/** Maximum rows to render per breakdown table. */
const MAX_MODELS = 10;
const MAX_TOOLS = 10;
const MAX_SESSIONS = 10;

/**
 * Format a usage summary as a human-readable markdown report. Pure function —
 * exported for unit testing and so callers can compose the output if needed.
 */
export function formatUsageMarkdown(summary: UsageSummary, subcommand: UsageSubcommand, now: number = Date.now()): string {
	const { totals, models, tools, sessions } = summary;

	const windowLabel = labelForSubcommand(subcommand);
	const lines: string[] = [];

	lines.push(l10n.t('## Copilot usage — {0}', windowLabel));
	lines.push('');

	if (totals.session_count === 0 && totals.llm_calls === 0 && totals.tool_calls === 0) {
		lines.push(l10n.t('No usage data recorded in this window. Usage telemetry begins collecting as you chat with Copilot.'));
		appendRetentionFooter(lines);
		return lines.join('\n');
	}

	// Totals
	const totalTokens = totals.input_tokens + totals.output_tokens;
	lines.push(`| | |`);
	lines.push(`|---|---:|`);
	lines.push(`| ${l10n.t('Conversations')} | ${formatInt(totals.session_count)} |`);
	lines.push(`| ${l10n.t('Model calls')} | ${formatInt(totals.llm_calls)} |`);
	lines.push(`| ${l10n.t('Tool calls')} | ${formatInt(totals.tool_calls)} |`);
	lines.push(`| ${l10n.t('Input tokens')} | ${formatInt(totals.input_tokens)} |`);
	lines.push(`| ${l10n.t('Output tokens')} | ${formatInt(totals.output_tokens)} |`);
	lines.push(`| ${l10n.t('Total tokens')} | ${formatInt(totalTokens)} |`);
	if (totals.cached_tokens > 0) {
		lines.push(`| ${l10n.t('Cached tokens')} | ${formatInt(totals.cached_tokens)} |`);
	}
	if (totals.reasoning_tokens > 0) {
		lines.push(`| ${l10n.t('Reasoning tokens')} | ${formatInt(totals.reasoning_tokens)} |`);
	}
	lines.push(`| ${l10n.t('Active duration')} | ${formatDuration(totals.duration_ms)} |`);
	lines.push('');

	if (models.length > 0) {
		lines.push(`### ${l10n.t('Models')}`);
		lines.push('');
		lines.push(`| ${l10n.t('Model')} | ${l10n.t('Calls')} | ${l10n.t('Input')} | ${l10n.t('Output')} |`);
		lines.push(`|---|---:|---:|---:|`);
		for (const m of models.slice(0, MAX_MODELS)) {
			lines.push(`| ${escapeCell(m.model)} | ${formatInt(m.calls)} | ${formatInt(m.input_tokens)} | ${formatInt(m.output_tokens)} |`);
		}
		if (models.length > MAX_MODELS) {
			lines.push('');
			lines.push(l10n.t('…and {0} more model(s).', models.length - MAX_MODELS));
		}
		lines.push('');
	}

	if (tools.length > 0) {
		lines.push(`### ${l10n.t('Tools')}`);
		lines.push('');
		lines.push(`| ${l10n.t('Tool')} | ${l10n.t('Calls')} | ${l10n.t('Errors')} |`);
		lines.push(`|---|---:|---:|`);
		for (const t of tools.slice(0, MAX_TOOLS)) {
			lines.push(`| ${escapeCell(t.tool_name)} | ${formatInt(t.calls)} | ${formatInt(t.error_calls)} |`);
		}
		if (tools.length > MAX_TOOLS) {
			lines.push('');
			lines.push(l10n.t('…and {0} more tool(s).', tools.length - MAX_TOOLS));
		}
		lines.push('');
	}

	if (sessions.length > 0) {
		lines.push(`### ${l10n.t('Recent conversations')}`);
		lines.push('');
		lines.push(`| ${l10n.t('Started')} | ${l10n.t('Agent')} | ${l10n.t('Model')} | ${l10n.t('LLM')} | ${l10n.t('Tools')} | ${l10n.t('Tokens')} | ${l10n.t('Duration')} |`);
		lines.push(`|---|---|---|---:|---:|---:|---:|`);
		for (const s of sessions.slice(0, MAX_SESSIONS)) {
			const tokens = s.total_input_tokens + s.total_output_tokens;
			lines.push(`| ${formatRelative(s.started_at, now)} | ${escapeCell(s.agent_name ?? '—')} | ${escapeCell(s.model ?? '—')} | ${formatInt(s.llm_calls)} | ${formatInt(s.tool_calls)} | ${formatInt(tokens)} | ${formatDuration(s.duration_ms)} |`);
		}
		if (sessions.length > MAX_SESSIONS) {
			lines.push('');
			lines.push(l10n.t('…and {0} more conversation(s).', sessions.length - MAX_SESSIONS));
		}
		lines.push('');
	}

	appendRetentionFooter(lines);
	return lines.join('\n');
}

function appendRetentionFooter(lines: string[]): void {
	lines.push('---');
	lines.push(l10n.t('_Usage data is collected locally from OpenTelemetry spans and retained for up to 7 days._'));
}

function labelForSubcommand(sub: UsageSubcommand): string {
	switch (sub) {
		case 'today': return l10n.t('last 24 hours');
		case 'week': return l10n.t('last 7 days');
		case 'month': return l10n.t('last 30 days');
	}
}

function formatInt(n: number): string {
	return Math.round(n).toLocaleString();
}

/**
 * Compact human-readable duration: ms → "1.2s", "3m 4s", "2h 5m", "1d 3h".
 */
function formatDuration(ms: number): string {
	if (!ms || ms < 0) { return '—'; }
	const sec = ms / 1000;
	if (sec < 60) { return `${sec.toFixed(1)}s`; }
	const min = Math.floor(sec / 60);
	const remSec = Math.floor(sec % 60);
	if (min < 60) { return `${min}m ${remSec}s`; }
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	if (hr < 24) { return `${hr}h ${remMin}m`; }
	const day = Math.floor(hr / 24);
	const remHr = hr % 24;
	return `${day}d ${remHr}h`;
}

/** "5m ago", "2h ago", "3d ago". */
function formatRelative(timestampMs: number, now: number): string {
	const diff = Math.max(0, now - timestampMs);
	const sec = Math.floor(diff / 1000);
	if (sec < 60) { return l10n.t('{0}s ago', sec); }
	const min = Math.floor(sec / 60);
	if (min < 60) { return l10n.t('{0}m ago', min); }
	const hr = Math.floor(min / 60);
	if (hr < 24) { return l10n.t('{0}h ago', hr); }
	const day = Math.floor(hr / 24);
	return l10n.t('{0}d ago', day);
}

/** Escape pipe characters to keep markdown table cells well-formed. */
function escapeCell(value: string): string {
	return value.replace(/\|/g, '\\|');
}

/**
 * Resolve which subcommand to run from the chat request. Accepts both the
 * explicit `command` form (`/usage:today`) and the bare-prompt form
 * (`/usage today`). Defaults to `week`.
 */
export function resolveUsageSubcommand(request: { command?: string; prompt?: string }): UsageSubcommand {
	const fromCommand = request.command?.includes(':')
		? request.command.slice(request.command.indexOf(':') + 1).toLowerCase()
		: undefined;
	const fromPrompt = (request.prompt ?? '').trim().toLowerCase().split(/\s+/)[0];
	const candidate = fromCommand || fromPrompt;
	if (candidate === 'today' || candidate === 'week' || candidate === 'month') {
		return candidate;
	}
	return 'week';
}

// ── Intent registration ────────────────────────────────────────────────────────

import type * as vscode from 'vscode';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { Conversation } from '../../prompt/common/conversation';
import { ChatTelemetryBuilder } from '../../prompt/node/chatParticipantTelemetry';
import { IDocumentContext } from '../../prompt/node/documentContext';
import { IIntent, IIntentInvocation, IIntentInvocationContext, IIntentSlashCommandInfo, NullIntentInvocation } from '../../prompt/node/intents';

export class UsageIntent implements IIntent {

	static readonly ID = 'usage';
	readonly id = UsageIntent.ID;
	readonly description = l10n.t('Show how you use Copilot — models, tokens, conversations, and tools.');
	readonly locations = [ChatLocation.Panel];

	readonly commandInfo: IIntentSlashCommandInfo = {
		allowsEmptyArgs: true,
	};

	constructor(
		@IOTelSqliteStore private readonly _store: OTelSqliteStore,
		@IEndpointProvider private readonly _endpointProvider: IEndpointProvider,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) { }

	async handleRequest(
		_conversation: Conversation,
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		_token: CancellationToken,
		_documentContext: IDocumentContext | undefined,
		_agentName: string,
		_location: ChatLocation,
		_chatTelemetry: ChatTelemetryBuilder,
	): Promise<vscode.ChatResult> {
		const startedAt = Date.now();
		const subcommand = resolveUsageSubcommand(request);
		const sinceMs = startedAt - WINDOWS_MS[subcommand];

		let summary: UsageSummary;
		try {
			summary = this._store.getUsageSummary(sinceMs);
		} catch (err) {
			/* __GDPR__
"usageError" : {
"owner": "pierceboggan",
"comment": "Tracks failures of the /usage slash command summary query.",
"subcommand": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The /usage subcommand: today, week, or month." },
"errorMessage": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth", "comment": "Truncated error message." }
}
*/
			this._telemetryService.sendMSFTTelemetryErrorEvent('usageError', {
				subcommand,
				errorMessage: err instanceof Error ? err.message.substring(0, 200) : 'unknown',
			});
			stream.markdown(l10n.t('Failed to read usage data. Please try again.'));
			return {};
		}

		stream.markdown(formatUsageMarkdown(summary, subcommand, startedAt));

		/* __GDPR__
"usage" : {
"owner": "pierceboggan",
"comment": "Tracks /usage slash command invocations and aggregate counts shown to the user.",
"subcommand": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The /usage subcommand: today, week, or month." },
"sessionCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of distinct conversations in the window." },
"llmCallCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of LLM (chat) calls in the window." },
"toolCallCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of tool calls in the window." },
"modelCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of distinct models used in the window." },
"toolCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Number of distinct tools used in the window." },
"inputTokens": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total input tokens across LLM calls in the window." },
"outputTokens": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total output tokens across LLM calls in the window." },
"queryDurationMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Time spent computing the usage summary, in milliseconds." }
}
*/
		this._telemetryService.sendMSFTTelemetryEvent('usage', {
			subcommand,
		}, {
			sessionCount: summary.totals.session_count,
			llmCallCount: summary.totals.llm_calls,
			toolCallCount: summary.totals.tool_calls,
			modelCount: summary.models.length,
			toolCount: summary.tools.length,
			inputTokens: summary.totals.input_tokens,
			outputTokens: summary.totals.output_tokens,
			queryDurationMs: Date.now() - startedAt,
		});

		return {};
	}

	async invoke(invocationContext: IIntentInvocationContext): Promise<IIntentInvocation> {
		// `handleRequest` short-circuits the default flow, so `invoke` is effectively unused.
		// Per the IIntent contract documentation, return a NullIntentInvocation as fallback.
		const { location, request } = invocationContext;
		const endpoint: IChatEndpoint = await this._endpointProvider.getChatEndpoint(request);
		return new NullIntentInvocation(this, location, endpoint);
	}
}
