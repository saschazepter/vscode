/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { mapObservableArrayCached } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { TextModelEditSource, EditSources } from '../../../../../editor/common/textModelEditSource.js';
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
import { IUnifiedDocumentSnapshot } from '../helpers/unifiedDocumentReconciler.js';
import {
	compareEditSourceDetailsSnapshots,
	compareEditTrackerSnapshots,
	EditSourceDetailsOrder,
	EditTrackerSourceSnapshotFilter,
	filterEditTrackerSnapshot,
	IEditSourceDetailsSnapshot,
	IEditTrackerShadowComparison,
	IEditTrackerSnapshot,
	projectUnifiedDocumentTracker,
	snapshotEditSourceDetails,
	UnifiedDocumentComputeDiff,
} from './unifiedDocumentTrackerProjection.js';

export interface IUnifiedEditTrackerShadowTrackingOptions {
	readonly isDirty: (resource: URI) => boolean;
	readonly canonicalize: (resource: URI) => URI;
	readonly getComparisonKey: (resource: URI) => string;
}

export interface IUnifiedEditTrackerShadowComparisonResult {
	readonly candidate: IEditTrackerSnapshot;
	readonly trackerComparison: IEditTrackerShadowComparison;
	readonly referenceDetails: IEditSourceDetailsSnapshot;
	readonly candidateDetails: IEditSourceDetailsSnapshot;
	readonly detailsComparison: IEditTrackerShadowComparison;
}

export interface IUnifiedEditTrackerShadowComparisonOptions {
	readonly sourceFilter?: EditTrackerSourceSnapshotFilter;
	readonly skipAgentHostTransitions?: boolean;
	readonly detailsOrder?: EditSourceDetailsOrder;
}

interface IUnifiedEditTrackerShadowCheckpoint {
	readonly content: string;
	readonly maxTransitionId: number;
}

/**
 * Mirrors live edit inputs into the unified registry without affecting production telemetry.
 */
export class UnifiedEditTrackerShadowTracking extends Disposable {
	private readonly _registry: UnifiedDocumentRegistry<TextModelEditSource>;
	private readonly _lastResults = new Map<string, IUnifiedDocumentRegistryResult<TextModelEditSource>>();
	private readonly _checkpoints = new Map<string, IUnifiedEditTrackerShadowCheckpoint>();
	private readonly _comparisonQueues = new Map<string, Promise<IUnifiedEditTrackerShadowComparisonResult | undefined>>();
	private readonly _retainedAgentResources = new Set<string>();

