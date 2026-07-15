/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import {
	IUnifiedDocumentAgentTransition,
	IUnifiedDocumentModelEdit,
	IUnifiedDocumentModelState,
	IUnifiedDocumentReconcileResult,
	UnifiedDocumentReconcileOutcome,
	UnifiedDocumentReconciler,
} from './unifiedDocumentReconciler.js';

export interface IUnifiedDocumentRegistryOptions<TSource> {
	readonly externalSource: TSource;
	readonly canonicalize: (resource: URI) => URI;
	readonly getComparisonKey: (resource: URI) => string;
}

export interface IUnifiedDocumentRegistryEntry<TSource> {
	readonly resource: URI;
	readonly reconciler: UnifiedDocumentReconciler<TSource>;
}

export interface IUnifiedDocumentRegistryResult<TSource> {
	readonly outcome: UnifiedDocumentReconcileOutcome;
	readonly resource: URI;
	readonly reconcileResult?: IUnifiedDocumentReconcileResult<TSource>;
}

class UnifiedDocumentRegistryEntry<TSource> implements IUnifiedDocumentRegistryEntry<TSource> {
	constructor(
		public resource: URI,
		readonly reconciler: UnifiedDocumentReconciler<TSource>,
	) { }
}

/**
 * Owns one unified reconciler per canonical resource identity.
 */
export class UnifiedDocumentRegistry<TSource> {
	private readonly _entries = new Map<string, UnifiedDocumentRegistryEntry<TSource>>();

	constructor(private readonly _options: IUnifiedDocumentRegistryOptions<TSource>) { }

	get size(): number {
		return this._entries.size;
	}

	get(resource: URI): IUnifiedDocumentRegistryEntry<TSource> | undefined {
		return this._entries.get(this._key(resource));
	}

	entries(): readonly IUnifiedDocumentRegistryEntry<TSource>[] {
		return Array.from(this._entries.values());
	}

	modelConnected(resource: URI, initialContent: string, state: IUnifiedDocumentModelState): IUnifiedDocumentRegistryResult<TSource> {
		const entry = this._getOrCreate(resource, initialContent);
		return this._wrap(entry, entry.reconciler.modelConnected(state));
	}

	modelDisconnected(resource: URI): IUnifiedDocumentRegistryResult<TSource> {
		const canonicalResource = this._canonicalize(resource);
		const entry = this._entries.get(this._key(canonicalResource));
		if (!entry) {
			return { outcome: 'duplicate', resource: canonicalResource };
		}
		return this._wrap(entry, entry.reconciler.modelDisconnected());
	}

	modelEdit(resource: URI, edit: IUnifiedDocumentModelEdit<TSource>): IUnifiedDocumentRegistryResult<TSource> {
		const canonicalResource = this._canonicalize(resource);
		const entry = this._entries.get(this._key(canonicalResource));
		if (!entry) {
			return { outcome: 'conflict', resource: canonicalResource };
		}
		return this._wrap(entry, entry.reconciler.modelEdit(edit));
	}

	agentTransition(resource: URI, transition: IUnifiedDocumentAgentTransition<TSource>): IUnifiedDocumentRegistryResult<TSource> {
		const entry = this._getOrCreate(resource, transition.before);
		return this._wrap(entry, entry.reconciler.agentTransition(transition));
	}

	diskSnapshot(resource: URI, content: string): IUnifiedDocumentRegistryResult<TSource> {
		const entry = this._getOrCreate(resource, content);
		return this._wrap(entry, entry.reconciler.diskSnapshot(content));
	}

	transfer(previousResource: URI, resource: URI): IUnifiedDocumentRegistryResult<TSource> {
		const canonicalPreviousResource = this._canonicalize(previousResource);
		const canonicalResource = this._canonicalize(resource);
		const previousKey = this._key(canonicalPreviousResource);
		const key = this._key(canonicalResource);
		const entry = this._entries.get(previousKey);
		if (!entry) {
			return { outcome: 'conflict', resource: canonicalResource };
		}
		if (previousKey === key) {
			entry.resource = canonicalResource;
			return { outcome: 'duplicate', resource: canonicalResource };
		}
		if (this._entries.has(key)) {
			return { outcome: 'conflict', resource: canonicalResource };
		}

		this._entries.delete(previousKey);
		entry.resource = canonicalResource;
		this._entries.set(key, entry);
		return { outcome: 'applied', resource: canonicalResource };
	}

	delete(resource: URI): boolean {
		return this._entries.delete(this._key(resource));
	}

	clear(): void {
		this._entries.clear();
	}

	private _getOrCreate(resource: URI, initialContent: string): UnifiedDocumentRegistryEntry<TSource> {
		const canonicalResource = this._canonicalize(resource);
		const key = this._key(canonicalResource);
		let entry = this._entries.get(key);
		if (!entry) {
			entry = new UnifiedDocumentRegistryEntry(
				canonicalResource,
				new UnifiedDocumentReconciler(initialContent, this._options.externalSource),
			);
			this._entries.set(key, entry);
		}
		return entry;
	}

	private _canonicalize(resource: URI): URI {
		return this._options.canonicalize(resource);
	}

	private _key(resource: URI): string {
		return this._options.getComparisonKey(this._canonicalize(resource));
	}

	private _wrap(
		entry: UnifiedDocumentRegistryEntry<TSource>,
		reconcileResult: IUnifiedDocumentReconcileResult<TSource>,
	): IUnifiedDocumentRegistryResult<TSource> {
		return {
			outcome: reconcileResult.outcome,
			resource: entry.resource,
			reconcileResult,
		};
	}
}
