/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { extname } from '../../../../../base/common/path.js';
import { autorun, derived, IObservable, IObservableWithChange, IReader, ISettableObservable, observableValue, runOnChange } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { AnnotatedStringEdit, StringEdit } from '../../../../../editor/common/core/edits/stringEdit.js';
import { StringText } from '../../../../../editor/common/core/text/abstractText.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IEditorWorkerService } from '../../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { EditSources, TextModelEditSource } from '../../../../../editor/common/textModelEditSource.js';
import { AgentSession } from '../../../../../platform/agentHost/common/agentService.js';
import { IAgentHostConnectionsService } from '../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { normalizeFileEdit } from '../../../../../platform/agentHost/common/fileEditDiff.js';
import { toAgentHostUri } from '../../../../../platform/agentHost/common/agentHostUri.js';
import { ActionType } from '../../../../../platform/agentHost/common/state/protocol/common/actions.js';
import { isAhpChatChannel, parseRequiredSessionUriFromChatUri, ToolResultContentType, type ToolResultFileEditContent } from '../../../../../platform/agentHost/common/state/sessionState.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { ISCMService } from '../../../scm/common/scm.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { DiffService, EditKeySourceData, EditSourceData, IDocumentWithAnnotatedEdits } from '../helpers/documentWithAnnotatedEdits.js';
import { IRandomService } from '../randomService.js';
import { DocumentEditSourceTracker } from './editTracker.js';
import { EditTelemetryTrigger, IEditSourcesDetailsTelemetryData, sendEditSourcesDetailsTelemetry } from './editSourceTelemetry.js';
import { IScmRepoAdapter, ScmAdapter } from './scmAdapter.js';

const MAX_TRACKED_FILE_SIZE = 5 * 1024 * 1024;
const AGENT_HOST_TRACKING_SCOPE = 'agentHostAIOnly';

type ComputeDiff = (original: string, modified: string) => Promise<StringEdit>;
type GetRepo = (resource: URI, reader: IReader) => IScmRepoAdapter | undefined;
type SendDetails = (data: IEditSourcesDetailsTelemetryData, forwardToGitHub: boolean) => void;

/**
 * An in-memory document stream containing only Agent Host edits and reconciliation edits.
 */
class AgentHostSyntheticDocument extends Disposable implements IDocumentWithAnnotatedEdits<EditKeySourceData> {
	private readonly _value: ISettableObservable<StringText, { edit: AnnotatedStringEdit<EditKeySourceData> }>;
	readonly value: IObservableWithChange<StringText, { edit: AnnotatedStringEdit<EditKeySourceData> }>;

	constructor(initialText: string) {
		super();
		this.value = this._value = observableValue(this, new StringText(initialText));
	}

	get text(): string {
		return this._value.get().value;
	}

	async applyTransition(beforeText: string, afterText: string, source: TextModelEditSource, computeDiff: ComputeDiff): Promise<void> {
		if (this.text !== beforeText) {
			await this._apply(this.text, beforeText, EditSources.reloadFromDisk(), computeDiff);
		}
		await this._apply(beforeText, afterText, source, computeDiff);
	}

	async reconcile(text: string, computeDiff: ComputeDiff): Promise<void> {
		await this._apply(this.text, text, EditSources.reloadFromDisk(), computeDiff);
	}

	private async _apply(beforeText: string, afterText: string, source: TextModelEditSource, computeDiff: ComputeDiff): Promise<void> {
		if (beforeText === afterText) {
			return;
		}
		const data = new EditSourceData(source).toEditSourceData();
		const edit = (await computeDiff(beforeText, afterText)).mapData(() => data);
		this._value.set(new StringText(afterText), undefined, { edit });
	}

	waitForQueue(): Promise<void> {
		return Promise.resolve();
	}
}

/**
 * Tracks long-term Agent Host AI attribution for one file.
 */
export class AgentHostTrackedFile extends Disposable {
	private readonly _document: AgentHostSyntheticDocument;
	private readonly _tracker = this._register(new MutableDisposable<DocumentEditSourceTracker>());
	private readonly _resource: ISettableObservable<URI>;
	private readonly _repo;
	private _languageId = 'plaintext';
	private _operationQueue: Promise<void> = Promise.resolve();
	private _isDisposed = false;

