/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

// #region Service Identifier

export const ICloudTaskService = createDecorator<ICloudTaskService>('cloudTaskService');

// #endregion

// #region Task Status

export type CloudTaskStatus =
	| 'queued'
	| 'in_progress'
	| 'completed'
	| 'failed'
	| 'idle'
	| 'waiting_for_user'
	| 'timed_out'
	| 'cancelled';

/**
 * Returns `true` when the task status represents a terminal/finished state.
 */
export function isTerminalTaskStatus(status: CloudTaskStatus): boolean {
	return status === 'completed'
		|| status === 'failed'
		|| status === 'timed_out'
		|| status === 'cancelled';
}

// #endregion

// #region Data Types

export interface ICloudTaskCollaborator {
	readonly agentType: string;
	readonly agentId: number;
	readonly agentTaskId: string;
}

export interface ICloudTaskArtifactGitHubResource {
	readonly provider: 'github';
	readonly type: 'github_resource';
	readonly data: {
		readonly id: number;
		readonly type: string;
		readonly globalId: string;
	};
}

export interface ICloudTaskArtifactBranch {
	readonly provider: 'github';
	readonly type: 'branch';
	readonly data: {
		readonly headRef: string;
		readonly baseRef: string;
	};
}

export type ICloudTaskArtifact = ICloudTaskArtifactGitHubResource | ICloudTaskArtifactBranch;

export interface ICloudTaskSession {
	readonly id: string;
	readonly name: string;
	readonly userId: number;
	readonly agentId: number;
	readonly state: CloudTaskStatus;
	readonly createdAt: string;
}

export interface ICloudTask {
	readonly id: string;
	readonly name: string;
	readonly creatorId: number;
	readonly userCollaborators: readonly number[];
	readonly agentCollaborators: readonly ICloudTaskCollaborator[];
	readonly ownerId: number;
	readonly repoId: number;
	/** Repository owner name (e.g. `"microsoft"`). Populated from the API route. */
	readonly ownerName: string;
	/** Repository name (e.g. `"vscode"`). Populated from the API route. */
	readonly repoName: string;
	readonly status: CloudTaskStatus;
	readonly sessionCount: number;
	readonly artifacts: readonly ICloudTaskArtifact[];
	readonly archivedAt: string | null;
	readonly lastUpdatedAt: string;
	readonly createdAt: string;
	/** Sessions are only populated when fetching a single task via `getTask()`. */
	readonly sessions?: readonly ICloudTaskSession[];
}

// #endregion

// #region Request / Response Types

export interface ICloudTaskCreateOptions {
	readonly owner: string;
	readonly repo: string;
	readonly eventContent: string;
	readonly problemStatement?: string;
	readonly model?: string;
	readonly baseRef?: string;
	readonly createPullRequest?: boolean;
	readonly eventType?: string;
}

export interface ICloudTaskFollowUpOptions {
	readonly eventContent: string;
	readonly problemStatement?: string;
	readonly model?: string;
	readonly eventType?: string;
}

export interface ICloudTaskListOptions {
	readonly pageSize?: number;
	readonly pageNumber?: number;
	readonly sort?: string;
	readonly status?: string;
	readonly archived?: boolean;
	readonly includeCounts?: boolean;
	readonly taskIds?: string;
}

export interface ICloudTaskListResult {
	readonly tasks: readonly ICloudTask[];
	readonly hasNextPage: boolean;
	readonly totalActiveCount?: number;
	readonly totalArchivedCount?: number;
}

// #endregion

// #region Events

export interface ICloudTaskChangeEvent {
	readonly type: 'added' | 'updated' | 'removed';
	readonly taskId: string;
	readonly task?: ICloudTask;
}

// #endregion

// #region Service Interface

export interface ICloudTaskService {
	readonly _serviceBrand: undefined;

	// --- Task CRUD ---

	/** List all tasks for the authenticated user. */
	listTasks(options?: ICloudTaskListOptions): Promise<ICloudTaskListResult>;

	/** List tasks for a specific repository. */
	listRepoTasks(owner: string, repo: string, options?: ICloudTaskListOptions): Promise<ICloudTaskListResult>;

	/** Get a single task by ID, including its sessions. */
	getTask(owner: string, repo: string, taskId: string): Promise<ICloudTask>;

	/** Create a new task and enqueue an agent job. */
	createTask(options: ICloudTaskCreateOptions): Promise<ICloudTask>;

	/** Create a follow-up session on an existing task. Returns immediately (202 Accepted). */
	createFollowUpSession(owner: string, repo: string, taskId: string, options: ICloudTaskFollowUpOptions): Promise<void>;

	/** Archive a task. */
	archiveTask(owner: string, repo: string, taskId: string): Promise<ICloudTask>;

	// --- Logs ---

	/** Get inactive session logs for a task. Returns a map of sessionId → log content. */
	getInactiveLogs(owner: string, repo: string, taskId: string): Promise<Record<string, string>>;

	// --- Events ---

	/** Fires when the task list changes (task added, updated, or removed). */
	readonly onDidChangeTasks: Event<ICloudTaskChangeEvent>;

	// --- Polling ---

	/** Start polling for task list updates at the given interval (default: 30s). */
	startPolling(intervalMs?: number): void;

	/** Stop polling for task list updates. */
	stopPolling(): void;

	// --- Auth ---

	/** Whether the service has a valid authentication token. */
	readonly isAuthenticated: boolean;

	/** Fires when the authentication state changes. */
	readonly onDidChangeAuthentication: Event<boolean>;
}

// #endregion
