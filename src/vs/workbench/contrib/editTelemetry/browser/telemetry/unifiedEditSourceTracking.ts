/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IObservableWithChange, ISettableObservable, mapObservableArrayCached, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { AnnotatedStringEdit, StringEdit } from '../../../../../editor/common/core/edits/stringEdit.js';
import { StringText } from '../../../../../editor/common/core/text/abstractText.js';
import { IEditorWorkerService } from '../../../../../editor/common/services/editorWorker.js';
import { EditSources, TextModelEditSource } from '../../../../../editor/common/textModelEditSource.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { DiffService, EditKeySourceData, EditSourceData, IDocumentWithAnnotatedEdits } from '../helpers/documentWithAnnotatedEdits.js';
import { ObservableWorkspace } from '../helpers/observableWorkspace.js';
import {
	applyUnifiedDocumentAgentEdit,
	IUnifiedDocumentAgentAdapterResult,
	IUnifiedDocumentAgentEdit,
	UnifiedDocumentModelAdapter,
} from '../helpers/unifiedDocumentAdapters.js';
import {
	IUnifiedDocumentRegistryResult,
	UnifiedDocumentRegistry,
} from '../helpers/unifiedDocumentRegistry.js';
import {
	IUnifiedDocumentSnapshot,
	IUnifiedDocumentTransition,
	IUnifiedDocumentTransitionChange,
} from '../helpers/unifiedDocumentReconciler.js';
import { IRandomService } from '../randomService.js';
import { EditTelemetryTrigger, sendEditSourcesDetailsTelemetry } from './editSourceTelemetry.js';
import { DocumentEditSourceTracker } from './editTracker.js';
import {
	IEditSourceDetailsSnapshot,
	IEditTrackerSnapshot,
	snapshotDocumentEditSourceTracker,
	snapshotEditSourceDetails,
} from './unifiedDocumentTrackerProjection.js';

/**
 * Owns the canonical edit stream and long-term details windows for each resource.
 */
export class UnifiedEditSourceTracking extends Disposable {
	private readonly _registry: UnifiedDocumentRegistry<TextModelEditSource>;
	private readonly _trackedResources = new Map<string, UnifiedTrackedResource>();
	private readonly _lastResults = new Map<string, IUnifiedDocumentRegistryResult<TextModelEditSource>>();
	private readonly _flushQueues = new Map<string, Promise<IEditSourceDetailsSnapshot | undefined>>();
	private readonly _retainedAgentResources = new Set<string>();
	private readonly _localLongTermResources = new Set<string>();
	private readonly _diffService: DiffService;

	constructor(
		workspace: ObservableWorkspace,
		@IFileService private readonly _fileService: IFileService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
		@IEditorWorkerService editorWorkerService: IEditorWorkerService,
		@IRandomService private readonly _randomService: IRandomService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._diffService = new DiffService(editorWorkerService);
		this._registry = new UnifiedDocumentRegistry({
			externalSource: EditSources.reloadFromDisk(),
			canonicalize: resource => this._uriIdentityService.asCanonicalUri(resource),
			getComparisonKey: resource => this._uriIdentityService.extUri.getComparisonKey(resource),
		});
		mapObservableArrayCached(this, workspace.documents, (document, store) => {
			const initialContent = document.value.get().value;
			return store.add(new UnifiedDocumentModelAdapter(
				this._registry,
				document,
				initialContent,
				() => this._textFileService.isDirty(document.uri),
				change => change.reason,
				result => {
					this._applyResult(result.result);
					if (result.inputKind === 'disconnected') {
						this._scheduleCleanup(result.result.resource);
					}
				},
			));
		}).recomputeInitiallyAndOnChange(this._store);
	}

	async applyAgentEdit(edit: Omit<IUnifiedDocumentAgentEdit<TextModelEditSource>, 'edit'>): Promise<IUnifiedDocumentAgentAdapterResult<TextModelEditSource>> {
		const stringEdit = await this._computeSnapshotEdit(edit.before, edit.after);
		const result = applyUnifiedDocumentAgentEdit(this._registry, { ...edit, edit: stringEdit });
		this._applyResult(result.transitionResult);
		if (result.transitionResult.outcome === 'conflict' || result.transitionResult.outcome === 'skippedDirty') {
			this._scheduleCleanup(result.transitionResult.resource);
		}
		if (result.transferResult) {
			this._recordResult(result.transferResult);
			if (result.transferResult.outcome === 'applied' && edit.previousResource) {
				this._transferResourceState(edit.previousResource, edit.resource);
			}
		}
		return result;
	}

	retainAgentResource(resource: URI): void {
		this._retainedAgentResources.add(this._key(resource));
	}

	releaseAgentResource(resource: URI): void {
		this._retainedAgentResources.delete(this._key(resource));
		this._scheduleCleanup(resource);
	}

