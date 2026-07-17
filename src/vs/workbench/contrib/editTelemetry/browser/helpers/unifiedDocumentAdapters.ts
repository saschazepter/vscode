/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { runOnChange } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { IObservableDocument, StringEditWithReason } from './observableWorkspace.js';
import {
	IUnifiedDocumentRegistryResult,
	UnifiedDocumentRegistry,
} from './unifiedDocumentRegistry.js';
import { UnifiedDocumentAgentTransitionKind } from './unifiedDocumentReconciler.js';

export type UnifiedDocumentModelAdapterInputKind = 'connected' | 'edit' | 'reloadFromDisk' | 'disconnected';

export interface IUnifiedDocumentModelAdapterResult<TSource> {
	readonly inputKind: UnifiedDocumentModelAdapterInputKind;
	readonly result: IUnifiedDocumentRegistryResult<TSource>;
}

/**
 * Translates one observable model into unified registry inputs.
 */
export class UnifiedDocumentModelAdapter<TSource> extends Disposable {
	private _isDisposed = false;

	constructor(
		private readonly _registry: UnifiedDocumentRegistry<TSource>,
		private readonly _document: IObservableDocument,
		initialDiskContent: string,
		private readonly _isDirty: () => boolean,
		private readonly _toSource: (change: StringEditWithReason) => TSource,
		private readonly _onResult: (result: IUnifiedDocumentModelAdapterResult<TSource>) => void,
	) {
		super();
		this._onResult({
			inputKind: 'connected',
			result: this._registry.modelConnected(
				this._document.uri,
				initialDiskContent,
				{ content: this._document.value.get().value, dirty: this._isDirty() },
			),
		});

		this._register(runOnChange(this._document.value, (value, previousValue, changes) => {
			let before = previousValue.value;
			for (const change of changes) {
				const after = change.apply(before);
				const inputKind = change.reason.metadata.source === 'reloadFromDisk' ? 'reloadFromDisk' : 'edit';
				this._onResult({
					inputKind,
					result: this._registry.modelEdit(this._document.uri, {
						before,
						after,
						source: this._toSource(change),
						kind: inputKind === 'reloadFromDisk' ? 'reloadFromDisk' : 'model',
						dirty: this._isDirty(),
					}),
				});
				before = after;
			}
			if (before !== value.value) {
				throw new Error(`Unified document model adapter produced ${JSON.stringify(before)}, expected ${JSON.stringify(value.value)}`);
			}
		}));
	}

	override dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		super.dispose();
		this._onResult({
			inputKind: 'disconnected',
			result: this._registry.modelDisconnected(this._document.uri),
		});
	}
}

export interface IUnifiedDocumentAgentEdit<TSource> {
	readonly resource: URI;
	readonly previousResource?: URI;
	readonly before: string;
	readonly after: string;
	readonly source: TSource;
	readonly correlation: string;
	readonly kind: UnifiedDocumentAgentTransitionKind;
}

export interface IUnifiedDocumentAgentAdapterResult<TSource> {
	readonly transitionResult: IUnifiedDocumentRegistryResult<TSource>;
	readonly transferResult?: IUnifiedDocumentRegistryResult<TSource>;
}

/**
 * Applies one normalized Agent Host edit to the unified registry.
 */
export function applyUnifiedDocumentAgentEdit<TSource>(
	registry: UnifiedDocumentRegistry<TSource>,
	edit: IUnifiedDocumentAgentEdit<TSource>,
): IUnifiedDocumentAgentAdapterResult<TSource> {
	const transitionResource = edit.kind === 'rename' && edit.previousResource ? edit.previousResource : edit.resource;
	const transitionResult = registry.agentTransition(transitionResource, {
		before: edit.before,
		after: edit.after,
		source: edit.source,
		correlation: edit.correlation,
		kind: edit.kind,
	});
	if (
		edit.kind !== 'rename' ||
		!edit.previousResource ||
		transitionResult.outcome === 'conflict' ||
		transitionResult.outcome === 'skippedDirty'
	) {
		return { transitionResult };
	}

	return {
		transitionResult,
		transferResult: registry.transfer(edit.previousResource, edit.resource),
	};
}
