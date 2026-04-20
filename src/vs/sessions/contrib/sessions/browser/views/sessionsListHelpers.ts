/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon, themeColorFromId } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ISession, SessionStatus } from '../../../../services/sessions/common/session.js';

export enum SessionsGrouping {
	Workspace = 'workspace',
	Date = 'date',
}

export enum SessionsSorting {
	Created = 'created',
	Updated = 'updated',
}

export interface ISessionSection {
	readonly id: string;
	readonly label: string;
	readonly sessions: ISession[];
}

export function getSessionStatusIcon(status: SessionStatus, isRead: boolean, isArchived: boolean, motionReduced: boolean, pullRequestIcon?: ThemeIcon): ThemeIcon {
	switch (status) {
		case SessionStatus.InProgress: {
			const loadingIcon = motionReduced ? Codicon.loading : ThemeIcon.modify(Codicon.loading, 'spin');
			return { ...loadingIcon, color: themeColorFromId('textLink.foreground') };
		}
		case SessionStatus.NeedsInput: return { ...Codicon.circleFilled, color: themeColorFromId('list.warningForeground') };
		case SessionStatus.Error: return { ...Codicon.error, color: themeColorFromId('errorForeground') };
		default:
			if (pullRequestIcon) {
				return pullRequestIcon;
			}

			if (!isRead && !isArchived) {
				return { ...Codicon.circleFilled, color: themeColorFromId('textLink.foreground') };
			}
			return { ...Codicon.circleSmallFilled, color: themeColorFromId('agentSessionReadIndicator.foreground') };
	}
}

export function sortSessions(sessions: ISession[], sorting: SessionsSorting): ISession[] {
	return [...sessions].sort((a, b) => {
		if (sorting === SessionsSorting.Updated) {
			return b.updatedAt.get().getTime() - a.updatedAt.get().getTime();
		}
		return b.createdAt.getTime() - a.createdAt.getTime();
	});
}

export function groupSessionsForList(
	sessions: ISession[],
	grouping: SessionsGrouping,
	sorting: SessionsSorting,
	isSessionPinned: (session: ISession) => boolean,
): ISessionSection[] {
	const sorted = sortSessions(sessions, sorting);

	// Archived always wins over pinned so done sessions stay grouped together.
	const pinned: ISession[] = [];
	const archived: ISession[] = [];
	const regular: ISession[] = [];
	for (const session of sorted) {
		if (session.isArchived.get()) {
			archived.push(session);
		} else if (isSessionPinned(session)) {
			pinned.push(session);
		} else {
			regular.push(session);
		}
	}

	const sections: ISessionSection[] = [];
	if (pinned.length > 0) {
		sections.push({ id: 'pinned', label: localize('pinned', "Pinned"), sessions: pinned });
	}

	sections.push(...(grouping === SessionsGrouping.Workspace
		? groupByWorkspace(regular)
		: groupByDate(regular, sorting)));

	if (archived.length > 0) {
		sections.push({ id: 'archived', label: localize('archived', "Done"), sessions: archived });
	}

	return sections;
}

export function groupByWorkspace(sessions: ISession[]): ISessionSection[] {
	const groups = new Map<string, ISession[]>();
	for (const session of sessions) {
		const workspace = session.workspace.get();
		const label = workspace?.label || localize('unknown', "Unknown");
		let group = groups.get(label);
		if (!group) {
			group = [];
			groups.set(label, group);
		}
		group.push(session);
	}

	const unknownWorkspaceLabel = localize('unknown', "Unknown");
	const order = [...groups.keys()]
		.filter(k => k !== unknownWorkspaceLabel)
		.sort((a, b) => a.localeCompare(b));

	const result: ISessionSection[] = order.map(label => ({
		id: `workspace:${label}`,
		label,
		sessions: groups.get(label)!,
	}));

	// "Unknown Workspace" always at the bottom
	const unknownWorkspace = groups.get(unknownWorkspaceLabel);
	if (unknownWorkspace) {
		result.push({ id: `workspace:${unknownWorkspaceLabel}`, label: unknownWorkspaceLabel, sessions: unknownWorkspace });
	}

	return result;
}

export function groupByDate(sessions: ISession[], sorting: SessionsSorting): ISessionSection[] {
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const startOfYesterday = startOfToday - 86_400_000;
	const startOfWeek = startOfToday - 7 * 86_400_000;

	const today: ISession[] = [];
	const yesterday: ISession[] = [];
	const week: ISession[] = [];
	const older: ISession[] = [];

	for (const session of sessions) {
		const time = sorting === SessionsSorting.Updated
			? session.updatedAt.get().getTime()
			: session.createdAt.getTime();

		if (time >= startOfToday) {
			today.push(session);
		} else if (time >= startOfYesterday) {
			yesterday.push(session);
		} else if (time >= startOfWeek) {
			week.push(session);
		} else {
			older.push(session);
		}
	}

	const sections: ISessionSection[] = [];
	const addGroup = (id: string, label: string, groupSessions: ISession[]) => {
		if (groupSessions.length > 0) {
			sections.push({ id, label, sessions: groupSessions });
		}
	};

	addGroup('today', localize('today', "Today"), today);
	addGroup('yesterday', localize('yesterday', "Yesterday"), yesterday);
	addGroup('thisWeek', localize('lastSevenDays', "Last 7 Days"), week);
	addGroup('older', localize('older', "Older"), older);

	return sections;
}
