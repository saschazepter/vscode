/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/cloudTaskWidget.css';
import * as dom from '../../../base/browser/dom.js';
import { Codicon } from '../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IOpenerService } from '../../../platform/opener/common/opener.js';
import { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import { URI } from '../../../base/common/uri.js';
import {
	type ICloudTask,
	type ICloudTaskArtifact,
	ICloudTaskService,
	isTerminalTaskStatus,
} from '../../../platform/cloudTask/common/cloudTaskService.js';
import { type ISessionListItem, SessionListItemKind } from '../../common/sessionListItem.js';
import { cloudTaskStatusLabel } from '../../common/sessionListItemAdapters.js';
import { formatRelativeTime } from '../../common/sessionTimeFormatting.js';
import type { ISessionDetailWidget } from './sessionDetailWidget.js';

const $ = dom.$;

const ACTIVE_POLL_INTERVAL_MS = 5_000;

/**
 * Widget that displays a single cloud task's details: status, prompt,
 * artifacts, session logs, and a follow-up input.
 */
export class CloudTaskWidget extends Disposable implements ISessionDetailWidget {

	readonly element: HTMLElement;

	private readonly _header: HTMLElement;
	private readonly _statusBadge: HTMLElement;
	private readonly _nameEl: HTMLElement;
	private readonly _repoEl: HTMLElement;
	private readonly _timeEl: HTMLElement;

	private readonly _content: HTMLElement;
	private readonly _promptSection: HTMLElement;
	private readonly _artifactsSection: HTMLElement;
	private readonly _sessionsSection: HTMLElement;
	private readonly _logsSection: HTMLElement;
	private readonly _pollingIndicator: HTMLElement;
	private readonly _actionsSection: HTMLElement;

	private readonly _followupInput: HTMLTextAreaElement;
	private readonly _followupSend: HTMLButtonElement;

	private readonly _emptyState: HTMLElement;

	private readonly _debugLinkLabel: HTMLElement;
	private _currentLogs: Record<string, string> | undefined;

	private _currentTask: ICloudTask | undefined;
	private _currentOwner = '';
	private _currentRepo = '';
	private _currentTaskId = '';

	private _activePollTimer: ReturnType<typeof setInterval> | undefined;
	private readonly _renderDisposables = this._register(new DisposableStore());

	constructor(
		container: HTMLElement,
		@ICloudTaskService private readonly _taskService: ICloudTaskService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this.element = dom.append(container, $('.cloud-task-widget'));

		// --- Empty state (shown when no task is loaded) ---
		this._emptyState = dom.append(this.element, $('.cloud-task-empty'));
		dom.append(this._emptyState, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.cloud));
		dom.append(this._emptyState, $('span')).textContent = localize('cloudTask.empty', "Select a cloud task to view details");

		// --- Header ---
		this._header = dom.append(this.element, $('.cloud-task-header'));
		this._header.style.display = 'none';
		this._statusBadge = dom.append(this._header, $('.cloud-task-status-badge'));
		const headerInfo = dom.append(this._header, $('.cloud-task-header-info'));
		this._nameEl = dom.append(headerInfo, $('.cloud-task-name'));
		this._repoEl = dom.append(headerInfo, $('.cloud-task-repo'));
		this._timeEl = dom.append(this._header, $('.cloud-task-time'));

		// Copy Debug link
		const debugLink = dom.append(this._header, $('a.cloud-task-debug-link'));
		dom.append(debugLink, $(`span${ThemeIcon.asCSSSelector(Codicon.clippy)}`)).classList.add('codicon');
		this._debugLinkLabel = dom.append(debugLink, $('span'));
		this._debugLinkLabel.textContent = localize('cloudTask.copyDebug', "Copy Debug");
		this._register(dom.addDisposableListener(debugLink, 'click', () => this._copyDebugInfo()));

		// --- Scrollable content ---
		this._content = dom.append(this.element, $('.cloud-task-content'));
		this._content.style.display = 'none';

		// Prompt
		this._promptSection = dom.append(this._content, $('.cloud-task-section'));

		// Artifacts
		this._artifactsSection = dom.append(this._content, $('.cloud-task-section'));

		// Sessions
		this._sessionsSection = dom.append(this._content, $('.cloud-task-section'));

		// Logs
		this._logsSection = dom.append(this._content, $('.cloud-task-section'));

		// Polling indicator
		this._pollingIndicator = dom.append(this._content, $('.cloud-task-polling'));
		this._pollingIndicator.style.display = 'none';

		// Actions
		this._actionsSection = dom.append(this._content, $('.cloud-task-section'));

		// --- Follow-up input ---
		const followup = dom.append(this.element, $('.cloud-task-followup'));
		followup.style.display = 'none';
		this._followupInput = dom.append(followup, $('textarea.cloud-task-followup-input')) as HTMLTextAreaElement;
		this._followupInput.placeholder = localize('cloudTask.followupPlaceholder', "Send a follow-up message...");
		this._followupInput.rows = 1;
		this._followupSend = dom.append(followup, $('button.cloud-task-followup-send')) as HTMLButtonElement;
		this._followupSend.textContent = localize('cloudTask.send', "Send");

		this._register(dom.addDisposableListener(this._followupSend, 'click', () => this._sendFollowUp()));
		this._register(dom.addDisposableListener(this._followupInput, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this._sendFollowUp();
			}
		}));
	}

	/**
	 * Load and display a cloud task.
	 */
	async loadTask(owner: string, repo: string, taskId: string): Promise<void> {
		this._stopActivePolling();
		this._currentOwner = owner;
		this._currentRepo = repo;
		this._currentTaskId = taskId;

		try {
			const task = await this._taskService.getTask(owner, repo, taskId);
			this._currentTask = task;
			this._renderTask(task);

			// Start polling if the task is still active
			if (!isTerminalTaskStatus(task.status)) {
				this._startActivePolling();
			}

			// Fetch logs
			this._fetchAndRenderLogs(owner, repo, taskId);
		} catch (err) {
			this._logService.error('[CloudTaskWidget] Failed to load task:', err);
			this._showError(localize('cloudTask.loadError', "Failed to load task"));
		}
	}

	/**
	 * Clear the widget and show the empty state.
	 */
	clear(): void {
		this._stopActivePolling();
		this._currentTask = undefined;
		this._emptyState.style.display = '';
		this._header.style.display = 'none';
		this._content.style.display = 'none';
		(this._followupInput.closest('.cloud-task-followup') as HTMLElement | null)!.style.display = 'none';
	}

	/**
	 * Load a session list item into the widget.
	 * Implements {@link ISessionDetailWidget.load}.
	 */
	async load(item: ISessionListItem): Promise<void> {
		if (item.loadData.kind === SessionListItemKind.CloudTask) {
			await this.loadTask(item.loadData.owner, item.loadData.repo, item.loadData.taskId);
		}
	}

	/**
	 * Focus the follow-up input.
	 */
	focus(): void {
		this._followupInput.focus();
	}

	override dispose(): void {
		this._stopActivePolling();
		super.dispose();
	}

	// -----------------------------------------------------------------------
	// Rendering
	// -----------------------------------------------------------------------

	private _renderTask(task: ICloudTask): void {
		this._renderDisposables.clear();

		// Show header + content, hide empty state
		this._emptyState.style.display = 'none';
		this._header.style.display = '';
		this._content.style.display = '';
		(this._followupInput.closest('.cloud-task-followup') as HTMLElement | null)!.style.display = '';

		// Header
		this._statusBadge.textContent = cloudTaskStatusLabel(task.status);
		this._statusBadge.className = `cloud-task-status-badge status-${task.status}`;
		this._nameEl.textContent = task.name || localize('cloudTask.untitled', "Untitled Task");
		this._repoEl.textContent = task.ownerName && task.repoName
			? `${task.ownerName}/${task.repoName}`
			: '';
		this._timeEl.textContent = formatRelativeTime(new Date(task.lastUpdatedAt));

		// Prompt
		dom.clearNode(this._promptSection);
		const promptLabel = dom.append(this._promptSection, $('.cloud-task-section-label'));
		promptLabel.textContent = localize('cloudTask.prompt', "Prompt");
		const promptBody = dom.append(this._promptSection, $('.cloud-task-prompt'));
		promptBody.textContent = task.name || localize('cloudTask.noPrompt', "No prompt available");

		// Artifacts
		dom.clearNode(this._artifactsSection);
		if (task.artifacts.length > 0) {
			const artLabel = dom.append(this._artifactsSection, $('.cloud-task-section-label'));
			artLabel.textContent = localize('cloudTask.artifacts', "Artifacts");
			for (const artifact of task.artifacts) {
				this._renderArtifact(this._artifactsSection, artifact);
			}
		}

		// Sessions
		dom.clearNode(this._sessionsSection);
		if (task.sessions && task.sessions.length > 0) {
			const sessLabel = dom.append(this._sessionsSection, $('.cloud-task-section-label'));
			sessLabel.textContent = localize('cloudTask.sessions', "Sessions ({0})", task.sessions.length);
			for (const session of task.sessions) {
				const item = dom.append(this._sessionsSection, $('.cloud-task-session-item'));
				const statusDot = dom.append(item, $('.cloud-task-session-status'));
				statusDot.classList.add(`status-${session.state}`);
				dom.append(item, $('span')).textContent = session.name || session.id.substring(0, 8);
				const time = dom.append(item, $('span'));
				time.style.color = 'var(--vscode-descriptionForeground)';
				time.style.fontSize = '11px';
				time.style.marginLeft = 'auto';
				time.textContent = formatRelativeTime(new Date(session.createdAt));
			}
		}

		// Polling indicator
		if (!isTerminalTaskStatus(task.status)) {
			this._pollingIndicator.style.display = '';
			dom.clearNode(this._pollingIndicator);
			dom.append(this._pollingIndicator, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.loading));
			dom.append(this._pollingIndicator, $('span')).textContent = localize('cloudTask.polling', "Task is {0}. Updating...", cloudTaskStatusLabel(task.status));
		} else {
			this._pollingIndicator.style.display = 'none';
		}

		// Actions
		dom.clearNode(this._actionsSection);
		if (!task.archivedAt) {
			const actions = dom.append(this._actionsSection, $('.cloud-task-actions'));
			const archiveBtn = dom.append(actions, $('button.cloud-task-action-btn')) as HTMLButtonElement;
			archiveBtn.textContent = localize('cloudTask.archive', "Archive Task");
			this._renderDisposables.add(dom.addDisposableListener(archiveBtn, 'click', () => this._archiveTask()));
		}
	}

	private _renderArtifact(container: HTMLElement, artifact: ICloudTaskArtifact): void {
		const el = dom.append(container, $('a.cloud-task-artifact'));
		if (artifact.type === 'github_resource' && artifact.data.type === 'pull') {
			dom.append(el, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.gitPullRequest));
			dom.append(el, $('span')).textContent = localize('cloudTask.pullRequest', "Pull Request #{0}", artifact.data.id);
			this._renderDisposables.add(dom.addDisposableListener(el, 'click', () => {
				this._openerService.open(URI.parse(`https://github.com/${this._currentOwner}/${this._currentRepo}/pull/${artifact.data.id}`));
			}));
		} else if (artifact.type === 'branch') {
			dom.append(el, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.gitBranch));
			const headRef = artifact.data.headRef.replace(/^refs\/heads\//, '');
			dom.append(el, $('span')).textContent = headRef;
		}
	}

	private async _fetchAndRenderLogs(owner: string, repo: string, taskId: string): Promise<void> {
		dom.clearNode(this._logsSection);
		const logsLabel = dom.append(this._logsSection, $('.cloud-task-section-label'));
		logsLabel.textContent = localize('cloudTask.logs', "Logs");

		try {
			const logs = await this._taskService.getInactiveLogs(owner, repo, taskId);
			this._currentLogs = logs;
			const logEntries = Object.entries(logs);
			if (logEntries.length === 0) {
				const empty = dom.append(this._logsSection, $('.cloud-task-logs-empty'));
				empty.textContent = localize('cloudTask.noLogs', "No logs available yet");
				return;
			}

			for (const [sessionId, logContent] of logEntries) {
				const sessionLabel = dom.append(this._logsSection, $('.cloud-task-section-label'));
				sessionLabel.textContent = localize('cloudTask.sessionLog', "Session {0}", sessionId.substring(0, 8));
				sessionLabel.style.marginTop = '8px';
				const logsEl = dom.append(this._logsSection, $('.cloud-task-logs'));
				logsEl.textContent = logContent;
			}
		} catch (err) {
			const empty = dom.append(this._logsSection, $('.cloud-task-logs-empty'));
			empty.textContent = localize('cloudTask.logsError', "Failed to load logs");
			this._logService.warn('[CloudTaskWidget] Failed to fetch logs:', err);
		}
	}

	private async _copyDebugInfo(): Promise<void> {
		const debug: Record<string, unknown> = {
			owner: this._currentOwner,
			repo: this._currentRepo,
			taskId: this._currentTaskId,
			task: this._currentTask,
			logs: this._currentLogs ?? null,
		};
		await this._clipboardService.writeText(JSON.stringify(debug, null, 2));
		const original = this._debugLinkLabel.textContent;
		this._debugLinkLabel.textContent = localize('cloudTask.copied', "Copied!");
		setTimeout(() => { this._debugLinkLabel.textContent = original; }, 1500);
	}

	private _showError(message: string): void {
		this._emptyState.style.display = '';
		this._header.style.display = 'none';
		this._content.style.display = 'none';
		dom.clearNode(this._emptyState);
		dom.append(this._emptyState, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.error));
		dom.append(this._emptyState, $('span')).textContent = message;
	}

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	private async _sendFollowUp(): Promise<void> {
		const text = this._followupInput.value.trim();
		if (!text || !this._currentTask) {
			return;
		}

		this._followupSend.disabled = true;
		try {
			await this._taskService.createFollowUpSession(
				this._currentOwner, this._currentRepo, this._currentTaskId,
				{ eventContent: text },
			);
			this._followupInput.value = '';
			// Refresh the task to show the new session
			this.loadTask(this._currentOwner, this._currentRepo, this._currentTaskId);
		} catch (err) {
			this._logService.error('[CloudTaskWidget] Failed to create follow-up session:', err);
		} finally {
			this._followupSend.disabled = false;
		}
	}

	private async _archiveTask(): Promise<void> {
		if (!this._currentTask) {
			return;
		}
		try {
			await this._taskService.archiveTask(this._currentOwner, this._currentRepo, this._currentTaskId);
			this.loadTask(this._currentOwner, this._currentRepo, this._currentTaskId);
		} catch (err) {
			this._logService.error('[CloudTaskWidget] Failed to archive task:', err);
		}
	}

	// -----------------------------------------------------------------------
	// Polling
	// -----------------------------------------------------------------------

	private _startActivePolling(): void {
		this._stopActivePolling();
		this._activePollTimer = globalThis.setInterval(async () => {
			try {
				const task = await this._taskService.getTask(this._currentOwner, this._currentRepo, this._currentTaskId);
				this._currentTask = task;
				this._renderTask(task);

				if (isTerminalTaskStatus(task.status)) {
					this._stopActivePolling();
					this._fetchAndRenderLogs(this._currentOwner, this._currentRepo, this._currentTaskId);
				}
			} catch (err) {
				this._logService.warn('[CloudTaskWidget] Polling failed:', err);
			}
		}, ACTIVE_POLL_INTERVAL_MS);
	}

	private _stopActivePolling(): void {
		if (this._activePollTimer !== undefined) {
			globalThis.clearInterval(this._activePollTimer);
			this._activePollTimer = undefined;
		}
	}

}
