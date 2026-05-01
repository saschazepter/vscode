---
name: chronicle
description: Analyze Copilot session history for standup reports, usage tips, and session reindexing. Use when the user asks for a standup, daily summary, usage tips, workflow recommendations, or wants to reindex their session store.
context: fork
---

# Chronicle

Analyze the user's Copilot session history using the `session_store_sql` tool. This skill handles standup reports, usage analysis, and session store maintenance.

## Available Tool Actions

The `session_store_sql` tool supports three actions:

| Action | Purpose | `query` param |
|--------|---------|---------------|
| `standup` | Pre-fetch last 24h sessions, turns, files, refs | Not needed |
| `query` | Execute a read-only SQL query | Required |
| `reindex` | Rebuild local session index from debug logs | Not needed |

## Workflows

### Standup

When the user asks for a standup, daily summary, or "what did I do":

1. Call `session_store_sql` with `action: "standup"` and `description: "Generate standup"`.
2. The tool returns pre-fetched session data (sessions, turns, files, refs from the last 24 hours).
3. Format the returned data as a standup report grouped by work stream (branch/feature):

```
**✅ Done**

**Feature name** (`branch-name` branch, `repo-name`)
  - Summary of what was accomplished (grounded in user messages and assistant responses)
  - Key files: 2-3 most important files changed
  - PR: [#123](link) (if applicable)

**🚧 In Progress**

**Feature name** (`branch-name` branch, `repo-name`)
  - Summary of current work
  - Key files: 2-3 most important files being worked on
```

Rules:
- Use turn data (user messages AND assistant responses) to understand WHAT was done
- Use file paths to identify which components/areas were affected
- Group related sessions on the same branch into one entry
- Link PRs and issues using markdown link syntax
- Classify as Done if work appears complete, In Progress otherwise

### Tips

When the user asks for tips, workflow recommendations, or how to improve:

1. IMMEDIATELY call `session_store_sql` with `action: "query"` to query sessions from the last 7 days. Do not explain what you will do first.
2. Query the turns table to understand prompting patterns and conversation flow.
3. Query session_files to see which files and tools are used most frequently.
4. Query session_refs to see PR/issue/commit activity patterns.
5. Based on ALL this data, provide 3-5 specific, actionable tips grounded in actual usage patterns.

Analysis dimensions to explore:
- **Prompting patterns**: Are user messages vague or specific? Do they provide context? Average turns per session?
- **Tool usage**: Which tools are used most? Are there underutilized tools that could help?
- **Session patterns**: How long are sessions? Are there many short abandoned sessions?
- **File patterns**: Which areas of the codebase get the most attention? Any repeated edits to the same files?
- **Workflow**: Is the user leveraging agent mode, inline chat, custom instructions, prompt files?

### Reindex

When the user asks to reindex, rebuild, or refresh their session store:

1. Call `session_store_sql` with `action: "reindex"` and `description: "Reindex sessions"`.
2. The tool returns before/after stats showing sessions, turns, files, and refs counts.
3. Present the stats to the user.

## Query Guidelines

When using `action: "query"`:
- Only one query per call — do not combine multiple statements with semicolons
- Always use LIMIT (max 100) and prefer aggregations (COUNT, GROUP BY) over raw row dumps
- Query the **turns** table for conversation content — it gives the richest insight into what happened
- Query **session_files** for file paths and tool usage patterns
- Query **session_refs** for PR/issue/commit links
- Join tables using session_id for complete analysis
- Always filter on **updated_at** (not created_at) for time ranges
- Always JOIN sessions with turns to get session content — do not rely on sessions.summary alone

## Database Schema

### Tables (SQLite syntax — local)

- **sessions**: id, cwd (workspace folder path), repository, branch, summary, host_type, agent_name, agent_description, created_at, updated_at
- **turns**: session_id, turn_index, user_message, assistant_response (first ~1000 chars, may be truncated), timestamp
- **session_files**: session_id, file_path, tool_name, turn_index
- **session_refs**: session_id, ref_type (commit/pr/issue), ref_value, turn_index
- **search_index**: FTS5 table. Use `WHERE search_index MATCH 'query'` for full-text search

Date math: `datetime('now', '-1 day')`, `datetime('now', '-7 days')`
