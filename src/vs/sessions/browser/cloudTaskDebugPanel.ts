/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Temporary REST debug UI for the Cloud Task API integration.
 * Shows the event stream and provides helper buttons for common API calls.
 * Delete this entire file to remove the debug panel.
 */

import * as dom from '../../base/browser/dom.js';
import { ICloudTaskService } from '../../platform/cloudTask/common/cloudTaskService.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { CloudTaskDebugLog, ICloudTaskDebugLogEntry } from './cloudTaskDebugLog.js';
import { BaseDebugPanel, IDebugPanelTab } from './baseDebugPanel.js';
import { cloudTaskStatusColor } from '../common/sessionListItemAdapters.js';

const $ = dom.$;

export class CloudTaskDebugPanel extends BaseDebugPanel<ICloudTaskDebugLogEntry, CloudTaskDebugLog> {

	private _ownerInput!: HTMLInputElement;
	private _repoInput!: HTMLInputElement;
	private _taskIdInput!: HTMLInputElement;

	constructor(
		container: HTMLElement,
		debugLog: CloudTaskDebugLog,
		@ICloudTaskService private readonly _taskService: ICloudTaskService,
		@IClipboardService clipboardService: IClipboardService,
	) {
		super(container, debugLog, clipboardService);
		this._setStatus(this._taskService.isAuthenticated ? 'Authenticated' : 'Not authenticated');
	}

	protected override _getTitle(): string { return 'Cloud Task API Debug'; }
	protected override _getInputPlaceholder(): string { return 'Event content / prompt (used by Create Task and Follow-up)...'; }

	protected override _getTabs(): IDebugPanelTab[] {
		return [
			{ id: 'log', label: 'API Log' },
			{ id: 'info', label: 'Task Info', isInfoStyle: true },
		];
	}

	protected override _buildConfigRows(parent: HTMLElement): void {
		this._ownerInput = this._addConfigInput(parent, 'Owner:', 'e.g. microsoft');
		this._repoInput = this._addConfigInput(parent, 'Repo:', 'e.g. vscode');
		this._taskIdInput = this._addConfigInput(parent, 'Task ID:', '(auto-populated on create/get)');
	}

	protected override _getHelperButtons(): Array<{ label: string; fn: () => void }> {
		return [
			// Task listing
			{ label: 'List All Tasks', fn: () => this._api('listTasks') },
			{ label: 'List Repo Tasks', fn: () => this._api('listRepoTasks') },
			// Task CRUD
			{ label: '+ Create Task', fn: () => this._api('createTask') },
			{ label: 'Get Task', fn: () => this._api('getTask') },
			{ label: 'Archive Task', fn: () => this._api('archiveTask') },
			// Sessions
			{ label: '+ Follow-up', fn: () => this._api('createFollowUpSession') },
			// Logs
			{ label: 'Get Logs', fn: () => this._api('getInactiveLogs') },
			// Polling
			{ label: 'Start Polling', fn: () => this._api('startPolling') },
			{ label: 'Stop Polling', fn: () => this._api('stopPolling') },
			// Dump
			{ label: 'Dump Tasks (JSON)', fn: () => this._dumpTasksJson() },
		];
	}

	protected override _onClear(): void {
		dom.clearNode(this._getTabContainer('log'));
		this._debugLog.clear();
	}

	protected override _getClipboardContent(): string {
		return this._formatEntries(this._debugLog.entries);
	}

	protected override _renderEntry(entry: ICloudTaskDebugLogEntry): void {
		this._renderStandardLogEntry(this._getTabContainer('log'), entry);
	}

