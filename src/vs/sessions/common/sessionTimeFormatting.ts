/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../nls.js';

/**
 * Format a Date as a relative time string (e.g. "5m ago", "2h ago").
 * Falls back to locale date string for dates older than 7 days.
 */
export function formatRelativeTime(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	if (diffMs <= 0) {
		return localize('justNow', "just now");
	}
	const diffMins = Math.floor(diffMs / 60000);
	if (diffMins < 1) {
		return localize('justNow', "just now");
	}
	if (diffMins < 60) {
		return localize('minutesAgo', "{0}m ago", diffMins);
	}
	const diffHours = Math.floor(diffMins / 60);
	if (diffHours < 24) {
		return localize('hoursAgo', "{0}h ago", diffHours);
	}
	const diffDays = Math.floor(diffHours / 24);
	if (diffDays < 7) {
		return localize('daysAgo', "{0}d ago", diffDays);
	}
	return date.toLocaleDateString();
}
