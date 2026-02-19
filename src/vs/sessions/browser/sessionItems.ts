/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared types and utilities for the unified session list.
 *
 * Both SDK sessions (`ICopilotSessionMetadata`) and cloud tasks (`ICloudTask`)
 * are adapted into `ISessionItem` for consistent list rendering and selection.
 */

import { Codicon } from '../../base/common/codicons.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { localize } from '../../nls.js';
import type { ICopilotSessionMetadata } from '../../platform/copilotSdk/common/copilotSdkService.js';
import type { CloudTaskStatus, ICloudTask } from '../../platform/cloudTask/common/cloudTaskService.js';

// #region Session Item

export type SessionItemKind = 'sdk-session' | 'cloud-task';

/**
 * A unified item type used for list rendering. Both SDK sessions and
 * cloud tasks are adapted into this shape so the list renderer only
 * needs a single code path.
 */
export interface ISessionItem {
	readonly id: string;
	readonly kind: SessionItemKind;
	readonly label: string;
	readonly secondaryLabel: string;
	readonly time: number;       // epoch ms for sorting
	readonly timeLabel: string;  // pre-formatted relative time string
	readonly icon: ThemeIcon;
	readonly statusBadge?: string;
	readonly isArchived?: boolean;
	/** The original data object for action dispatch. */
	readonly data: ICopilotSessionMetadata | ICloudTask;
}

// #endregion

// #region Relative Time

/**
 * Format a date as a human-readable relative time string.
 */
export function formatRelativeTime(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	if (diffMs <= 0) { return localize('justNow', "just now"); }
	const diffMins = Math.floor(diffMs / 60000);
	if (diffMins < 1) { return localize('justNow', "just now"); }
	if (diffMins < 60) { return localize('minutesAgo', "{0}m ago", diffMins); }
	const diffHours = Math.floor(diffMins / 60);
	if (diffHours < 24) { return localize('hoursAgo', "{0}h ago", diffHours); }
	const diffDays = Math.floor(diffHours / 24);
	if (diffDays < 7) { return localize('daysAgo', "{0}d ago", diffDays); }
	return date.toLocaleDateString();
}

// #endregion

// #region Cloud Task Status Utilities

/**
 * Map a cloud task status string to a ThemeIcon.
 */
export function cloudTaskStatusIcon(status: CloudTaskStatus | string): ThemeIcon {
	switch (status) {
		case 'completed': return Codicon.check;
		case 'failed': return Codicon.error;
		case 'in_progress': return Codicon.loading;
		case 'queued': return Codicon.clock;
		case 'cancelled': return Codicon.close;
		case 'timed_out': return Codicon.warning;
		case 'waiting_for_user': return Codicon.bell;
		case 'idle': return Codicon.circle;
		default: return Codicon.cloud;
	}
}

/**
 * Map a cloud task status string to a human-readable label.
 */
export function cloudTaskStatusLabel(status: CloudTaskStatus | string): string {
	switch (status) {
		case 'queued': return localize('taskStatus.queued', "Queued");
		case 'in_progress': return localize('taskStatus.inProgress', "In Progress");
		case 'completed': return localize('taskStatus.completed', "Completed");
		case 'failed': return localize('taskStatus.failed', "Failed");
		case 'idle': return localize('taskStatus.idle', "Idle");
		case 'waiting_for_user': return localize('taskStatus.waiting', "Waiting");
		case 'timed_out': return localize('taskStatus.timedOut', "Timed Out");
		case 'cancelled': return localize('taskStatus.cancelled', "Cancelled");
		default: return status;
	}
}

// #endregion

// #region Adapter Functions

/**
 * Adapt an SDK session metadata object into a unified `ISessionItem`.
 */
export function sdkSessionToItem(session: ICopilotSessionMetadata): ISessionItem {
	const timeStr = session.modifiedTime ?? session.startTime;
	const date = timeStr ? new Date(timeStr) : new Date(0);
	return {
		id: session.sessionId,
		kind: 'sdk-session',
		label: session.summary || localize('untitledSession', "Untitled Session"),
		secondaryLabel: session.repository
			? (session.branch ? `${session.repository} (${session.branch})` : session.repository)
			: session.workspacePath ?? '',
		time: date.getTime(),
		timeLabel: timeStr ? formatRelativeTime(date) : '',
		icon: Codicon.commentDiscussion,
		data: session,
	};
}

/**
 * Adapt a cloud task object into a unified `ISessionItem`.
 */
export function cloudTaskToItem(task: ICloudTask): ISessionItem {
	const date = new Date(task.lastUpdatedAt);
	return {
		id: task.id,
		kind: 'cloud-task',
		label: task.name || localize('untitledTask', "Untitled Task"),
		secondaryLabel: task.ownerName && task.repoName
			? `${task.ownerName}/${task.repoName}` : '',
		time: date.getTime(),
		timeLabel: formatRelativeTime(date),
		icon: cloudTaskStatusIcon(task.status),
		statusBadge: cloudTaskStatusLabel(task.status),
		isArchived: !!task.archivedAt,
		data: task,
	};
}

// #endregion
