/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { IObservable, ISettableObservable, observableFromEventOpts, observableValue } from '../../../../base/common/observable.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { BackgroundTaskSource, BackgroundTaskStatus, IChatBackgroundTask, IChatBackgroundTaskHandle, IChatBackgroundTaskService } from '../common/chatBackgroundTask.js';
import { IChatService } from '../common/chatService/chatService.js';

class ChatBackgroundTask extends Disposable implements IChatBackgroundTaskHandle {
	private readonly _status: ISettableObservable<BackgroundTaskStatus>;
	private readonly _statusMessage: ISettableObservable<string | undefined>;
	private readonly _result: ISettableObservable<unknown | undefined>;

	get status(): IObservable<BackgroundTaskStatus> { return this._status; }
	get statusMessage(): IObservable<string | undefined> { return this._statusMessage; }
	get result(): IObservable<unknown | undefined> { return this._result; }

	constructor(
		readonly taskId: string,
		readonly name: string,
		readonly source: BackgroundTaskSource,
		private readonly _cancel: () => void,
	) {
		super();
		this._status = observableValue('bgTaskStatus', BackgroundTaskStatus.Working);
		this._statusMessage = observableValue('bgTaskMessage', undefined);
		this._result = observableValue('bgTaskResult', undefined);
	}

	cancel(): void {
		if (this._status.get() !== BackgroundTaskStatus.Working) {
			return;
		}
		this._status.set(BackgroundTaskStatus.Cancelled, undefined);
		this._cancel();
	}

	complete(result: unknown): void {
		if (this._status.get() !== BackgroundTaskStatus.Working) {
			return;
		}
		this._result.set(result, undefined);
		this._status.set(BackgroundTaskStatus.Completed, undefined);
	}

	fail(message?: string): void {
		if (this._status.get() !== BackgroundTaskStatus.Working) {
			return;
		}
		this._statusMessage.set(message, undefined);
		this._status.set(BackgroundTaskStatus.Failed, undefined);
	}

	updateStatusMessage(message: string): void {
		this._statusMessage.set(message, undefined);
	}
}

export class ChatBackgroundTaskServiceImpl extends Disposable implements IChatBackgroundTaskService {
	declare readonly _serviceBrand: undefined;

	private readonly _tasksBySession = this._register(new DisposableMap<string, DisposableMap<string, ChatBackgroundTask>>());
	private readonly _onDidChangeTasks = this._register(new Emitter<void>());

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IChatService private readonly _chatService: IChatService,
	) {
		super();

		this._register(this._chatService.onDidDisposeSession(e => {
			for (const sessionResource of e.sessionResources) {
				this._tasksBySession.deleteAndDispose(sessionResource.toString());
			}
			this._onDidChangeTasks.fire();
		}));
	}

	createTask(sessionResource: URI, options: {
		name: string;
		source: BackgroundTaskSource;
		onCancel?: () => void;
	}): IChatBackgroundTaskHandle {
		const taskId = generateUuid();
		const task = new ChatBackgroundTask(taskId, options.name, options.source, () => {
			options.onCancel?.();
		});

		this._trackTask(sessionResource, task);
		this._logService.debug(`[ChatBackgroundTaskService] Created task ${taskId} for session ${sessionResource.toString()}`);
		return task;
	}

	getTasksForSession(sessionResource: URI): IObservable<readonly IChatBackgroundTask[]> {
		const key = sessionResource.toString();
		return observableFromEventOpts({ equalsFn: () => false }, this._onDidChangeTasks.event, () => {
			const map = this._tasksBySession.get(key);
			return map ? [...map.values()] : [];
		});
	}

	getTask(taskId: string): IChatBackgroundTask | undefined {
		for (const map of this._tasksBySession.values()) {
			const task = map.get(taskId);
			if (task) {
				return task;
			}
		}
		return undefined;
	}

	evictTask(taskId: string): void {
		for (const [sessionKey, map] of this._tasksBySession) {
			if (map.has(taskId)) {
				map.deleteAndDispose(taskId);
				if (map.size === 0) {
					this._tasksBySession.deleteAndDispose(sessionKey);
				}
				this._onDidChangeTasks.fire();
				return;
			}
		}
	}

	private _trackTask(sessionResource: URI, task: ChatBackgroundTask): void {
		const key = sessionResource.toString();
		if (!this._tasksBySession.has(key)) {
			this._tasksBySession.set(key, new DisposableMap());
		}
		this._tasksBySession.get(key)!.set(task.taskId, task);
		this._onDidChangeTasks.fire();
	}
}
