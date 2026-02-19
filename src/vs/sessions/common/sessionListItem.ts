/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ThemeIcon } from '../../base/common/themables.js';

/**
 * Discriminant for the type of provider backing a session list item.
 */
export const enum SessionListItemKind {
	SdkSession = 'sdk',
	CloudTask = 'cloud',
}

/**
 * Status display information for a session list item.
 */
export interface ISessionListItemStatus {
	/** Icon to show beside the item (e.g. loading spinner, checkmark). */
	readonly icon: ThemeIcon;
	/** Short human-readable label (e.g. "Running", "Done"). Undefined for SDK sessions. */
	readonly label?: string;
}

/**
 * Action descriptor for the secondary action button on a list item
 * (e.g. delete for SDK sessions, archive for cloud tasks).
 */
export interface ISessionListItemAction {
	readonly icon: ThemeIcon;
	readonly tooltip: string;
	readonly execute: () => Promise<void>;
}

/**
 * Unified interface for items in the sessions sidebar list.
 * Both SDK sessions and cloud tasks are adapted into this shape.
 */
export interface ISessionListItem {
	/** Unique identifier (sessionId for SDK, task id for cloud). */
	readonly id: string;

	/** Discriminant for dispatching to the correct detail widget. */
	readonly kind: SessionListItemKind;

	/** Primary display label (summary for SDK sessions, name for cloud tasks). */
	readonly label: string;

	/** Secondary description (repo/branch or owner/repo). */
	readonly description: string;

	/** Status icon and optional label. */
	readonly status: ISessionListItemStatus;

	/** Timestamp used for sorting and display (epoch ms). */
	readonly timestamp: number;

	/**
	 * Opaque data needed by the detail widget to load this item.
	 */
	readonly loadData: ISessionListItemSdkData | ISessionListItemCloudData;

	/** Optional secondary action (delete, archive). */
	readonly action?: ISessionListItemAction;
}

export interface ISessionListItemSdkData {
	readonly kind: SessionListItemKind.SdkSession;
	readonly sessionId: string;
}

export interface ISessionListItemCloudData {
	readonly kind: SessionListItemKind.CloudTask;
	readonly owner: string;
	readonly repo: string;
	readonly taskId: string;
}
