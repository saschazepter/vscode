/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { asJson, IRequestService, isSuccess } from '../../request/common/request.js';
// eslint-disable-next-line local/code-import-patterns
import { IAuthenticationService } from '../../../workbench/services/authentication/common/authentication.js';
import { IDefaultAccountService } from '../../defaultAccount/common/defaultAccount.js';
import {
	type CloudTaskStatus,
	type ICloudTask,
	type ICloudTaskArtifact,
	type ICloudTaskChangeEvent,
	type ICloudTaskCollaborator,
	type ICloudTaskCreateOptions,
	type ICloudTaskFollowUpOptions,
	type ICloudTaskListOptions,
	type ICloudTaskListResult,
	type ICloudTaskService,
	type ICloudTaskSession,
} from '../common/cloudTaskService.js';

// ---------------------------------------------------------------------------
// Configuration - change these for testing against a different environment
// ---------------------------------------------------------------------------

const CLOUD_TASK_API_BASE = 'https://api.githubcopilot.com';
const CLOUD_TASK_API_PATH = '/agents';
const DEFAULT_POLL_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// JSON response shapes (raw API → internal types mapping)
// ---------------------------------------------------------------------------

interface RawTaskCollaborator {
	readonly agent_type: string;
	readonly agent_id: number;
	readonly agent_task_id: string;
}

interface RawTaskArtifact {
	readonly provider: string;
	readonly type: string;
	readonly data: Record<string, unknown>;
}

interface RawTaskSession {
	readonly id: string;
	readonly name: string;
	readonly user_id: number;
	readonly agent_id: number;
	readonly state: string;
	readonly created_at: string;
}

interface RawTask {
	readonly id: string;
	readonly name: string;
	readonly creator_id: number;
	readonly user_collaborators: readonly number[];
	readonly agent_collaborators: readonly RawTaskCollaborator[];
	readonly owner_id: number;
	readonly repo_id: number;
	readonly status: string;
	readonly session_count: number;
	readonly artifacts: readonly RawTaskArtifact[];
	readonly archived_at: string | null;
	readonly last_updated_at: string;
	readonly created_at: string;
	readonly sessions?: readonly RawTaskSession[];
	// Optional fields that some endpoints may return
	readonly owner_login?: string;
	readonly repo_name?: string;
	readonly full_name?: string; // "owner/repo"
}

interface RawListResponse {
	readonly tasks: readonly RawTask[];
	readonly has_next_page: boolean;
	readonly total_active_count?: number;
	readonly total_archived_count?: number;
}

