/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { extname } from '../../../../../base/common/path.js';
import { autorun, derived, IObservable, IReader, ISettableObservable, observableValue, runOnChange } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { EditSources } from '../../../../../editor/common/textModelEditSource.js';
import { AgentSession } from '../../../../../platform/agentHost/common/agentService.js';
import { IAgentHostConnectionsService } from '../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { normalizeFileEdit } from '../../../../../platform/agentHost/common/fileEditDiff.js';
import { toAgentHostUri } from '../../../../../platform/agentHost/common/agentHostUri.js';
import { ActionType } from '../../../../../platform/agentHost/common/state/protocol/common/actions.js';
import { isAhpChatChannel, parseRequiredSessionUriFromChatUri, ToolResultContentType, type ToolResultFileEditContent } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { ISCMService } from '../../../scm/common/scm.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { EditTelemetryTrigger } from './editSourceTelemetry.js';
import { IScmRepoAdapter, ScmAdapter } from './scmAdapter.js';
import { UnifiedEditSourceTracking } from './unifiedEditSourceTracking.js';

const MAX_TRACKED_FILE_SIZE = 5 * 1024 * 1024;

type GetRepo = (resource: URI, reader: IReader) => IScmRepoAdapter | undefined;

/**
 * Tracks long-term Agent Host AI attribution for one file.
 */
export class AgentHostTrackedFile extends Disposable {
	private readonly _resource: ISettableObservable<URI>;
	private readonly _repo;
	private _languageId = 'plaintext';
	private _operationQueue: Promise<void> = Promise.resolve();
	private _isDisposed = false;

	constructor(
		resource: URI,
		private readonly _readCurrentText: (resource: URI) => Promise<string | undefined>,
		getRepo: GetRepo,
		private readonly _logService: ILogService,
		private readonly _onDidExpire: () => void,
		private readonly _onDidFlush: (resource: URI, content: string, languageId: string, trigger: EditTelemetryTrigger) => void,
	) {
		super();
		this._resource = observableValue(this, resource);
		this._repo = derived(this, reader => getRepo(this._resource.read(reader), reader));

		this._register(autorun(reader => {
			const repo = this._repo.read(reader);
			if (!repo) {
				return;
			}
			reader.store.add(runOnChange(repo.headCommitHashObs, () => this._flushAndLog('hashChange')));
			reader.store.add(runOnChange(repo.headBranchNameObs, () => this._flushAndLog('branchChange')));
		}));

		this._register(new IntervalTimer()).cancelAndSet(() => this._expireAndLog(), 10 * 60 * 60 * 1000);
	}

	get resource(): URI {
		return this._resource.get();
	}

	setResource(resource: URI): void {
		this._resource.set(resource, undefined);
	}

	applyEdit(languageId: string): Promise<void> {
		return this._enqueue(async () => {
			if (this._isDisposed) {
				return;
			}
			this._languageId = languageId;
		});
	}

	flush(trigger: EditTelemetryTrigger): Promise<void> {
		return this._enqueue(async () => {
			if (this._isDisposed) {
				return;
			}
			const currentText = await this._readCurrentText(this.resource);
			if (currentText === undefined || this._isDisposed) {
				return;
			}
			this._onDidFlush(this.resource, currentText, this._languageId, trigger);
		});
	}

	private _enqueue(operation: () => Promise<void>): Promise<void> {
		const result = this._operationQueue.then(operation, operation);
		this._operationQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	private _flushAndLog(trigger: EditTelemetryTrigger): void {
		this.flush(trigger).catch(error => this._logService.error(`[AgentHostEditSourceTracking] Failed to flush ${this.resource.toString()}: ${error}`));
	}

	private _expireAndLog(): void {
		this.flush('10hours').then(() => this._onDidExpire(), error => {
			this._logService.error(`[AgentHostEditSourceTracking] Failed to flush ${this.resource.toString()}: ${error}`);
		});
	}

	override dispose(): void {
		this._isDisposed = true;
		super.dispose();
	}
}

/**
 * Converts Agent Host file-edit actions into workbench edit-source telemetry.
 */
export class AgentHostEditSourceTracking extends Disposable {
	private readonly _connectionListeners = this._register(new MutableDisposable<DisposableStore>());
	private readonly _trackedFiles = new Map<string, AgentHostTrackedFile>();
	private readonly _scmAdapter: ScmAdapter;
	private _operationQueue: Promise<void> = Promise.resolve();
	private _isDisposed = false;

