/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ── Mission Control API types ───────────────────────────────────────────────────
// Mirrors the CLI's src/core/remote/types.ts for API compatibility.

/**
 * Resolved GitHub repository numeric IDs (from GitHub REST API).
 */
export interface RepoIdentifiers {
	ownerId: number;
	repoId: number;
}

/**
 * GitHub repository context combining string names with resolved numeric IDs.
 */
export interface GitHubRepository {
	owner: string;
	repo: string;
	repoIds: RepoIdentifiers;
}

/**
 * Mission Control session and task IDs needed to interact with an active MC session.
 */
export interface McSessionIds {
	mcSessionId: string;
	mcTaskId: string;
}

/**
 * Response from creating a session in Mission Control.
 */
export interface CreateSessionResponse {
	id: string;
	task_id?: string;
	agent_task_id?: string;
}

/**
 * A Mission Control session.
 */
export interface MissionControlSession {
	id: string;
	state: string;
	task_id?: string;
	owner_id: number;
	repo_id: number;
	created_at: string;
	updated_at: string;
}

// ── Session event types (CLI-compatible) ────────────────────────────────────────
// These match the MC event format so the cloud analytics pipeline processes
// VS Code sessions identically to CLI sessions.

/**
 * Base structure for all session events sent to Mission Control.
 */
export interface SessionEvent {
	/** Unique event identifier (UUID v4). */
	id: string;
	/** ISO 8601 timestamp when the event was created. */
	timestamp: string;
	/** ID of the chronologically preceding event, forming a linked chain. Null for the first event. */
	parentId: string | null;
	/** When true, the event is transient and not persisted. */
	ephemeral?: boolean;
	/** Event type discriminator. */
	type: string;
	/** Event-specific payload. */
	data: Record<string, unknown>;
}

/**
 * Working directory context schema for session.start events.
 */
export interface WorkingDirectoryContext {
	cwd?: string;
	repository?: string;
	branch?: string;
	headCommit?: string;
}

/** Reason why session creation failed. */
export type CreateSessionFailureReason = 'policy_blocked' | 'error';

/** Result of attempting to create a Mission Control session. */
export type CreateSessionResult =
	| { ok: true; response: CreateSessionResponse }
	| { ok: false; reason: CreateSessionFailureReason };