	retainLocalLongTermResource(resource: URI): void {
		this._localLongTermResources.add(this._key(resource));
	}

	releaseLocalLongTermResource(resource: URI): void {
		this._localLongTermResources.delete(this._key(resource));
		this._scheduleCleanup(resource);
	}

	hasLocalLongTermResource(resource: URI): boolean {
		return this._localLongTermResources.has(this._key(resource));
	}

	async applyDiskSnapshot(resource: URI, content: string): Promise<IUnifiedDocumentRegistryResult<TextModelEditSource>> {
		const snapshot = this.getSnapshot(resource);
		const edit = await this._computeSnapshotEdit(snapshot?.content ?? content, content);
		const result = this._registry.diskSnapshot(resource, content, edit);
		this._applyResult(result);
		return result;
	}

	getLastResult(resource: URI): IUnifiedDocumentRegistryResult<TextModelEditSource> | undefined {
		return this._lastResults.get(this._key(resource));
	}

	getSnapshot(resource: URI): IUnifiedDocumentSnapshot<TextModelEditSource> | undefined {
		return this._registry.get(resource)?.reconciler.getSnapshot();
	}

	project(resource: URI): IEditTrackerSnapshot | undefined {
		return this._trackedResources.get(this._key(resource))?.snapshot();
	}

	flushLongTermDetails(
		resource: URI,
		trigger: EditTelemetryTrigger,
		languageId: string,
		statsUuid = this._randomService.generateUuid(),
	): Promise<IEditSourceDetailsSnapshot | undefined> {
		const resourceKey = this._key(resource);
		const run = () => this._flushLongTermDetails(resourceKey, resource, trigger, languageId, statsUuid);
		const result = (this._flushQueues.get(resourceKey) ?? Promise.resolve(undefined)).then(run, run);
		this._flushQueues.set(resourceKey, result);
		const clearQueue = () => {
			if (this._flushQueues.get(resourceKey) === result) {
				this._flushQueues.delete(resourceKey);
			}
		};
		result.then(clearQueue, clearQueue);
		return result;
	}

	private async _flushLongTermDetails(
		resourceKey: string,
		resource: URI,
		trigger: EditTelemetryTrigger,
		languageId: string,
		statsUuid: string,
	): Promise<IEditSourceDetailsSnapshot | undefined> {
		await this._synchronizeDisk(resource);
		const reconciler = this._registry.get(resource)?.reconciler;
		const snapshot = reconciler?.getSnapshot();
		const trackedResource = this._trackedResources.get(resourceKey);
		if (!reconciler || !snapshot || !trackedResource || snapshot.pendingReload || snapshot.transitions.length === 0) {
			return undefined;
		}

		const trackerSnapshot = trackedResource.snapshot();
		const details = snapshotEditSourceDetails(trackerSnapshot, 30, 'retained');
		if (details.rows.length > 0) {
			for (const row of details.rows) {
				sendEditSourcesDetailsTelemetry(this._telemetryService, {
					mode: 'longterm',
					sourceKey: row.sourceKey,
					sourceKeyCleaned: row.cleanedSourceKey,
					extensionId: row.extensionId,
					extensionVersion: row.extensionVersion,
					modelId: row.modelId,
					trigger,
					languageId,
					statsUuid,
					conversationId: row.conversationId,
					requestId: row.requestId,
					origin: row.origin,
					harness: row.harness,
					modifiedCount: row.modifiedCount,
					deltaModifiedCount: row.deltaModifiedCount,
					totalModifiedCount: details.totalModifiedCount,
				}, row.origin === 'agentHost' ? row.harness === 'copilotcli' : undefined);
			}
		}
		trackedResource.reset(snapshot.content);
		reconciler.resetWindow();
		return details;
	}

