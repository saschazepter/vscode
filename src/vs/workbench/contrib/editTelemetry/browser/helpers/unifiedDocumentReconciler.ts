/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type UnifiedDocumentReconcileOutcome = 'applied' | 'duplicate' | 'conflict' | 'skippedDirty';

export type UnifiedDocumentTransitionKind = 'model' | 'reloadFromDisk' | 'agentHost' | 'diskSnapshot';

export type UnifiedDocumentAgentTransitionKind = 'create' | 'edit' | 'delete' | 'rename';

export interface IUnifiedDocumentModelState {
	readonly content: string;
	readonly dirty: boolean;
}

export interface IUnifiedDocumentModelEdit<TSource> {
	readonly before: string;
	readonly after: string;
	readonly source: TSource;
	readonly kind: 'model' | 'reloadFromDisk';
	readonly dirty: boolean;
}

export interface IUnifiedDocumentAgentTransition<TSource> {
	readonly before: string;
	readonly after: string;
	readonly source: TSource;
	readonly correlation: string;
	readonly kind: UnifiedDocumentAgentTransitionKind;
}

export interface IUnifiedDocumentTransition<TSource> {
	readonly id: number;
	readonly before: string;
	readonly after: string;
	readonly source: TSource;
	readonly kind: UnifiedDocumentTransitionKind;
	readonly correlation?: string;
	readonly agentKind?: UnifiedDocumentAgentTransitionKind;
}

export interface IUnifiedDocumentTransitionChange<TSource> {
	readonly kind: 'append' | 'replace';
	readonly transition: IUnifiedDocumentTransition<TSource>;
}

export interface IUnifiedDocumentSnapshot<TSource> {
	readonly initialContent: string;
	readonly content: string;
	readonly diskContent: string;
	readonly model: IUnifiedDocumentModelState | undefined;
	readonly pendingReload: IUnifiedDocumentTransition<TSource> | undefined;
	readonly transitions: readonly IUnifiedDocumentTransition<TSource>[];
}

export interface IUnifiedDocumentReconcileResult<TSource> {
	readonly outcome: UnifiedDocumentReconcileOutcome;
	readonly changes: readonly IUnifiedDocumentTransitionChange<TSource>[];
	readonly snapshot: IUnifiedDocumentSnapshot<TSource>;
}

/**
 * Reconciles model, Agent Host, and disk observations into one canonical edit sequence.
 */
export class UnifiedDocumentReconciler<TSource> {
	private readonly _initialContent: string;
	private _content: string;
	private _diskContent: string;
	private _model: IUnifiedDocumentModelState | undefined;
	private _pendingReload: IUnifiedDocumentTransition<TSource> | undefined;
	private readonly _transitions: IUnifiedDocumentTransition<TSource>[] = [];
	private readonly _agentCorrelations = new Map<string, { readonly before: string; readonly after: string; readonly outcome: UnifiedDocumentReconcileOutcome }>();
	private _nextTransitionId = 1;

	constructor(
		initialContent: string,
		private readonly _externalSource: TSource,
	) {
		this._initialContent = initialContent;
		this._content = initialContent;
		this._diskContent = initialContent;
	}

	modelConnected(state: IUnifiedDocumentModelState): IUnifiedDocumentReconcileResult<TSource> {
		if (this._model) {
			return this._result('conflict');
		}

		this._model = { ...state };
		if (state.content === this._content) {
			return this._result('applied');
		}
		if (state.dirty) {
			return this._result('skippedDirty');
		}
		const latestAgentTransition = this._findLatestTransition('agentHost');
		if (
			latestAgentTransition?.before === state.content &&
			latestAgentTransition.after === this._content &&
			this._diskContent === this._content
		) {
			return this._result('applied');
		}
		if (state.content !== this._diskContent) {
			return this._result('conflict');
		}

		const changes = this._commitPendingReload();
		changes.push(this._appendTransition(this._content, state.content, this._externalSource, 'diskSnapshot'));
		this._content = state.content;
		return this._result('applied', changes);
	}

	modelDisconnected(): IUnifiedDocumentReconcileResult<TSource> {
		if (!this._model) {
			return this._result('duplicate');
		}
		this._model = undefined;
		return this._result('applied');
	}

