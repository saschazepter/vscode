/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { IObservable, ISettableObservable, observableFromEventOpts, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { McpServer } from '../../mcp/common/mcpServer.js';
import { McpTask } from '../../mcp/common/mcpTask.js';
import { BackgroundTaskStatus, IChatBackgroundTask, McpConnectionState, McpDefinitionReference, IMcpService, ISerializedBackgroundTask, IMcpServer } from '../../mcp/common/mcpTypes.js';
import { MCP } from '../../mcp/common/modelContextProtocol.js';
import { isBackgroundTaskVariableEntry } from '../common/attachments/chatVariableEntries.js';
import { IChatService } from '../common/chatService/chatService.js';

export const IChatBackgroundTaskService = createDecorator<IChatBackgroundTaskService>('chatBackgroundTaskService');

export interface IChatBackgroundTaskService {
	readonly _serviceBrand: undefined;

	/**
	 * Create and track a background task from a live tool-result promise.
	 */
	createBackgroundTask(
		sessionResource: URI,
		taskId: string,
		toolName: string,
		toolCallId: string,
		server: McpDefinitionReference,
		resultPromise: Promise<unknown>,
	): IChatBackgroundTask;

	/**
	 * Restore a previously-serialized background task by reconnecting to the MCP
	 * server and resuming polling via {@link McpTask}.
	 */
	restoreBackgroundTask(
		sessionResource: URI,
		serialized: ISerializedBackgroundTask,
	): IChatBackgroundTask | undefined;

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

class ChatBackgroundTask extends Disposable implements IChatBackgroundTask {
	private readonly _status: ISettableObservable<BackgroundTaskStatus>;
	private readonly _statusMessage: ISettableObservable<string | undefined>;
	private readonly _result: ISettableObservable<MCP.CallToolResult | undefined>;

	public get status(): IObservable<BackgroundTaskStatus> { return this._status; }
	public get statusMessage(): IObservable<string | undefined> { return this._statusMessage; }
	public get result(): IObservable<MCP.CallToolResult | undefined> { return this._result; }

	constructor(
		public readonly taskId: string,
		public readonly toolName: string,
		public readonly toolCallId: string,
		public readonly server: McpDefinitionReference,
		private readonly _cancel: () => void,
	) {
		super();
		this._status = observableValue('bgTaskStatus', BackgroundTaskStatus.Working);
		this._statusMessage = observableValue('bgTaskMessage', undefined);
		this._result = observableValue('bgTaskResult', undefined);
	}

	cancel(): void {
		this._status.set(BackgroundTaskStatus.Cancelled, undefined);
		this._cancel();
	}

	complete(callResult: MCP.CallToolResult): void {
		this._result.set(callResult, undefined);
		this._status.set(BackgroundTaskStatus.Completed, undefined);
	}

	fail(message?: string): void {
		this._statusMessage.set(message, undefined);
		this._status.set(BackgroundTaskStatus.Failed, undefined);
	}
}

export class ChatBackgroundTaskServiceImpl extends Disposable implements IChatBackgroundTaskService {
	declare readonly _serviceBrand: undefined;

	private readonly _tasksBySession = this._register(new DisposableMap<string, DisposableMap<string, ChatBackgroundTask>>());
	private readonly _onDidChangeTasks = this._register(new Emitter<void>());

	constructor(
		@IChatService private readonly _chatService: IChatService,
		@IMcpService private readonly _mcpService: IMcpService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		// Restore background tasks when a model is created (e.g. after reload).
		// Pending tasks live in the model's input state, not attached to any request.
		this._register(this._chatService.onDidCreateModel(model => {
			this._restoreTasksForModel(model.sessionResource);
		}));
	}

	createBackgroundTask(
		sessionResource: URI,
		taskId: string,
		toolName: string,
		toolCallId: string,
		server: McpDefinitionReference,
		resultPromise: Promise<unknown>,
	): IChatBackgroundTask {
		const task = new ChatBackgroundTask(taskId, toolName, toolCallId, server, () => {
			// Cancellation is best-effort; the promise may already be settled.
		});

		resultPromise.then(
			result => task.complete(result as MCP.CallToolResult),
			err => task.fail(err?.message),
		);

		this._trackTask(sessionResource, task);
		return task;
	}

	restoreBackgroundTask(
		sessionResource: URI,
		serialized: ISerializedBackgroundTask,
	): IChatBackgroundTask | undefined {
		if (serialized.status !== BackgroundTaskStatus.Working) {
			return undefined;
		}

		const mcpServer = this._findServer(serialized.server.id);
		if (!mcpServer) {
			this._logService.debug(`[ChatBackgroundTaskService] Cannot restore task ${serialized.taskId}: server ${serialized.server.id} not found`);
			return undefined;
		}

		const cts = new CancellationTokenSource();
		const task = new ChatBackgroundTask(
			serialized.taskId,
			serialized.toolName,
			serialized.toolCallId,
			serialized.server,
			() => cts.cancel(),
		);

		// Use an McpTask to drive the polling state machine
		this._reconnectWithMcpTask(mcpServer, task, cts);
		this._trackTask(sessionResource, task);

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
		for (const [, map] of this._tasksBySession) {
			if (map.has(taskId)) {
				map.deleteAndDispose(taskId);
				this._onDidChangeTasks.fire();
				return;
			}
		}
	}

	// --- private helpers ---

	private _trackTask(sessionResource: URI, task: ChatBackgroundTask): void {
		const key = sessionResource.toString();
		if (!this._tasksBySession.has(key)) {
			this._tasksBySession.set(key, new DisposableMap());
		}
		this._tasksBySession.get(key)!.set(task.taskId, task);
		this._onDidChangeTasks.fire();
	}

	private _findServer(serverId: string) {
		for (const server of this._mcpService.servers.get()) {
			if (server.definition.id === serverId) {
				return server;
			}
		}
		return undefined;
	}

	/**
	 * Reconnects to an MCP server and creates an {@link McpTask} to poll
	 * for the background task's result, reusing the existing polling state machine.
	 */
	private async _reconnectWithMcpTask(
		server: IMcpServer,
		task: ChatBackgroundTask,
		cts: CancellationTokenSource,
	): Promise<void> {
		const store = new DisposableStore();
		try {
			const state = await server.start();
			if (state.state !== McpConnectionState.Kind.Running) {
				task.fail(localize('bgTask.serverNotRunning', "Server '{0}' is not running", task.server.label));
				return;
			}

			// Create an McpTask pointed at the existing remote task ID. The McpTask
			// handles polling, TTL, input_required, and reconnections.
			const mcpTask = store.add(new McpTask<MCP.CallToolResult>(
				{ taskId: task.taskId, status: 'working', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttl: null },
				cts.token,
			));

			// Wire the McpTask to the server's handler
			await McpServer.callOn(server, async handler => {
				mcpTask.setHandler(handler);
			}, cts.token);

			const result = await mcpTask.result;
			task.complete(result);
		} catch (err) {
			task.fail(err instanceof Error ? err.message : String(err));
		} finally {
			store.dispose();
		}
	}

	/**
	 * Restores background tasks from the model's current input state.
	 * After reload, pending `backgroundTask` attachments live in the
	 * input model, not yet attached to any request.
	 */
	private _restoreTasksForModel(sessionResource: URI): void {
		const model = this._chatService.getSession(sessionResource);
		if (!model) {
			return;
		}

		const inputState = model.inputModel?.state.get();
		if (!inputState?.attachments) {
			return;
		}

		for (const attachment of inputState.attachments) {
			if (isBackgroundTaskVariableEntry(attachment)) {
				const serialized: ISerializedBackgroundTask = {
					taskId: attachment.taskId,
					toolName: attachment.name,
					toolCallId: attachment.toolCallId,
					server: attachment.server,
					status: BackgroundTaskStatus.Working,
				};
				this.restoreBackgroundTask(sessionResource, serialized);
			}
		}
	}
}