	private async _api(method: string): Promise<void> {
		const owner = this._ownerInput.value.trim();
		const repo = this._repoInput.value.trim();
		const taskId = this._taskIdInput.value.trim();

		try {
			switch (method) {
				case 'listTasks': {
					this._debugLog.addEntry('\u2192', 'listTasks', '');
					const result = await this._taskService.listTasks({ includeCounts: true });
					this._debugLog.addEntry('\u2190', 'listTasks', `${result.tasks.length} tasks (active: ${result.totalActiveCount ?? '?'}, archived: ${result.totalArchivedCount ?? '?'})`);
					this._setStatus(`Listed ${result.tasks.length} tasks`);
					break;
				}
				case 'listRepoTasks': {
					if (!owner || !repo) { this._debugLog.addEntry('X', 'listRepoTasks', 'Owner and Repo required'); return; }
					this._debugLog.addEntry('\u2192', 'listRepoTasks', `${owner}/${repo}`);
					const result = await this._taskService.listRepoTasks(owner, repo, { includeCounts: true });
					this._debugLog.addEntry('\u2190', 'listRepoTasks', `${result.tasks.length} tasks`);
					this._setStatus(`Listed ${result.tasks.length} tasks for ${owner}/${repo}`);
					break;
				}
				case 'createTask': {
					if (!owner || !repo) { this._debugLog.addEntry('X', 'createTask', 'Owner and Repo required'); return; }
					const content = this._inputArea.value.trim();
					if (!content) { this._debugLog.addEntry('X', 'createTask', 'Enter event content in the text area'); return; }
					this._debugLog.addEntry('\u2192', 'createTask', JSON.stringify({ owner, repo, eventContent: content.substring(0, 100) }));
					this._setStatus('Creating task...');
					const task = await this._taskService.createTask({ owner, repo, eventContent: content });
					this._taskIdInput.value = task.id;
					this._debugLog.addEntry('\u2190', 'createTask', `id=${task.id} status=${task.status}`);
					this._setStatus(`Created task ${task.id.substring(0, 8)}`);
					break;
				}
				case 'getTask': {
					if (!owner || !repo || !taskId) { this._debugLog.addEntry('X', 'getTask', 'Owner, Repo, and Task ID required'); return; }
					this._debugLog.addEntry('\u2192', 'getTask', `${owner}/${repo}/${taskId.substring(0, 8)}`);
					const task = await this._taskService.getTask(owner, repo, taskId);
					this._debugLog.addEntry('\u2190', 'getTask', `status=${task.status} sessions=${task.sessionCount} artifacts=${task.artifacts.length}`);
					this._setStatus(`Task ${taskId.substring(0, 8)}: ${task.status}`);
					break;
				}
				case 'archiveTask': {
					if (!owner || !repo || !taskId) { this._debugLog.addEntry('X', 'archiveTask', 'Owner, Repo, and Task ID required'); return; }
					this._debugLog.addEntry('\u2192', 'archiveTask', taskId.substring(0, 8));
					const task = await this._taskService.archiveTask(owner, repo, taskId);
					this._debugLog.addEntry('\u2190', 'archiveTask', `archived_at=${task.archivedAt}`);
					this._setStatus(`Archived task ${taskId.substring(0, 8)}`);
					break;
				}
				case 'createFollowUpSession': {
					if (!owner || !repo || !taskId) { this._debugLog.addEntry('X', 'createFollowUpSession', 'Owner, Repo, and Task ID required'); return; }
					const followUpContent = this._inputArea.value.trim();
					if (!followUpContent) { this._debugLog.addEntry('X', 'createFollowUpSession', 'Enter event content in the text area'); return; }
					this._debugLog.addEntry('\u2192', 'createFollowUpSession', JSON.stringify({ taskId: taskId.substring(0, 8), content: followUpContent.substring(0, 100) }));
					await this._taskService.createFollowUpSession(owner, repo, taskId, { eventContent: followUpContent });
					this._debugLog.addEntry('\u2190', 'createFollowUpSession', '202 Accepted');
					this._setStatus('Follow-up session queued');
					break;
				}
				case 'getInactiveLogs': {
					if (!owner || !repo || !taskId) { this._debugLog.addEntry('X', 'getInactiveLogs', 'Owner, Repo, and Task ID required'); return; }
					this._debugLog.addEntry('\u2192', 'getInactiveLogs', taskId.substring(0, 8));
					const logs = await this._taskService.getInactiveLogs(owner, repo, taskId);
					const sessionIds = Object.keys(logs);
					const totalBytes = Object.values(logs).reduce((sum, l) => sum + l.length, 0);
					this._debugLog.addEntry('\u2190', 'getInactiveLogs', `${sessionIds.length} sessions, ${totalBytes} bytes`);
					this._setStatus(`Got logs for ${sessionIds.length} sessions`);
					break;
				}
				case 'startPolling': {
					this._debugLog.addEntry('\u2192', 'startPolling', '30s interval');
					this._taskService.startPolling();
					this._debugLog.addEntry('\u2190', 'startPolling', 'OK');
					this._setStatus('Polling started');
					break;
				}
				case 'stopPolling': {
					this._debugLog.addEntry('\u2192', 'stopPolling', '');
					this._taskService.stopPolling();
					this._debugLog.addEntry('\u2190', 'stopPolling', 'OK');
					this._setStatus('Polling stopped');
					break;
				}
			}
		} catch (err) {
			this._debugLog.addEntry('X', method, String(err instanceof Error ? err.message : err));
		}
	}

	private async _dumpTasksJson(): Promise<void> {
		try {
			this._debugLog.addEntry('\u2192', 'dumpTasks', 'Fetching all tasks...');
			const result = await this._taskService.listTasks({ includeCounts: true });
			const json = JSON.stringify(result, null, 2);
			this._debugLog.addEntry('\u2190', 'dumpTasks', `${result.tasks.length} tasks (${json.length} bytes)`);
			await this._clipboardService.writeText(json);
			this._setStatus('Task dump copied to clipboard');
		} catch (err) {
			this._debugLog.addEntry('X', 'dumpTasks', String(err));
		}
	}