	modelEdit(edit: IUnifiedDocumentModelEdit<TSource>): IUnifiedDocumentReconcileResult<TSource> {
		if (!this._model || this._model.content !== edit.before) {
			return this._result('conflict');
		}

		if (edit.kind === 'reloadFromDisk') {
			const matchingAgentTransition = this._findTransition(edit.before, edit.after, 'agentHost');
			if (matchingAgentTransition && this._content === edit.after && this._diskContent === edit.after) {
				this._model = { content: edit.after, dirty: edit.dirty };
				this._diskContent = edit.after;
				return this._result('duplicate');
			}
			const matchingExternalTransition = this._findExternalTransition(edit.before, edit.after);
			if (matchingExternalTransition && this._content === edit.after && this._diskContent === edit.after) {
				this._model = { content: edit.after, dirty: edit.dirty };
				return this._result('duplicate');
			}
			if (this._pendingReload && isSameContentTransition(this._pendingReload, edit)) {
				this._model = { content: edit.after, dirty: edit.dirty };
				this._diskContent = edit.after;
				this._content = edit.after;
				return this._result('duplicate');
			}
		}

		const changes = this._commitPendingReload();
		if (this._content !== edit.before) {
			this._model = { content: edit.after, dirty: edit.dirty };
			if (edit.kind === 'reloadFromDisk') {
				this._diskContent = edit.after;
			}
			return this._result('conflict', changes);
		}

		this._model = { content: edit.after, dirty: edit.dirty };
		this._content = edit.after;
		if (edit.kind === 'reloadFromDisk') {
			this._diskContent = edit.after;
			this._pendingReload = this._createTransition(edit.before, edit.after, edit.source, edit.kind);
			return this._result('applied', changes);
		}

		if (edit.before === edit.after) {
			return this._result('duplicate', changes);
		}
		changes.push(this._appendTransition(edit.before, edit.after, edit.source, edit.kind));
		return this._result('applied', changes);
	}

	agentTransition(transition: IUnifiedDocumentAgentTransition<TSource>): IUnifiedDocumentReconcileResult<TSource> {
		const correlated = this._agentCorrelations.get(transition.correlation);
		if (correlated) {
			return this._result(
				correlated.before === transition.before && correlated.after === transition.after ? 'duplicate' : 'conflict'
			);
		}

		const existingAgentTransition = this._findTransition(transition.before, transition.after, 'agentHost');
		if (existingAgentTransition && this._content === transition.after && this._diskContent === transition.after) {
			this._recordAgentCorrelation(transition, 'duplicate');
			return this._result('duplicate');
		}

		const matchingExternalTransition = this._findExternalTransition(transition.before, transition.after);
		if (matchingExternalTransition && this._diskContent === transition.after) {
			const replacement = this._replaceWithAgentTransition(matchingExternalTransition, transition);
			this._recordAgentCorrelation(transition, 'applied');
			return this._result('applied', [{ kind: 'replace', transition: replacement }]);
		}

		if (this._pendingReload && isSameContentTransition(this._pendingReload, transition)) {
			const pendingReload = this._pendingReload;
			const appliedTransition: IUnifiedDocumentTransition<TSource> = {
				...pendingReload,
				source: transition.source,
				kind: 'agentHost',
				correlation: transition.correlation,
				agentKind: transition.kind,
			};
			this._pendingReload = undefined;
			this._transitions.push(appliedTransition);
			this._recordAgentCorrelation(transition, 'applied');
			return this._result('applied', [{ kind: 'append', transition: { ...appliedTransition } }]);
		}

		const changes = this._commitPendingReload();
		if (this._model?.dirty) {
			if (this._diskContent === transition.before) {
				this._diskContent = transition.after;
			}
			this._recordAgentCorrelation(transition, 'skippedDirty');
			return this._result('skippedDirty', changes);
		}
		if (this._diskContent !== transition.before || this._content !== transition.before) {
			return this._result('conflict', changes);
		}

		this._diskContent = transition.after;
		this._content = transition.after;
		this._recordAgentCorrelation(transition, 'applied');
		if (transition.before === transition.after) {
			return this._result('applied', changes);
		}
		changes.push(this._appendAgentTransition(transition));
		return this._result('applied', changes);
	}

	diskSnapshot(content: string): IUnifiedDocumentReconcileResult<TSource> {
		if (this._pendingReload && content === this._pendingReload.after) {
			const changes = this._commitPendingReload();
			this._diskContent = content;
			return this._result('applied', changes);
		}

		const changes = this._commitPendingReload();
		if (content === this._diskContent && content === this._content) {
			return this._result('duplicate', changes);
		}

		const previousDiskContent = this._diskContent;
		this._diskContent = content;
		const isModelSave = this._model?.dirty === true && content === this._model.content;
		if (isModelSave && this._model) {
			this._model = { content: this._model.content, dirty: false };
		}
		if (this._model?.dirty && content !== this._model.content) {
			return this._result('conflict', changes);
		}
		if (content === this._content) {
			return this._result('duplicate', changes);
		}
		if (!isModelSave && this._content !== previousDiskContent) {
			return this._result('conflict', changes);
		}

		changes.push(this._appendTransition(this._content, content, this._externalSource, 'diskSnapshot'));
		this._content = content;
		return this._result('applied', changes);
	}

