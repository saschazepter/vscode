/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../base/common/codicons.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { localize } from '../../nls.js';
import type { ICopilotSessionMetadata } from '../../platform/copilotSdk/common/copilotSdkService.js';
import type { ICloudTask } from '../../platform/cloudTask/common/cloudTaskService.js';
import { type ISessionListItem, SessionListItemKind } from './sessionListItem.js';

/**
 * Adapt an SDK session metadata object into an {@link ISessionListItem}.
 * The `action` field is left unset - the consumer attaches it since it needs service access.
 */
export function sdkSessionToListItem(session: ICopilotSessionMetadata): ISessionListItem {
	const timeStr = session.modifiedTime ?? session.startTime;
	const timestamp = timeStr ? new Date(timeStr).getTime() : 0;

	let description = '';
	if (session.repository) {
		description = session.branch
			? `${session.repository} (${session.branch})`
			: session.repository;
	} else if (session.workspacePath) {
		description = session.workspacePath;
	}

	return {
		id: session.sessionId,
		kind: SessionListItemKind.SdkSession,
		label: session.summary || localize('untitledSession', "Untitled Session"),
		description,
		status: {
			icon: Codicon.commentDiscussion,
		},
		timestamp,
		loadData: {
			kind: SessionListItemKind.SdkSession,
			sessionId: session.sessionId,
		},
	};
}

/**
 * Adapt a cloud task object into an {@link ISessionListItem}.
 * The `action` field is left unset - the consumer attaches it since it needs service access.
 */
export function cloudTaskToListItem(task: ICloudTask): ISessionListItem {
	const timestamp = new Date(task.lastUpdatedAt).getTime();

	return {
		id: task.id,
		kind: SessionListItemKind.CloudTask,
		label: task.name || localize('untitledTask', "Untitled Task"),
		description: task.ownerName && task.repoName
			? `${task.ownerName}/${task.repoName}`
			: '',
		status: {
			icon: cloudTaskStatusIcon(task.status),
			label: cloudTaskStatusLabel(task.status),
		},
		timestamp,
		loadData: {
			kind: SessionListItemKind.CloudTask,
			owner: task.ownerName,
			repo: task.repoName,
			taskId: task.id,
		},
	};
}

/**
 * Map a cloud task status to a {@link ThemeIcon}.
 */
export function cloudTaskStatusIcon(status: string): ThemeIcon {
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
 * Map a cloud task status to a VS Code theme color variable.
 */
export function cloudTaskStatusColor(status: string): string {
	switch (status) {
		case 'completed': return 'var(--vscode-terminal-ansiGreen)';
		case 'failed':
		case 'timed_out':
		case 'cancelled': return 'var(--vscode-errorForeground)';
		case 'in_progress':
		case 'queued': return 'var(--vscode-terminal-ansiYellow)';
		default: return 'var(--vscode-foreground)';
	}
}

/**
 * Map a cloud task status to a human-readable label.
 */
export function cloudTaskStatusLabel(status: string): string {
	switch (status) {
		case 'queued': return localize('taskStatus.queued', "Queued");
		case 'in_progress': return localize('taskStatus.inProgress', "Running");
		case 'completed': return localize('taskStatus.completed', "Done");
		case 'failed': return localize('taskStatus.failed', "Failed");
		case 'idle': return localize('taskStatus.idle', "Idle");
		case 'waiting_for_user': return localize('taskStatus.waiting', "Waiting");
		case 'timed_out': return localize('taskStatus.timedOut', "Timed Out");
		case 'cancelled': return localize('taskStatus.cancelled', "Cancelled");
		default: return status;
	}
}