	constructor(
		resource: URI,
		initialText: string,
		private readonly _readCurrentText: (resource: URI) => Promise<string | undefined>,
		private readonly _computeDiff: ComputeDiff,
		getRepo: GetRepo,
		private readonly _generateUuid: () => string,
		private readonly _sendDetails: SendDetails,
		private readonly _logService: ILogService,
		private readonly _onDidExpire: () => void,
	) {
		super();
		this._resource = observableValue(this, resource);
		this._document = this._register(new AgentHostSyntheticDocument(initialText));
		this._tracker.value = new DocumentEditSourceTracker(this._document, undefined);
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

	applyEdit(beforeText: string, afterText: string, source: TextModelEditSource, languageId: string): Promise<void> {
		return this._enqueue(async () => {
			if (this._isDisposed) {
				return;
			}
			await this._document.applyTransition(beforeText, afterText, source, this._computeDiff);
			if (!this._isDisposed) {
				this._languageId = languageId;
			}
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

			await this._document.reconcile(currentText, this._computeDiff);
			const tracker = this._tracker.value;
			if (!tracker) {
				return;
			}
			tracker.applyPendingExternalEdits();
			this._sendTelemetry(trigger, tracker);
			this._tracker.value = new DocumentEditSourceTracker(this._document, undefined);
		});
	}

	private _sendTelemetry(trigger: EditTelemetryTrigger, tracker: DocumentEditSourceTracker): void {
		const retainedByKey = new Map<string, number>();
		let totalModifiedCount = 0;
		for (const range of tracker.getTrackedRanges()) {
			if (range.sourceRepresentative.props.$trackingScope !== AGENT_HOST_TRACKING_SCOPE) {
				continue;
			}
			totalModifiedCount += range.range.length;
			retainedByKey.set(range.sourceKey, (retainedByKey.get(range.sourceKey) ?? 0) + range.range.length);
		}

		const entries = tracker.getAllKeys()
			.map(key => ({ key, representative: tracker.getRepresentative(key), modifiedCount: retainedByKey.get(key) ?? 0 }))
			.filter(entry => entry.representative?.props.$trackingScope === AGENT_HOST_TRACKING_SCOPE)
			.sort((a, b) => b.modifiedCount - a.modifiedCount)
			.slice(0, 30);
		if (entries.length === 0) {
			return;
		}

		const statsUuid = this._generateUuid();
		for (const entry of entries) {
			const representative = entry.representative!;
			sendEditSourcesDetailsTelemetryData(
				this._sendDetails,
				representative,
				entry.key,
				entry.modifiedCount,
				tracker.getTotalInsertedCharactersCount(entry.key),
				totalModifiedCount,
				this._languageId,
				statsUuid,
				trigger,
			);
		}
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

function sendEditSourcesDetailsTelemetryData(
	sendDetails: SendDetails,
	representative: TextModelEditSource,
	sourceKey: string,
	modifiedCount: number,
	deltaModifiedCount: number,
	totalModifiedCount: number,
	languageId: string,
	statsUuid: string,
	trigger: EditTelemetryTrigger,
): void {
	const harness = representative.props.$harness;
	sendDetails({
		mode: 'longterm',
		sourceKey,
		sourceKeyCleaned: representative.toKey(1, { $extensionId: false, $extensionVersion: false, $modelId: false }),
		extensionId: representative.props.$extensionId,
		extensionVersion: representative.props.$extensionVersion,
		modelId: representative.props.$modelId,
		trigger,
		languageId,
		statsUuid,
		conversationId: representative.props.$$sessionId,
		requestId: representative.props.$$requestId,
		origin: representative.props.$origin,
		harness,
		trackingScope: representative.props.$trackingScope,
		modifiedCount,
		deltaModifiedCount,
		totalModifiedCount,
	}, harness === 'copilotcli');
}

/**
 * Converts Agent Host file-edit actions into workbench edit-source telemetry.
 */
export class AgentHostEditSourceTracking extends Disposable {
	private readonly _connectionListeners = this._register(new MutableDisposable<DisposableStore>());
	private readonly _trackedFiles = new Map<string, AgentHostTrackedFile>();
	private readonly _diffService: DiffService;
	private readonly _scmAdapter: ScmAdapter;
	private _operationQueue: Promise<void> = Promise.resolve();
	private _isDisposed = false;

	constructor(
		private readonly _detailsEnabled: IObservable<boolean>,
		@IAgentHostConnectionsService private readonly _connectionsService: IAgentHostConnectionsService,
		@IFileService private readonly _fileService: IFileService,
		@IEditorWorkerService editorWorkerService: IEditorWorkerService,
		@IModelService private readonly _modelService: IModelService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@ISCMService scmService: ISCMService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
		@IRandomService private readonly _randomService: IRandomService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._diffService = new DiffService(editorWorkerService);
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
					for (const content of action.result.content ?? []) {
						if (content.type === ToolResultContentType.FileEdit) {
							await this._processFileEdit(connectionInfo.authority, session, provider, action.turnId, content);
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
		if (dirtyResource) {
			this._logService.trace(`[AgentHostEditSourceTracking] Skipping attribution for dirty open file ${dirtyResource.toString()}`);
			return;
		}

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
			trackingScope: AGENT_HOST_TRACKING_SCOPE,
		});

		const resourceKey = this._uriIdentityService.extUri.getComparisonKey(resource);
		const beforeResource = normalized.beforeUri ? toAgentHostUri(normalized.beforeUri, connectionAuthority) : undefined;
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
				beforeText,
				currentResource => this._readCurrentText(currentResource),
				(original, modified) => this._diffService.computeDiff(original, modified),
				(repoResource, reader) => this._scmAdapter.getRepo(repoResource, reader),
				() => this._randomService.generateUuid(),
				(data, forwardToGitHub) => sendEditSourcesDetailsTelemetry(this._telemetryService, data, forwardToGitHub),
				this._logService,
				() => this._removeTrackedFile(createdTrackedFile),
			);
			trackedFile = createdTrackedFile;
			this._trackedFiles.set(resourceKey, trackedFile);
		}

		await trackedFile.applyEdit(beforeText, afterText, source, languageId);
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
				trackedFile.dispose();
				return;
			}
		}
	}

	private _clearTrackedFiles(): void {
		for (const trackedFile of this._trackedFiles.values()) {
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