	getSnapshot(): IUnifiedDocumentSnapshot<TSource> {
		return {
			initialContent: this._initialContent,
			content: this._content,
			diskContent: this._diskContent,
			model: this._model ? { ...this._model } : undefined,
			pendingReload: this._pendingReload ? { ...this._pendingReload } : undefined,
			transitions: this._transitions.map(transition => ({ ...transition })),
		};
	}

	private _commitPendingReload(): IUnifiedDocumentTransitionChange<TSource>[] {
		if (!this._pendingReload) {
			return [];
		}
		const transition = this._pendingReload;
		this._pendingReload = undefined;
		this._transitions.push(transition);
		return [{ kind: 'append', transition: { ...transition } }];
	}

	private _appendAgentTransition(transition: IUnifiedDocumentAgentTransition<TSource>): IUnifiedDocumentTransitionChange<TSource> {
		return this._appendTransition(transition.before, transition.after, transition.source, 'agentHost', transition.correlation, transition.kind);
	}

	private _appendTransition(
		before: string,
		after: string,
		source: TSource,
		kind: UnifiedDocumentTransitionKind,
		correlation?: string,
		agentKind?: UnifiedDocumentAgentTransitionKind,
	): IUnifiedDocumentTransitionChange<TSource> {
		const transition = this._createTransition(before, after, source, kind, correlation, agentKind);
		this._transitions.push(transition);
		return { kind: 'append', transition: { ...transition } };
	}

	private _createTransition(
		before: string,
		after: string,
		source: TSource,
		kind: UnifiedDocumentTransitionKind,
		correlation?: string,
		agentKind?: UnifiedDocumentAgentTransitionKind,
	): IUnifiedDocumentTransition<TSource> {
		return {
			id: this._nextTransitionId++,
			before,
			after,
			source,
			kind,
			correlation,
			agentKind,
		};
	}

	private _findTransition(before: string, after: string, kind: UnifiedDocumentTransitionKind): IUnifiedDocumentTransition<TSource> | undefined {
		for (let index = this._transitions.length - 1; index >= 0; index--) {
			const transition = this._transitions[index];
			if (transition.kind === kind && transition.before === before && transition.after === after) {
				return transition;
			}
		}
		return undefined;
	}

	private _findLatestTransition(kind: UnifiedDocumentTransitionKind): IUnifiedDocumentTransition<TSource> | undefined {
		for (let index = this._transitions.length - 1; index >= 0; index--) {
			const transition = this._transitions[index];
			if (transition.kind === kind) {
				return transition;
			}
		}
		return undefined;
	}

	private _findExternalTransition(before: string, after: string): IUnifiedDocumentTransition<TSource> | undefined {
		for (let index = this._transitions.length - 1; index >= 0; index--) {
			const transition = this._transitions[index];
			if (
				(transition.kind === 'reloadFromDisk' || transition.kind === 'diskSnapshot') &&
				transition.before === before &&
				transition.after === after
			) {
				return transition;
			}
		}
		return undefined;
	}

	private _replaceWithAgentTransition(
		existing: IUnifiedDocumentTransition<TSource>,
		agentTransition: IUnifiedDocumentAgentTransition<TSource>,
	): IUnifiedDocumentTransition<TSource> {
		const replacement: IUnifiedDocumentTransition<TSource> = {
			...existing,
			source: agentTransition.source,
			kind: 'agentHost',
			correlation: agentTransition.correlation,
			agentKind: agentTransition.kind,
		};
		const index = this._transitions.findIndex(transition => transition.id === existing.id);
		this._transitions[index] = replacement;
		return replacement;
	}

	private _recordAgentCorrelation(transition: IUnifiedDocumentAgentTransition<TSource>, outcome: UnifiedDocumentReconcileOutcome): void {
		this._agentCorrelations.set(transition.correlation, {
			before: transition.before,
			after: transition.after,
			outcome,
		});
	}

	private _result(
		outcome: UnifiedDocumentReconcileOutcome,
		changes: readonly IUnifiedDocumentTransitionChange<TSource>[] = [],
	): IUnifiedDocumentReconcileResult<TSource> {
		return {
			outcome,
			changes,
			snapshot: this.getSnapshot(),
		};
	}
}

function isSameContentTransition(
	first: { readonly before: string; readonly after: string },
	second: { readonly before: string; readonly after: string },
): boolean {
	return first.before === second.before && first.after === second.after;
}