interface RawCreateResponse {
	readonly task: RawTask;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapCollaborator(raw: RawTaskCollaborator): ICloudTaskCollaborator {
	return {
		agentType: raw.agent_type,
		agentId: raw.agent_id,
		agentTaskId: raw.agent_task_id,
	};
}

function mapArtifact(raw: RawTaskArtifact): ICloudTaskArtifact {
	if (raw.type === 'branch') {
		return {
			provider: 'github',
			type: 'branch',
			data: {
				headRef: String(raw.data['head_ref'] ?? ''),
				baseRef: String(raw.data['base_ref'] ?? ''),
			},
		};
	}
	return {
		provider: 'github',
		type: 'github_resource',
		data: {
			id: Number(raw.data['id'] ?? 0),
			type: String(raw.data['type'] ?? ''),
			globalId: String(raw.data['global_id'] ?? ''),
		},
	};
}

function mapSession(raw: RawTaskSession): ICloudTaskSession {
	return {
		id: raw.id,
		name: raw.name,
		userId: raw.user_id,
		agentId: raw.agent_id,
		state: raw.state as CloudTaskStatus,
		createdAt: raw.created_at,
	};
}

function mapTask(raw: RawTask, ownerName: string, repoName: string): ICloudTask {
	// Prefer explicit owner/repo from the route, but fall back to API response fields
	let resolvedOwner = ownerName;
	let resolvedRepo = repoName;
	if (!resolvedOwner || !resolvedRepo) {
		if (raw.full_name) {
			const slash = raw.full_name.indexOf('/');
			if (slash > 0) {
				resolvedOwner = resolvedOwner || raw.full_name.substring(0, slash);
				resolvedRepo = resolvedRepo || raw.full_name.substring(slash + 1);
			}
		}
		if (raw.owner_login) { resolvedOwner = resolvedOwner || raw.owner_login; }
		if (raw.repo_name) { resolvedRepo = resolvedRepo || raw.repo_name; }
	}

	return {
		id: raw.id,
		name: raw.name,
		creatorId: raw.creator_id,
		userCollaborators: raw.user_collaborators,
		agentCollaborators: raw.agent_collaborators.map(mapCollaborator),
		ownerId: raw.owner_id,
		repoId: raw.repo_id,
		ownerName: resolvedOwner,
		repoName: resolvedRepo,
		status: raw.status as CloudTaskStatus,
		sessionCount: raw.session_count,
		artifacts: raw.artifacts.map(mapArtifact),
		archivedAt: raw.archived_at,
		lastUpdatedAt: raw.last_updated_at,
		createdAt: raw.created_at,
		sessions: raw.sessions?.map(mapSession),
	};
}

// ---------------------------------------------------------------------------
// Service Implementation
// ---------------------------------------------------------------------------

export class CloudTaskService extends Disposable implements ICloudTaskService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTasks = this._register(new Emitter<ICloudTaskChangeEvent>());
	readonly onDidChangeTasks: Event<ICloudTaskChangeEvent> = this._onDidChangeTasks.event;

	private readonly _onDidChangeAuthentication = this._register(new Emitter<boolean>());
	readonly onDidChangeAuthentication: Event<boolean> = this._onDidChangeAuthentication.event;

	private _isAuthenticated = false;
	get isAuthenticated(): boolean { return this._isAuthenticated; }

	private readonly _taskCache = new Map<string, ICloudTask>();
	private _pollTimer: ReturnType<typeof setInterval> | undefined;
	private readonly _trackedRepos = new Set<string>(); // "owner/repo" keys

	constructor(
		@IRequestService private readonly _requestService: IRequestService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IDefaultAccountService private readonly _defaultAccountService: IDefaultAccountService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		// Watch for authentication changes
		this._register(this._defaultAccountService.onDidChangeDefaultAccount(() => {
			this._refreshAuthState();
		}));

		this._refreshAuthState();
	}

	// -----------------------------------------------------------------------
	// Task CRUD
	// -----------------------------------------------------------------------

	async listTasks(options?: ICloudTaskListOptions): Promise<ICloudTaskListResult> {
		const params = this._buildListParams(options);
		const raw = await this._get<RawListResponse>(`/tasks${params}`);
		if (!raw) {
			return { tasks: [], hasNextPage: false };
		}
		const tasks = raw.tasks.map(t => mapTask(t, '', ''));
		return {
			tasks,
			hasNextPage: raw.has_next_page,
			totalActiveCount: raw.total_active_count,
			totalArchivedCount: raw.total_archived_count,
		};
	}

