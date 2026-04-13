/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RefRow, SessionRow } from '../../../platform/chronicle/common/sessionStore';

/** A session row annotated with its source. */
export interface AnnotatedSession extends SessionRow {
	/** Where this session came from: 'vscode', 'cli', or 'cloud'. */
	source: 'vscode' | 'cli' | 'cloud';
}

/** A ref row annotated with its source. */
export interface AnnotatedRef extends RefRow {
	source: 'vscode' | 'cli' | 'cloud';
}

/** Sessions query — SQLite dialect, no time filter (demo) */
export const SESSIONS_QUERY_SQLITE = `SELECT id, summary, branch, repository, cwd, host_type, created_at, updated_at
	FROM sessions
	ORDER BY updated_at DESC`;

/** Build refs query for a list of session IDs */
export function buildRefsQuery(sessionIds: string[]): string {
	const ids = sessionIds.map(s => `'${s.replace(/'/g, '\'\'')}'`).join(',');
	return `SELECT session_id, ref_type, ref_value FROM session_refs WHERE session_id IN (${ids})`;
}

/** Build files query for a list of session IDs */
export function buildFilesQuery(sessionIds: string[]): string {
	const ids = sessionIds.map(s => `'${s.replace(/'/g, '\'\'')}'`).join(',');
	return `SELECT session_id, file_path, tool_name FROM session_files WHERE session_id IN (${ids})`;
}

/** Build turns query for a list of session IDs (user messages + assistant response summaries, truncated) */
export function buildTurnsQuery(sessionIds: string[]): string {
	const ids = sessionIds.map(s => `'${s.replace(/'/g, '\'\'')}'`).join(',');
	return `SELECT session_id, turn_index, substr(user_message, 1, 120) as user_message, substr(assistant_response, 1, 200) as assistant_response FROM turns WHERE session_id IN (${ids}) AND (user_message IS NOT NULL OR assistant_response IS NOT NULL) ORDER BY session_id, turn_index`;
}

/** A file row from the session_files table. */
export interface SessionFileInfo {
	session_id: string;
	file_path: string;
	tool_name?: string;
}

/** A turn summary from the turns table. */
export interface SessionTurnInfo {
	session_id: string;
	turn_index: number;
	user_message?: string;
	assistant_response?: string;
}

/**
 * Build a standup prompt from pre-fetched session and ref data.
 */
export function buildStandupPrompt(
	sessions: AnnotatedSession[],
	refs: AnnotatedRef[],
	extra?: string,
): string {
	if (sessions.length === 0) {
		return 'The user ran /standup but no sessions were found. Let them know there\'s no recent activity to report.';
	}

	const sessionLines = sessions.map(s => {
		const branch = s.branch ?? 'unknown';
		const repo = s.repository ?? 'unknown';
		const summary = s.summary ?? 'No summary';
		return `- ${s.id} | ${repo} (${branch}) | ${summary} | updated ${s.updated_at}`;
	});

	const refLines = refs.map(r => `- ${r.session_id} | ${r.ref_type}: ${r.ref_value}`);

	let prompt = `The user ran /chronicle standup. Generate a concise standup update from the pre-fetched data below.

## Pre-fetched Session Data (last 7 days)

### Sessions (${sessions.length})
${sessionLines.join('\n')}

### References (PRs, Issues, Commits)
${refLines.length > 0 ? refLines.join('\n') : 'No references found.'}

## Next Steps

1. For any PR references above, use GitHub tools to check their current status (open, merged, draft, closed).
2. If you need more detail on any session, ask the user for specifics.

## Output Format

Format the update grouped by work stream (branch). Use exactly this structure:

Standup for <date>:

**✅ Done**

Feature name (\`branch-name\` branch)
  - 3-7 words describing the status
  - Merged: [#123](https://github.com/owner/repo/pull/123)
  - Session: \`full-session-id\`

**🚧 In Progress**

Feature name (\`branch-name\` branch)
  - 3-7 words describing the current state of work
  - Draft: [#789](https://github.com/owner/repo/pull/789)
  - Session: \`full-session-id\`

Formatting rules:
- Keep it concise and succinct. The user can always ask follow up questions
- Link PRs and issues using markdown link syntax.
- For sessions, only show the most recent session per feature/branch.`;

	if (extra) {
		prompt += `\n\nAdditional context: ${extra}`;
	}

	return prompt;
}
