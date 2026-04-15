/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IChatBackgroundTaskService = createDecorator<IChatBackgroundTaskService>('chatBackgroundTaskService');

export const enum BackgroundTaskStatus {
	Working = 'working',
	Completed = 'completed',
	Failed = 'failed',
	Cancelled = 'cancelled',
}

export type BackgroundTaskSource =
	| { readonly kind: 'terminal'; readonly termId: string; readonly commandName: string }
	| { readonly kind: 'mcp'; readonly serverId: string; readonly serverLabel: string; readonly toolCallId: string };

export interface IChatBackgroundTask {
	readonly taskId: string;
	readonly name: string;
	readonly source: BackgroundTaskSource;
	readonly status: IObservable<BackgroundTaskStatus>;
	readonly statusMessage: IObservable<string | undefined>;
	readonly result: IObservable<unknown | undefined>;
	cancel(): void;
}

export interface IChatBackgroundTaskHandle extends IChatBackgroundTask {
	complete(result: unknown): void;
	fail(message?: string): void;
	updateStatusMessage(message: string): void;
}

export interface IChatBackgroundTaskService {
	readonly _serviceBrand: undefined;

	/**
	 * Create and track a background task.
	 * Returns a handle that can be used to update the task status imperatively.
	 */
	createTask(sessionResource: URI, options: {
		name: string;
		source: BackgroundTaskSource;
		onCancel?: () => void;
	}): IChatBackgroundTaskHandle;

	/**
	 * Get all active background tasks for a session.
	 */
	getTasksForSession(sessionResource: URI): IObservable<readonly IChatBackgroundTask[]>;

	/**
	 * Get a specific background task by its ID across all sessions.
	 */
	getTask(taskId: string): IChatBackgroundTask | undefined;

	/** Remove a task after its result has been consumed by a request. */
	evictTask(taskId: string): void;
}