	constructor(
		private readonly _detailsEnabled: IObservable<boolean>,
		private readonly _unifiedTracking: UnifiedEditSourceTracking,
		@IAgentHostConnectionsService private readonly _connectionsService: IAgentHostConnectionsService,
		@IFileService private readonly _fileService: IFileService,
		@IModelService private readonly _modelService: IModelService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@ISCMService scmService: ISCMService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._scmAdapter = new ScmAdapter(scmService);
		this._syncConnectionListeners();
		this._register(this._connectionsService.onDidChangeConnections(() => this._syncConnectionListeners()));
		this._register(autorun(reader => {
			if (!this._detailsEnabled.read(reader)) {
				this._clearTrackedFiles();
			}
		}));
	}

	private _syncConnectionListeners(): void {
		const store = new DisposableStore();
		for (const connectionInfo of this._connectionsService.connections) {
			const connection = connectionInfo.connection;
			if (!connection) {
				continue;
			}
			store.add(connection.onDidAction(envelope => {
				const action = envelope.action;
				if (!this._detailsEnabled.get() || action.type !== ActionType.ChatToolCallComplete || !isAhpChatChannel(envelope.channel.toString())) {
					return;
				}
				this._enqueue(async () => {
					if (!this._detailsEnabled.get()) {
						return;
					}
					const session = URI.parse(parseRequiredSessionUriFromChatUri(envelope.channel));
					const provider = AgentSession.provider(session);
					if (!provider) {
						return;
					}
					for (const [contentIndex, content] of (action.result.content ?? []).entries()) {
						if (content.type === ToolResultContentType.FileEdit) {
							await this._processFileEdit(connectionInfo.authority, session, provider, action.turnId, action.toolCallId, contentIndex, content);
						}
					}
				});
			}));
		}
		this._connectionListeners.value = store;
	}

	private async _processFileEdit(
		connectionAuthority: string,
		session: URI,
		provider: string,
		turnId: string,
		toolCallId: string,
		contentIndex: number,
		fileEdit: ToolResultFileEditContent,
	): Promise<void> {
		const normalized = normalizeFileEdit(fileEdit);
		if (!normalized) {
			return;
		}

		const resource = toAgentHostUri(normalized.resource, connectionAuthority);
		if (extname(resource.path).toLowerCase() === '.ipynb') {
			return;
		}
		const editedResources = [normalized.beforeUri, normalized.afterUri]
			.filter(resource => resource !== undefined)
			.map(resource => toAgentHostUri(resource, connectionAuthority));
		const dirtyResource = editedResources.find(resource => isDirtyOpenTextModel(resource, this._modelService, this._textFileService));

		const beforeText = normalized.beforeContentUri ? await this._readSnapshot(normalized.beforeContentUri, connectionAuthority) : '';
		const afterText = normalized.afterContentUri ? await this._readSnapshot(normalized.afterContentUri, connectionAuthority) : '';
		if (this._isDisposed || !this._detailsEnabled.get() || beforeText === undefined || afterText === undefined || Math.max(beforeText.length, afterText.length) > MAX_TRACKED_FILE_SIZE) {
			return;
		}

		const harness = provider;
		const agentSessionId = AgentSession.id(session);
		const languageId = this._languageService.guessLanguageIdByFilepathOrFirstLine(resource, firstLine(afterText || beforeText)) ?? 'plaintext';
		const source = EditSources.chatApplyEdits({
			modelId: undefined,
			sessionId: agentSessionId,
			requestId: turnId,
			languageId,
			mode: undefined,
			extensionId: undefined,
			codeBlockSuggestionId: undefined,
			harness,
			origin: 'agentHost',
		});
		const beforeResource = normalized.beforeUri ? toAgentHostUri(normalized.beforeUri, connectionAuthority) : undefined;
		this._unifiedTracking.applyAgentEdit({
			resource,
			previousResource: beforeResource,
			before: beforeText,
			after: afterText,
			source,
			correlation: `${session.toString()}:${toolCallId}:${contentIndex}`,
			kind: normalized.kind,
		});
		if (dirtyResource) {
			this._logService.trace(`[AgentHostEditSourceTracking] Skipping attribution for dirty open file ${dirtyResource.toString()}`);
			return;
		}

		const resourceKey = this._uriIdentityService.extUri.getComparisonKey(resource);
		const beforeResourceKey = beforeResource ? this._uriIdentityService.extUri.getComparisonKey(beforeResource) : undefined;
		let trackedFile = this._trackedFiles.get(resourceKey);
		if (!trackedFile && beforeResourceKey && beforeResourceKey !== resourceKey) {
			trackedFile = this._trackedFiles.get(beforeResourceKey);
			if (trackedFile) {
				this._trackedFiles.delete(beforeResourceKey);
				this._trackedFiles.set(resourceKey, trackedFile);
				trackedFile.setResource(resource);
			}
		}
		if (!trackedFile) {
			const createdTrackedFile = new AgentHostTrackedFile(
				resource,
				currentResource => this._readCurrentText(currentResource),
				(repoResource, reader) => this._scmAdapter.getRepo(repoResource, reader),
				this._logService,
				() => this._removeTrackedFile(createdTrackedFile),
				(currentResource, content, currentLanguageId, trigger) => this._flushAgentHostResource(currentResource, content, currentLanguageId, trigger),
			);
			trackedFile = createdTrackedFile;
			this._trackedFiles.set(resourceKey, trackedFile);
		}
		this._unifiedTracking.retainAgentResource(resource);

		await trackedFile.applyEdit(languageId);
	}