	async listRepoTasks(owner: string, repo: string, options?: ICloudTaskListOptions): Promise<ICloudTaskListResult> {
		this._trackedRepos.add(`${owner}/${repo}`);
		const params = this._buildListParams(options);
		const raw = await this._get<RawListResponse>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tasks${params}`);
		if (!raw) {
			return { tasks: [], hasNextPage: false };
		}
		const tasks = raw.tasks.map(t => mapTask(t, owner, repo));
		return {
			tasks,
			hasNextPage: raw.has_next_page,
			totalActiveCount: raw.total_active_count,
			totalArchivedCount: raw.total_archived_count,
		};
	}

	async getTask(owner: string, repo: string, taskId: string): Promise<ICloudTask> {
		const raw = await this._get<RawTask>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(taskId)}`);
		if (!raw) {
			throw new Error(`Task ${taskId} not found`);
		}
		return mapTask(raw, owner, repo);
	}

	async createTask(options: ICloudTaskCreateOptions): Promise<ICloudTask> {
		const body: Record<string, unknown> = {
			event_content: options.eventContent,
		};
		if (options.problemStatement) { body['problem_statement'] = options.problemStatement; }
		if (options.model) { body['model'] = options.model; }
		if (options.baseRef) { body['base_ref'] = options.baseRef; }
		if (options.createPullRequest !== undefined) { body['create_pull_request'] = options.createPullRequest; }
		if (options.eventType) { body['event_type'] = options.eventType; }

		const raw = await this._post<RawCreateResponse>(
			`/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/tasks`,
			body,
		);
		if (!raw?.task) {
			throw new Error('Failed to create task: empty response');
		}
		const task = mapTask(raw.task, options.owner, options.repo);
		this._taskCache.set(task.id, task);
		this._onDidChangeTasks.fire({ type: 'added', taskId: task.id, task });
		return task;
	}

	async createFollowUpSession(owner: string, repo: string, taskId: string, options: ICloudTaskFollowUpOptions): Promise<void> {
		const body: Record<string, unknown> = {
			event_content: options.eventContent,
		};
		if (options.problemStatement) { body['problem_statement'] = options.problemStatement; }
		if (options.model) { body['model'] = options.model; }
		if (options.eventType) { body['event_type'] = options.eventType; }

		await this._post<null>(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(taskId)}/sessions`,
			body,
		);
		// 202 Accepted - the session will appear asynchronously
	}

	async archiveTask(owner: string, repo: string, taskId: string): Promise<ICloudTask> {
		const raw = await this._post<RawTask>(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(taskId)}/archive`,
			{},
		);
		if (!raw) {
			throw new Error('Failed to archive task');
		}
		const task = mapTask(raw, owner, repo);
		this._taskCache.set(task.id, task);
		this._onDidChangeTasks.fire({ type: 'updated', taskId: task.id, task });
		return task;
	}

	// -----------------------------------------------------------------------
	// Logs
	// -----------------------------------------------------------------------

	async getInactiveLogs(owner: string, repo: string, taskId: string): Promise<Record<string, string>> {
		const raw = await this._get<{ logs: Record<string, string> }>(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(taskId)}/inactive_logs`,
		);
		return raw?.logs ?? {};
	}

	// -----------------------------------------------------------------------
	// Polling
	// -----------------------------------------------------------------------

	startPolling(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
		this.stopPolling();
		this._pollTimer = globalThis.setInterval(() => this._pollForChanges(), intervalMs);
	}

	stopPolling(): void {
		if (this._pollTimer !== undefined) {
			globalThis.clearInterval(this._pollTimer);
			this._pollTimer = undefined;
		}
	}

	override dispose(): void {
		this.stopPolling();
		super.dispose();
	}

	// -----------------------------------------------------------------------
	// Private - HTTP helpers
	// -----------------------------------------------------------------------

	private async _getAccessToken(): Promise<string> {
		const defaultAccount = await this._defaultAccountService.getDefaultAccount();
		if (!defaultAccount) {
			this._setAuthenticated(false);
			throw new Error('Not authenticated - no default account');
		}

		const authProviderId = defaultAccount.authenticationProvider.id;
		const sessions = await this._authenticationService.getSessions(authProviderId);
		const session = sessions.find(s => s.id === defaultAccount.sessionId);
		if (!session) {
			this._setAuthenticated(false);
			throw new Error('Not authenticated - session not found');
		}

		this._setAuthenticated(true);
		return session.accessToken;
	}

	private async _get<T>(path: string): Promise<T | null> {
		const token = await this._getAccessToken();
		const url = `${CLOUD_TASK_API_BASE}${CLOUD_TASK_API_PATH}${path}`;
		this._logService.trace(`[CloudTaskService] GET ${url}`);
		const context = await this._requestService.request({
			type: 'GET',
			url,
			headers: {
				'Authorization': `Bearer ${token}`,
				'Accept': 'application/json',
			},
		}, CancellationToken.None);

		if (context.res.statusCode === 401) {
			this._setAuthenticated(false);
			throw new Error('Authentication failed (401)');
		}
		if (context.res.statusCode === 404) {
			return null;
		}
		if (!isSuccess(context)) {
			throw new Error(`Server returned ${context.res.statusCode}`);
		}
		return asJson<T>(context);
	}

	private async _post<T>(path: string, body: unknown): Promise<T | null> {
		const token = await this._getAccessToken();
		const url = `${CLOUD_TASK_API_BASE}${CLOUD_TASK_API_PATH}${path}`;
		this._logService.trace(`[CloudTaskService] POST ${url}`);
		const context = await this._requestService.request({
			type: 'POST',
			url,
			headers: {
				'Authorization': `Bearer ${token}`,
				'Accept': 'application/json',
				'Content-Type': 'application/json',
			},
			data: JSON.stringify(body),
		}, CancellationToken.None);

		if (context.res.statusCode === 401) {
			this._setAuthenticated(false);
			throw new Error('Authentication failed (401)');
		}

		// 202 Accepted has no body
		if (context.res.statusCode === 202) {
			return null;
		}

		if (!isSuccess(context)) {
			throw new Error(`Request failed: ${context.res.statusCode}`);
		}

		return asJson<T>(context);
	}

	private _buildListParams(options?: ICloudTaskListOptions): string {
		if (!options) {
			return '';
		}
		const params = new URLSearchParams();
		if (options.pageSize !== undefined) { params.set('page_size', String(options.pageSize)); }
		if (options.pageNumber !== undefined) { params.set('page_number', String(options.pageNumber)); }
		if (options.sort) { params.set('sort', options.sort); }
		if (options.status) { params.set('status', options.status); }
		if (options.archived !== undefined) { params.set('archived', String(options.archived)); }
		if (options.includeCounts) { params.set('include_counts', 'true'); }
		if (options.taskIds) { params.set('task_ids', options.taskIds); }
		const str = params.toString();
		return str ? `?${str}` : '';
	}

	// -----------------------------------------------------------------------
	// Private - Auth state
	// -----------------------------------------------------------------------

	private _setAuthenticated(value: boolean): void {
		if (this._isAuthenticated !== value) {
			this._isAuthenticated = value;
			this._onDidChangeAuthentication.fire(value);
		}
	}

	private async _refreshAuthState(): Promise<void> {
		try {
			await this._getAccessToken();
		} catch {
			// Not authenticated - already handled in _getAccessToken
		}
	}

	// -----------------------------------------------------------------------
	// Private - Polling
	// -----------------------------------------------------------------------

	private async _pollForChanges(): Promise<void> {
		if (this._trackedRepos.size === 0) {
			return; // Nothing to poll - no repos have been accessed yet
		}

		try {
			// Poll each tracked repo and merge results
			const allTasks: ICloudTask[] = [];
			for (const key of this._trackedRepos) {
				const [owner, repo] = key.split('/');
				try {
					const result = await this.listRepoTasks(owner, repo, { includeCounts: true });
					allTasks.push(...result.tasks);
				} catch (err) {
					this._logService.trace(`[CloudTaskService] Polling ${key} failed:`, err);
				}
			}

			const newTaskIds = new Set<string>();
			for (const task of allTasks) {
				newTaskIds.add(task.id);
				const cached = this._taskCache.get(task.id);
				if (!cached) {
					this._taskCache.set(task.id, task);
					this._onDidChangeTasks.fire({ type: 'added', taskId: task.id, task });
				} else if (cached.status !== task.status || cached.lastUpdatedAt !== task.lastUpdatedAt) {
					this._taskCache.set(task.id, task);
					this._onDidChangeTasks.fire({ type: 'updated', taskId: task.id, task });
				}
			}

			// Detect removed tasks
			for (const [id] of this._taskCache) {
				if (!newTaskIds.has(id)) {
					this._taskCache.delete(id);
					this._onDidChangeTasks.fire({ type: 'removed', taskId: id });
				}
			}
		} catch (err) {
			this._logService.warn('[CloudTaskService] Polling failed:', err);
		}
	}
}
