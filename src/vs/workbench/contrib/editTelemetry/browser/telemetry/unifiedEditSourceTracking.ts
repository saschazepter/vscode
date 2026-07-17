/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { mapObservableArrayCached } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { IEditorWorkerService } from '../../../../../editor/common/services/editorWorker.js';
import { EditSources, TextModelEditSource } from '../../../../../editor/common/textModelEditSource.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { DiffService } from '../helpers/documentWithAnnotatedEdits.js';
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
import { IUnifiedDocumentSnapshot, IUnifiedDocumentTransition } from '../helpers/unifiedDocumentReconciler.js';
import { IRandomService } from '../randomService.js';
import { EditTelemetryTrigger, sendEditSourcesDetailsTelemetry } from './editSourceTelemetry.js';
import {
	IEditSourceDetailsSnapshot,
	IEditTrackerSnapshot,
	projectUnifiedDocumentTracker,
	snapshotEditSourceDetails,
} from './unifiedDocumentTrackerProjection.js';

interface IUnifiedEditSourceTrackingCheckpoint {
	readonly content: string;
	readonly maxTransitionId: number;
}

/**
 * Owns the canonical edit stream and long-term details windows for each resource.
 */
export class UnifiedEditSourceTracking extends Disposable {
	private readonly _registry: UnifiedDocumentRegistry<TextModelEditSource>;
	private readonly _lastResults = new Map<string, IUnifiedDocumentRegistryResult<TextModelEditSource>>();
	private readonly _longTermCheckpoints = new Map<string, IUnifiedEditSourceTrackingCheckpoint>();
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
					this._recordResult(result.result);
					if (result.inputKind === 'disconnected') {
						this._scheduleCleanup(result.result.resource);
					}
				},
			));
		}).recomputeInitiallyAndOnChange(this._store);
	}

	applyAgentEdit(edit: IUnifiedDocumentAgentEdit<TextModelEditSource>): IUnifiedDocumentAgentAdapterResult<TextModelEditSource> {
		const result = applyUnifiedDocumentAgentEdit(this._registry, edit);
		this._recordResult(result.transitionResult);
		if (result.transferResult) {
			if (edit.previousResource) {
				this._lastResults.delete(this._key(edit.previousResource));
				this._transferResourceState(edit.previousResource, edit.resource);
			}
			this._recordResult(result.transferResult);
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

	applyDiskSnapshot(resource: URI, content: string): IUnifiedDocumentRegistryResult<TextModelEditSource> {
		const result = this._registry.diskSnapshot(resource, content);
		this._recordResult(result);
		return result;
	}

	getLastResult(resource: URI): IUnifiedDocumentRegistryResult<TextModelEditSource> | undefined {
		return this._lastResults.get(this._key(resource));
	}

	getSnapshot(resource: URI): IUnifiedDocumentSnapshot<TextModelEditSource> | undefined {
		return this._registry.get(resource)?.reconciler.getSnapshot();
	}

	async project(resource: URI): Promise<IEditTrackerSnapshot | undefined> {
		const snapshot = this.getSnapshot(resource);
		return snapshot ? projectUnifiedDocumentTracker(snapshot, (before, after) => this._diffService.computeDiff(before, after)) : undefined;
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
		const snapshot = this.getSnapshot(resource);
		if (!snapshot) {
			return undefined;
		}
		const checkpoint = this._longTermCheckpoints.get(resourceKey);
		const transitions = checkpoint
			? snapshot.transitions.filter(transition => transition.id > checkpoint.maxTransitionId)
			: snapshot.transitions;
		const pendingReload = snapshot.pendingReload && (!checkpoint || snapshot.pendingReload.id > checkpoint.maxTransitionId)
			? snapshot.pendingReload
			: undefined;
		if (transitions.length === 0) {
			if (!pendingReload) {
				this._longTermCheckpoints.set(resourceKey, createCheckpoint(snapshot.content, snapshot.transitions));
			}
			return undefined;
		}

		const windowSnapshot: IUnifiedDocumentSnapshot<TextModelEditSource> = {
			...snapshot,
			initialContent: checkpoint?.content ?? snapshot.initialContent,
			transitions,
			pendingReload,
		};
		const trackerSnapshot = await projectUnifiedDocumentTracker(
			windowSnapshot,
			(before, after) => this._diffService.computeDiff(before, after),
		);
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
		this._longTermCheckpoints.set(resourceKey, createCheckpoint(trackerSnapshot.content, transitions));
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
				this.applyDiskSnapshot(resource, content);
			}
		} catch (error) {
			if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
				this.applyDiskSnapshot(resource, '');
				return;
			}
			throw error;
		}
	}

	private _recordResult(result: IUnifiedDocumentRegistryResult<TextModelEditSource>): void {
		this._lastResults.set(this._key(result.resource), result);
	}

	private _transferResourceState(previousResource: URI, resource: URI): void {
		const previousKey = this._key(previousResource);
		const key = this._key(resource);
		const checkpoint = this._longTermCheckpoints.get(previousKey);
		if (checkpoint) {
			this._longTermCheckpoints.delete(previousKey);
			this._longTermCheckpoints.set(key, checkpoint);
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
			this._longTermCheckpoints.delete(resourceKey);
		}, error => {
			this._logService.error(`[UnifiedEditSourceTracking] Failed to finish resource cleanup: ${error}`);
		});
	}

	private _key(resource: URI): string {
		return this._uriIdentityService.extUri.getComparisonKey(this._uriIdentityService.asCanonicalUri(resource));
	}
}

function createCheckpoint(
	content: string,
	transitions: readonly IUnifiedDocumentTransition<TextModelEditSource>[],
): IUnifiedEditSourceTrackingCheckpoint {
	let maxTransitionId = 0;
	for (const transition of transitions) {
		maxTransitionId = Math.max(maxTransitionId, transition.id);
	}
	return { content, maxTransitionId };
}