	constructor(
		workspace: ObservableWorkspace,
		private readonly _options: IUnifiedEditTrackerShadowTrackingOptions,
	) {
		super();
		this._registry = new UnifiedDocumentRegistry({
			externalSource: EditSources.reloadFromDisk(),
			canonicalize: this._options.canonicalize,
			getComparisonKey: this._options.getComparisonKey,
		});
		mapObservableArrayCached(this, workspace.documents, (document, store) => {
			const initialContent = document.value.get().value;
			return store.add(new UnifiedDocumentModelAdapter(
				this._registry,
				document,
				initialContent,
				() => this._options.isDirty(document.uri),
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
				this._transferCheckpoints(edit.previousResource, edit.resource);
				this._transferAgentRetention(edit.previousResource, edit.resource);
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

	async project(resource: URI, computeDiff: UnifiedDocumentComputeDiff): Promise<IEditTrackerSnapshot | undefined> {
		const snapshot = this.getSnapshot(resource);
		return snapshot ? projectUnifiedDocumentTracker(snapshot, computeDiff) : undefined;
	}

	startComparison(lane: string, resource: URI): void {
		const snapshot = this.getSnapshot(resource);
		if (snapshot) {
			this._checkpoints.set(this._laneKey(lane, resource), createCheckpoint(snapshot));
		}
	}

	async compare(
		resource: URI,
		reference: IEditTrackerSnapshot,
		computeDiff: UnifiedDocumentComputeDiff,
	): Promise<IUnifiedEditTrackerShadowComparisonResult | undefined> {
		const candidate = await this.project(resource, computeDiff);
		if (!candidate) {
			return undefined;
		}
		const referenceDetails = snapshotEditSourceDetails(reference);
		const candidateDetails = snapshotEditSourceDetails(candidate);
		return {
			candidate,
			trackerComparison: compareEditTrackerSnapshots(reference, candidate),
			referenceDetails,
			candidateDetails,
			detailsComparison: compareEditSourceDetailsSnapshots(referenceDetails, candidateDetails),
		};
	}

	compareAndCheckpoint(
		lane: string,
		resource: URI,
		reference: IEditTrackerSnapshot,
		computeDiff: UnifiedDocumentComputeDiff,
		options: IUnifiedEditTrackerShadowComparisonOptions = {},
	): Promise<IUnifiedEditTrackerShadowComparisonResult | undefined> {
		const laneKey = this._laneKey(lane, resource);
		const run = () => this._compareAndCheckpoint(laneKey, resource, reference, computeDiff, options);
		const result = (this._comparisonQueues.get(laneKey) ?? Promise.resolve(undefined)).then(run, run);
		this._comparisonQueues.set(laneKey, result);
		const clearQueue = () => {
			if (this._comparisonQueues.get(laneKey) === result) {
				this._comparisonQueues.delete(laneKey);
			}
		};
		result.then(clearQueue, clearQueue);
		return result;
	}

	private async _compareAndCheckpoint(
		laneKey: string,
		resource: URI,
		reference: IEditTrackerSnapshot,
		computeDiff: UnifiedDocumentComputeDiff,
		options: IUnifiedEditTrackerShadowComparisonOptions,
	): Promise<IUnifiedEditTrackerShadowComparisonResult | undefined> {
		const snapshot = this.getSnapshot(resource);
		if (!snapshot) {
			return undefined;
		}
		const checkpoint = this._checkpoints.get(laneKey);
		const transitions = checkpoint
			? snapshot.transitions.filter(transition => transition.id > checkpoint.maxTransitionId)
			: snapshot.transitions;
		const comparisonSnapshot: IUnifiedDocumentSnapshot<TextModelEditSource> = {
			...snapshot,
			initialContent: checkpoint?.content ?? snapshot.initialContent,
			transitions,
			pendingReload: snapshot.pendingReload && (!checkpoint || snapshot.pendingReload.id > checkpoint.maxTransitionId)
				? snapshot.pendingReload
				: undefined,
		};
		if (options.skipAgentHostTransitions && transitions.some(transition => transition.kind === 'agentHost')) {
			this._checkpoints.set(laneKey, createCheckpoint(snapshot));
			return undefined;
		}

		let candidate = await projectUnifiedDocumentTracker(comparisonSnapshot, computeDiff);
		let filteredReference = reference;
		if (options.sourceFilter) {
			candidate = filterEditTrackerSnapshot(candidate, options.sourceFilter);
			filteredReference = filterEditTrackerSnapshot(reference, options.sourceFilter);
		}
		const referenceDetails = snapshotEditSourceDetails(filteredReference, undefined, 30, options.detailsOrder);
		const candidateDetails = snapshotEditSourceDetails(candidate, undefined, 30, options.detailsOrder);
		const result: IUnifiedEditTrackerShadowComparisonResult = {
			candidate,
			trackerComparison: compareEditTrackerSnapshots(filteredReference, candidate),
			referenceDetails,
			candidateDetails,
			detailsComparison: compareEditSourceDetailsSnapshots(referenceDetails, candidateDetails),
		};
		this._checkpoints.set(laneKey, createCheckpoint(snapshot));
		return result;
	}

	private _recordResult(result: IUnifiedDocumentRegistryResult<TextModelEditSource>): void {
		this._lastResults.set(this._key(result.resource), result);
	}

	private _transferCheckpoints(previousResource: URI, resource: URI): void {
		const previousKeySuffix = `:${this._key(previousResource)}`;
		for (const [key, checkpoint] of this._checkpoints) {
			if (key.endsWith(previousKeySuffix)) {
				const lane = key.substring(0, key.length - previousKeySuffix.length);
				this._checkpoints.delete(key);
				this._checkpoints.set(this._laneKey(lane, resource), checkpoint);
			}
		}
	}

	private _transferAgentRetention(previousResource: URI, resource: URI): void {
		const previousKey = this._key(previousResource);
		if (this._retainedAgentResources.delete(previousKey)) {
			this._retainedAgentResources.add(this._key(resource));
		}
	}

	private _scheduleCleanup(resource: URI): void {
		const resourceKey = this._key(resource);
		const keySuffix = `:${resourceKey}`;
		const comparisons = Array.from(this._comparisonQueues)
			.filter(([key]) => key.endsWith(keySuffix))
			.map(([, comparison]) => comparison);
		Promise.allSettled(comparisons).then(() => {
			const snapshot = this.getSnapshot(resource);
			if (snapshot?.model || this._retainedAgentResources.has(resourceKey)) {
				return;
			}
			this._registry.delete(resource);
			this._lastResults.delete(resourceKey);
			for (const key of this._checkpoints.keys()) {
				if (key.endsWith(keySuffix)) {
					this._checkpoints.delete(key);
				}
			}
		});
	}

	private _laneKey(lane: string, resource: URI): string {
		return `${lane}:${this._key(resource)}`;
	}

	private _key(resource: URI): string {
		return this._options.getComparisonKey(this._options.canonicalize(resource));
	}
}

function createCheckpoint(snapshot: IUnifiedDocumentSnapshot<TextModelEditSource>): IUnifiedEditTrackerShadowCheckpoint {
	let maxTransitionId = snapshot.pendingReload?.id ?? 0;
	for (const transition of snapshot.transitions) {
		maxTransitionId = Math.max(maxTransitionId, transition.id);
	}
	return { content: snapshot.content, maxTransitionId };
}
