/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import type { UsageSummary } from '../../../../platform/otel/node/sqlite/otelSqliteStore';
import { formatUsageMarkdown, resolveUsageSubcommand } from '../usageIntent';

const FIXED_NOW = 1_700_000_000_000;

function emptySummary(sinceMs: number): UsageSummary {
	return {
		since_ms: sinceMs,
		totals: {
			session_count: 0,
			llm_calls: 0,
			tool_calls: 0,
			input_tokens: 0,
			output_tokens: 0,
			cached_tokens: 0,
			reasoning_tokens: 0,
			duration_ms: 0,
		},
		models: [],
		tools: [],
		sessions: [],
	};
}

function populatedSummary(sinceMs: number): UsageSummary {
	return {
		since_ms: sinceMs,
		totals: {
			session_count: 3,
			llm_calls: 12,
			tool_calls: 7,
			input_tokens: 4500,
			output_tokens: 1200,
			cached_tokens: 800,
			reasoning_tokens: 0,
			duration_ms: 65_000,
		},
		models: [
			{ model: 'gpt-4o', calls: 8, input_tokens: 3000, output_tokens: 800, cached_tokens: 600, reasoning_tokens: 0 },
			{ model: 'claude-3.5', calls: 4, input_tokens: 1500, output_tokens: 400, cached_tokens: 200, reasoning_tokens: 0 },
		],
		tools: [
			{ tool_name: 'read_file', calls: 5, error_calls: 0 },
			{ tool_name: 'run_in_terminal', calls: 2, error_calls: 1 },
		],
		sessions: [
			{
				session_id: 'conv-1',
				agent_name: 'editor',
				model: 'gpt-4o',
				started_at: FIXED_NOW - 60_000,
				ended_at: FIXED_NOW - 5_000,
				duration_ms: 55_000,
				span_count: 10,
				llm_calls: 6,
				tool_calls: 4,
				total_input_tokens: 2500,
				total_output_tokens: 700,
				total_cached_tokens: 400,
			},
			{
				session_id: 'conv-2',
				agent_name: null,
				model: 'claude-3.5',
				started_at: FIXED_NOW - 300_000,
				ended_at: FIXED_NOW - 60_000,
				duration_ms: 240_000,
				span_count: 6,
				llm_calls: 4,
				tool_calls: 2,
				total_input_tokens: 1500,
				total_output_tokens: 400,
				total_cached_tokens: 200,
			},
		],
	};
}

describe('formatUsageMarkdown', () => {
	test('renders a friendly empty-state message when no usage was recorded', () => {
		const md = formatUsageMarkdown(emptySummary(FIXED_NOW - 7 * 24 * 60 * 60 * 1000), 'week', FIXED_NOW);
		expect(md).toMatchSnapshot();
	});

	test('renders totals, top models, top tools, and session breakdown', () => {
		const md = formatUsageMarkdown(populatedSummary(FIXED_NOW - 7 * 24 * 60 * 60 * 1000), 'week', FIXED_NOW);
		expect(md).toMatchSnapshot();
	});
});

describe('resolveUsageSubcommand', () => {
	test('resolves subcommand from command suffix, prompt token, or defaults to week', () => {
		const cases = [
			resolveUsageSubcommand({ command: 'usage:today' }),
			resolveUsageSubcommand({ command: 'usage:week' }),
			resolveUsageSubcommand({ command: 'usage:month' }),
			resolveUsageSubcommand({ command: 'usage' }),
			resolveUsageSubcommand({ command: 'usage', prompt: 'today' }),
			resolveUsageSubcommand({ command: 'usage', prompt: 'MONTH extra noise' }),
			resolveUsageSubcommand({ command: 'usage', prompt: 'garbage' }),
			resolveUsageSubcommand({}),
		];
		expect(cases).toEqual(['today', 'week', 'month', 'week', 'today', 'month', 'week', 'week']);
	});
});
