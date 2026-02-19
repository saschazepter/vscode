/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Always-on debug log for the Cloud Task API. Subscribes to task change events
 * at startup and buffers them so the debug panel can show the full history
 * regardless of when it is opened.
 *
 * Registered as a workbench contribution in `chat.contribution.ts`.
 */

import { ICloudTaskService } from '../../platform/cloudTask/common/cloudTaskService.js';
import { BaseDebugLog, IBaseDebugLogEntry } from './debugLog.js';

export interface ICloudTaskDebugLogEntry extends IBaseDebugLogEntry {
	// No additional fields - all shared fields come from IBaseDebugLogEntry
}

export class CloudTaskDebugLog extends BaseDebugLog<ICloudTaskDebugLogEntry> {

	private static _instance: CloudTaskDebugLog | undefined;
	static get instance(): CloudTaskDebugLog | undefined { return CloudTaskDebugLog._instance; }

	constructor(
		@ICloudTaskService private readonly _taskService: ICloudTaskService,
	) {
		super();
		CloudTaskDebugLog._instance = this;
		this._register({ dispose: () => { if (CloudTaskDebugLog._instance === this) { CloudTaskDebugLog._instance = undefined; } } });
		this._subscribe();
	}

	/**
	 * Add a log entry programmatically (used by the debug panel for manual API calls).
	 */
	addEntry(direction: string, method: string, detail: string, tag?: string): void {
		this.createEntry({ direction, method, detail, tag });
	}

	private _subscribe(): void {
		this._register(this._taskService.onDidChangeTasks(event => {
			const detail = event.task
				? `${event.task.name || event.task.id.substring(0, 8)} [${event.task.status}]`
				: event.taskId.substring(0, 8);
			this.addEntry('!', `task:${event.type}`, detail, event.taskId.substring(0, 8));
		}));

		this._register(this._taskService.onDidChangeAuthentication(isAuth => {
			this.addEntry('!', 'auth:changed', isAuth ? 'authenticated' : 'unauthenticated');
		}));
	}
}