	private _flushAgentHostResource(resource: URI, content: string, languageId: string, trigger: EditTelemetryTrigger): void {
		this._unifiedTracking.applyDiskSnapshot(resource, content);
		if (this._unifiedTracking.hasLocalLongTermResource(resource)) {
			return;
		}
		this._unifiedTracking.flushLongTermDetails(resource, trigger, languageId).catch(error => {
			this._logService.error(`[AgentHostEditSourceTracking] Failed to flush unified long-term details: ${error}`);
		});
	}

	private async _readSnapshot(resource: URI, connectionAuthority: string): Promise<string | undefined> {
		return this._readText(toAgentHostUri(resource, connectionAuthority), false);
	}

	private async _readCurrentText(resource: URI): Promise<string | undefined> {
		return this._readText(resource, true);
	}

	private async _readText(resource: URI, missingAsEmpty: boolean): Promise<string | undefined> {
		try {
			const value = (await this._fileService.readFile(resource)).value.toString();
			if (value.includes('\0')) {
				this._logService.trace(`[AgentHostEditSourceTracking] Skipping binary file ${resource.toString()}`);
				return undefined;
			}
			return value;
		} catch (error) {
			if (missingAsEmpty && toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
				return '';
			}
			throw error;
		}
	}

	private _enqueue(operation: () => Promise<void>): void {
		const run = async () => {
			if (!this._isDisposed) {
				await operation();
			}
		};
		const result = this._operationQueue.then(run, run);
		this._operationQueue = result.catch(error => {
			this._logService.error(`[AgentHostEditSourceTracking] Failed to process Agent Host edit: ${error}`);
		});
	}

	private _removeTrackedFile(trackedFile: AgentHostTrackedFile): void {
		for (const [key, value] of this._trackedFiles) {
			if (value === trackedFile) {
				this._trackedFiles.delete(key);
				this._unifiedTracking.releaseAgentResource(trackedFile.resource);
				trackedFile.dispose();
				return;
			}
		}
	}

	private _clearTrackedFiles(): void {
		for (const trackedFile of this._trackedFiles.values()) {
			this._unifiedTracking.releaseAgentResource(trackedFile.resource);
			trackedFile.dispose();
		}
		this._trackedFiles.clear();
	}

	override dispose(): void {
		this._isDisposed = true;
		this._clearTrackedFiles();
		super.dispose();
	}
}

function firstLine(text: string): string {
	const lineBreak = text.search(/\r\n|\r|\n/);
	return lineBreak === -1 ? text : text.substring(0, lineBreak);
}

export function isDirtyOpenTextModel(resource: URI, modelService: Pick<IModelService, 'getModel'>, textFileService: Pick<ITextFileService, 'isDirty'>): boolean {
	return modelService.getModel(resource) !== null && textFileService.isDirty(resource);
}