	private async _synchronizeDisk(resource: URI): Promise<void> {
		const snapshot = this.getSnapshot(resource);
		if (snapshot?.model?.dirty || snapshot?.pendingReload || !this._fileService.hasProvider(resource)) {
			return;
		}
		try {
			const content = (await this._fileService.readFile(resource)).value.toString();
			if (!content.includes('\0')) {
				await this.applyDiskSnapshot(resource, content);
			}
		} catch (error) {
			if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
				await this.applyDiskSnapshot(resource, '');
				return;
			}
			throw error;
		}
	}

	private _applyResult(result: IUnifiedDocumentRegistryResult<TextModelEditSource>): void {
		this._recordResult(result);
		const key = this._key(result.resource);
		let trackedResource = this._trackedResources.get(key);
		if (!trackedResource) {
			trackedResource = new UnifiedTrackedResource(result.reconcileResult?.snapshot.initialContent ?? '');
			this._trackedResources.set(key, trackedResource);
		}
		const changes = result.reconcileResult?.changes ?? [];
		if (changes.some(change => change.kind === 'replace')) {
			trackedResource.rebuild(result.reconcileResult!.snapshot);
		} else {
			trackedResource.apply(changes);
		}
	}

	private _recordResult(result: IUnifiedDocumentRegistryResult<TextModelEditSource>): void {
		this._lastResults.set(this._key(result.resource), result);
	}

	private _transferResourceState(previousResource: URI, resource: URI): void {
		const previousKey = this._key(previousResource);
		const key = this._key(resource);
		const trackedResource = this._trackedResources.get(previousKey);
		if (trackedResource) {
			this._trackedResources.delete(previousKey);
			this._trackedResources.set(key, trackedResource);
		}
		if (this._retainedAgentResources.delete(previousKey)) {
			this._retainedAgentResources.add(key);
		}
		if (this._localLongTermResources.delete(previousKey)) {
			this._localLongTermResources.add(key);
		}
	}

	private _scheduleCleanup(resource: URI): void {
		const resourceKey = this._key(resource);
		const pendingFlush = this._flushQueues.get(resourceKey);
		(pendingFlush ?? Promise.resolve(undefined)).then(() => {
			const snapshot = this.getSnapshot(resource);
			if (snapshot?.model || this._retainedAgentResources.has(resourceKey) || this._localLongTermResources.has(resourceKey)) {
				return;
			}
			this._registry.delete(resource);
			this._lastResults.delete(resourceKey);
			this._trackedResources.get(resourceKey)?.dispose();
			this._trackedResources.delete(resourceKey);
		}, error => {
			this._logService.error(`[UnifiedEditSourceTracking] Failed to finish resource cleanup: ${error}`);
		});
	}

	private async _computeSnapshotEdit(before: string, after: string): Promise<StringEdit> {
		if (before === after) {
			return StringEdit.empty;
		}
		return (await this._diffService.computeDiff(before, after)).removeCommonSuffixPrefix(before);
	}

	private _key(resource: URI): string {
		return this._uriIdentityService.extUri.getComparisonKey(this._uriIdentityService.asCanonicalUri(resource));
	}

	override dispose(): void {
		for (const trackedResource of this._trackedResources.values()) {
			trackedResource.dispose();
		}
		this._trackedResources.clear();
		super.dispose();
	}
}

class UnifiedTrackedResource extends Disposable {
	private readonly _active = this._register(new MutableDisposable<DisposableStore>());
	private _document!: UnifiedTrackingDocument;
	private _tracker!: DocumentEditSourceTracker;

	constructor(initialContent: string) {
		super();
		this.reset(initialContent);
	}

	apply(changes: readonly IUnifiedDocumentTransitionChange<TextModelEditSource>[]): void {
		for (const change of changes) {
			if (change.kind !== 'append') {
				throw new Error('Replacement changes require a tracker rebuild');
			}
			this._document.apply(change.before, change.after, change.transition);
		}
	}

	rebuild(snapshot: IUnifiedDocumentSnapshot<TextModelEditSource>): void {
		this.reset(snapshot.initialContent);
		for (const transition of snapshot.transitions) {
			const before = this._document.content;
			const after = transition.edit.apply(before);
			this._document.apply(before, after, transition);
		}
	}

	snapshot(): IEditTrackerSnapshot {
		this._tracker.applyPendingExternalEdits();
		return snapshotDocumentEditSourceTracker(this._tracker, this._document.content);
	}

	reset(content: string): void {
		const store = new DisposableStore();
		this._document = store.add(new UnifiedTrackingDocument(content));
		this._tracker = store.add(new DocumentEditSourceTracker(this._document, undefined));
		this._active.value = store;
	}
}

class UnifiedTrackingDocument extends Disposable implements IDocumentWithAnnotatedEdits<EditKeySourceData> {
	private readonly _value: ISettableObservable<StringText, { edit: AnnotatedStringEdit<EditKeySourceData> }>;
	readonly value: IObservableWithChange<StringText, { edit: AnnotatedStringEdit<EditKeySourceData> }>;

	constructor(initialContent: string) {
		super();
		this.value = this._value = observableValue(this, new StringText(initialContent));
	}

	get content(): string {
		return this._value.get().value;
	}

	apply(before: string, after: string, transition: IUnifiedDocumentTransition<TextModelEditSource>): void {
		if (this.content !== before || transition.edit.apply(before) !== after) {
			throw new Error('Unified transition does not connect to the tracked document');
		}
		const data = new EditSourceData(transition.source).toEditSourceData();
		this._value.set(new StringText(after), undefined, { edit: transition.edit.mapData(() => data) });
	}

	waitForQueue(): Promise<void> {
		return Promise.resolve();
	}
}