	protected override async _refreshInfo(): Promise<void> {
		this._infoDisposables.clear();
		const container = this._getTabContainer('info');
		dom.clearNode(container);

		// Service state
		this._addInfoSection(container, 'SERVICE STATE');
		this._addInfoLine(container, 'Authenticated', this._taskService.isAuthenticated ? 'Yes' : 'No',
			this._taskService.isAuthenticated ? 'var(--vscode-terminal-ansiGreen)' : 'var(--vscode-errorForeground)');
		this._addInfoLine(container, 'Log entries', String(this._debugLog.entries.length));

		// All tasks
		this._addInfoSection(container, 'ALL TASKS');
		try {
			const result = await this._taskService.listTasks({ includeCounts: true });
			this._addInfoLine(container, 'Total tasks', String(result.tasks.length));
			if (result.totalActiveCount !== undefined) { this._addInfoLine(container, 'Active count', String(result.totalActiveCount)); }
			if (result.totalArchivedCount !== undefined) { this._addInfoLine(container, 'Archived count', String(result.totalArchivedCount)); }

			for (const task of result.tasks) {
				const line = dom.append(container, $('div'));
				line.style.cssText = 'margin:4px 0;padding:4px 6px;border-radius:3px;background:var(--vscode-editor-inactiveSelectionBackground);';
				const idEl = dom.append(line, $('div'));
				idEl.style.cssText = 'font-weight:bold;color:var(--vscode-textLink-foreground);';
				idEl.textContent = `Task ${task.id.substring(0, 12)}`;
				this._addInfoLine(container, '  Name', task.name || '(unnamed)');
				this._addInfoLine(container, '  Status', task.status, cloudTaskStatusColor(task.status));
				if (task.ownerName && task.repoName) { this._addInfoLine(container, '  Repo', `${task.ownerName}/${task.repoName}`); }
				this._addInfoLine(container, '  Sessions', String(task.sessionCount));
				this._addInfoLine(container, '  Artifacts', String(task.artifacts.length));
				this._addInfoLine(container, '  Created', new Date(task.createdAt).toLocaleString());
				this._addInfoLine(container, '  Updated', new Date(task.lastUpdatedAt).toLocaleString());
				if (task.archivedAt) { this._addInfoLine(container, '  Archived', new Date(task.archivedAt).toLocaleString()); }
			}
		} catch (err) {
			this._addInfoLine(container, 'Error loading tasks', String(err));
		}

		// Detailed task (if task ID is set)
		const owner = this._ownerInput.value.trim();
		const repo = this._repoInput.value.trim();
		const taskId = this._taskIdInput.value.trim();
		if (owner && repo && taskId) {
			this._addInfoSection(container, `TASK DETAIL: ${taskId.substring(0, 12)}`);
			try {
				const task = await this._taskService.getTask(owner, repo, taskId);
				this._addInfoLine(container, 'Full ID', task.id);
				this._addInfoLine(container, 'Name', task.name || '(unnamed)');
				this._addInfoLine(container, 'Status', task.status, cloudTaskStatusColor(task.status));
				this._addInfoLine(container, 'Creator ID', String(task.creatorId));
				this._addInfoLine(container, 'Owner ID', String(task.ownerId));
				this._addInfoLine(container, 'Repo ID', String(task.repoId));
				this._addInfoLine(container, 'Session count', String(task.sessionCount));

				if (task.artifacts.length > 0) {
					this._addInfoLine(container, 'Artifacts', '');
					for (const a of task.artifacts) {
						this._addInfoLine(container, `  ${a.type}`, JSON.stringify(a.data));
					}
				}

				if (task.agentCollaborators.length > 0) {
					this._addInfoLine(container, 'Collaborators', '');
					for (const c of task.agentCollaborators) {
						this._addInfoLine(container, `  ${c.agentType}`, `id=${c.agentId} taskId=${c.agentTaskId}`);
					}
				}

				if (task.sessions && task.sessions.length > 0) {
					this._addInfoLine(container, 'Sessions', '');
					for (const s of task.sessions) {
						this._addInfoLine(container, `  ${s.id.substring(0, 8)}`, `${s.name || '(unnamed)'} [${s.state}] created ${new Date(s.createdAt).toLocaleString()}`);
					}
				}

				// Logs
				try {
					const logs = await this._taskService.getInactiveLogs(owner, repo, taskId);
					const logEntries = Object.entries(logs);
					if (logEntries.length > 0) {
						this._addInfoLine(container, 'Inactive logs', `${logEntries.length} sessions`);
						for (const [sid, content] of logEntries) {
							this._addInfoLine(container, `  Session ${sid.substring(0, 8)}`, `${content.length} bytes`);
						}
					} else {
						this._addInfoLine(container, 'Inactive logs', '(none)');
					}
				} catch {
					this._addInfoLine(container, 'Inactive logs', '(failed to load)');
				}
			} catch (err) {
				this._addInfoLine(container, 'Error loading task detail', String(err));
			}
		}

		// Event stats
		this._addInfoSection(container, 'EVENT STATISTICS (from debug log)');
		const methodCounts: Record<string, number> = {};
		for (const entry of this._debugLog.entries) {
			methodCounts[entry.method] = (methodCounts[entry.method] ?? 0) + 1;
		}
		if (Object.keys(methodCounts).length > 0) {
			for (const [method, count] of Object.entries(methodCounts).sort((a, b) => b[1] - a[1])) {
				this._addInfoLine(container, `  ${method}`, String(count));
			}
		} else {
			this._addInfoLine(container, '  (no events yet)', '');
		}

		// Footer buttons
		this._addInfoFooterButtons(container, this._infoDisposables, () => this._refreshInfo());
	}
}
