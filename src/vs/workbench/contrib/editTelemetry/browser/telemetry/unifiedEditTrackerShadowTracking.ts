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
	compareEditTrackerSnapshots,
	IEditTrackerShadowComparison,
	IEditTrackerSnapshot,
	projectUnifiedDocumentTracker,
	UnifiedDocumentComputeDiff,
} from './unifiedDocumentTrackerProjection.js';

export interface IUnifiedEditTrackerShadowTrackingOptions {
	readonly isDirty: (resource: URI) => boolean;
	readonly canonicalize: (resource: URI) => URI;
	readonly getComparisonKey: (resource: URI) => string;
}

export interface IUnifiedEditTrackerShadowComparisonResult {
	readonly candidate: IEditTrackerSnapshot;
	readonly comparison: IEditTrackerShadowComparison;
}

/**
 * Mirrors live edit inputs into the unified registry without affecting production telemetry.
 */
export class UnifiedEditTrackerShadowTracking extends Disposable {
	private readonly _registry: UnifiedDocumentRegistry<TextModelEditSource>;
	private readonly _lastResults = new Map<string, IUnifiedDocumentRegistryResult<TextModelEditSource>>();

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
				result => this._recordResult(result.result),
			));
		}).recomputeInitiallyAndOnChange(this._store);
	}

	applyAgentEdit(edit: IUnifiedDocumentAgentEdit<TextModelEditSource>): IUnifiedDocumentAgentAdapterResult<TextModelEditSource> {
		const result = applyUnifiedDocumentAgentEdit(this._registry, edit);
		this._recordResult(result.transitionResult);
		if (result.transferResult) {
			if (edit.previousResource) {
				this._lastResults.delete(this._key(edit.previousResource));
			}
			this._recordResult(result.transferResult);
		}
		return result;
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

	async compare(
		resource: URI,
		reference: IEditTrackerSnapshot,
		computeDiff: UnifiedDocumentComputeDiff,
	): Promise<IUnifiedEditTrackerShadowComparisonResult | undefined> {
		const candidate = await this.project(resource, computeDiff);
		if (!candidate) {
			return undefined;
		}
		return {
			candidate,
			comparison: compareEditTrackerSnapshots(reference, candidate),
		};
	}

	private _recordResult(result: IUnifiedDocumentRegistryResult<TextModelEditSource>): void {
		this._lastResults.set(this._key(result.resource), result);
	}

	private _key(resource: URI): string {
		return this._options.getComparisonKey(this._options.canonicalize(resource));
	}
}
