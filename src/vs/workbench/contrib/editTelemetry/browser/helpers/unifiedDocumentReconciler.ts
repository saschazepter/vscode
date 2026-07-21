/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { stringHash } from '../../../../../base/common/hash.js';
import { hasKey } from '../../../../../base/common/types.js';
import { OffsetRange } from '../../../../../editor/common/core/ranges/offsetRange.js';
import { StringEdit, StringReplacement } from '../../../../../editor/common/core/edits/stringEdit.js';

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
	readonly edit: StringEdit;
	readonly source: TSource;
	readonly kind: 'model' | 'reloadFromDisk';
	readonly dirty: boolean;
}

export interface IUnifiedDocumentAgentTransition<TSource> {
	readonly before: string;
	readonly after: string;
	readonly edit: StringEdit;
	readonly source: TSource;
	readonly correlation: string;
	readonly kind: UnifiedDocumentAgentTransitionKind;
}

export interface IUnifiedDocumentTransition<TSource> {
	readonly id: number;
	readonly edit: StringEdit;
	readonly source: TSource;
	readonly kind: UnifiedDocumentTransitionKind;
	readonly correlation?: string;
	readonly agentKind?: UnifiedDocumentAgentTransitionKind;
}

export interface IUnifiedDocumentTransitionChange<TSource> {
	readonly kind: 'append' | 'replace';
	readonly before: string;
	readonly after: string;
	readonly transition: IUnifiedDocumentTransition<TSource>;
}

export interface IUnifiedDocumentPendingReload<TSource> {
	readonly before: string;
	readonly after: string;
	readonly transition: IUnifiedDocumentTransition<TSource>;
}

export interface IUnifiedDocumentSnapshot<TSource> {
	readonly initialContent: string;
	readonly content: string;
	readonly diskContent: string;
	readonly model: IUnifiedDocumentModelState | undefined;
	readonly pendingReload: IUnifiedDocumentPendingReload<TSource> | undefined;
	readonly pendingAgentTransitions: boolean;
	readonly transitions: readonly IUnifiedDocumentTransition<TSource>[];
}

export interface IUnifiedDocumentReconcileResult<TSource> {
	readonly outcome: UnifiedDocumentReconcileOutcome;
	readonly changes: readonly IUnifiedDocumentTransitionChange<TSource>[];
	readonly snapshot: IUnifiedDocumentSnapshot<TSource>;
}

interface IRecentTransition<TSource> {
	readonly beforeId: string;
	readonly afterId: string;
	readonly transition: IUnifiedDocumentTransition<TSource>;
}

interface IRecentExternalTransition<TSource> extends IRecentTransition<TSource> {
	readonly after: string;
}

interface IAgentCorrelation {
	readonly beforeId: string;
	readonly afterId: string;
	readonly outcome: UnifiedDocumentReconcileOutcome;
}

const MAX_AGENT_CORRELATIONS = 128;
const MAX_RECENT_AGENT_TRANSITIONS = 128;

/**
 * Reconciles model, Agent Host, and disk observations into one canonical edit sequence.
 */
export class UnifiedDocumentReconciler<TSource> {
	private _initialContent: string;
	private _content: string;
	private _diskContent: string;
	private _model: IUnifiedDocumentModelState | undefined;
	private _pendingReload: IUnifiedDocumentPendingReload<TSource> | undefined;
	private readonly _transitions: IUnifiedDocumentTransition<TSource>[] = [];
	private readonly _agentCorrelations = new Map<string, IAgentCorrelation>();
	private _recentAgentTransition: IRecentTransition<TSource> | undefined;
	private readonly _recentAgentTransitions: IRecentTransition<TSource>[] = [];
	private _recentExternalTransition: IRecentExternalTransition<TSource> | undefined;
	private readonly _recentExternalAgentTransitions: IUnifiedDocumentAgentTransition<TSource>[] = [];
	private readonly _pendingReloadAgentTransitions: IUnifiedDocumentAgentTransition<TSource>[] = [];
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
		const changes = this._commitRecentExternalAgentTransitions();
		if (state.content === this._content) {
			return this._result('applied', changes);
		}
		if (state.dirty) {
			return this._result('skippedDirty', changes);
		}
		if (this._isRecentAgentTransition(state.content, this._content) && this._diskContent === this._content) {
			return this._result('applied', changes);
		}
		if (state.content !== this._diskContent) {
			return this._result('conflict', changes);
		}

		changes.push(...this._commitPendingReload());
		changes.push(this._appendTransition(
			this._content,
			state.content,
			createMinimalEdit(this._content, state.content),
			this._externalSource,
			'diskSnapshot',
		));
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
		const recentExternalChanges = this._commitRecentExternalAgentTransitions();

		if (edit.kind === 'reloadFromDisk') {
			if (this._isRecentAgentTransition(edit.before, edit.after) && this._content === edit.after && this._diskContent === edit.after) {
				this._model = { content: edit.after, dirty: edit.dirty };
				this._diskContent = edit.after;
				return this._result('duplicate', recentExternalChanges);
			}
			if (isSameContentTransition(this._recentExternalTransition, edit) && this._content === edit.after && this._diskContent === edit.after) {
				this._model = { content: edit.after, dirty: edit.dirty };
				return this._result('duplicate', recentExternalChanges);
			}
			if (isSameContentTransition(this._pendingReload, edit)) {
				this._model = { content: edit.after, dirty: edit.dirty };
				this._diskContent = edit.after;
				this._content = edit.after;
				return this._result('duplicate', recentExternalChanges);
			}
		}

		const changes = [...recentExternalChanges, ...this._commitPendingReload()];
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
			this._pendingReload = {
				before: edit.before,
				after: edit.after,
				transition: this._createTransition(edit.edit, edit.source, edit.kind),
			};
			this._pendingReloadAgentTransitions.length = 0;
			return this._result('applied', changes);
		}

		if (edit.before === edit.after) {
			return this._result('duplicate', changes);
		}
		changes.push(this._appendTransition(edit.before, edit.after, edit.edit, edit.source, edit.kind));
		return this._result('applied', changes);
	}

	agentTransition(transition: IUnifiedDocumentAgentTransition<TSource>): IUnifiedDocumentReconcileResult<TSource> {
		const correlated = this._agentCorrelations.get(transition.correlation);
		if (correlated) {
			return this._result(
				correlated.beforeId === contentId(transition.before) && correlated.afterId === contentId(transition.after) ? 'duplicate' : 'conflict'
			);
		}

		if (
			isSameContentTransition(this._recentAgentTransition, transition) &&
			this._content === transition.after &&
			this._diskContent === transition.after
		) {
			this._recordAgentCorrelation(transition, 'duplicate');
			return this._result('duplicate');
		}

		const recentExternalTransition = this._recentExternalTransition;
		if (recentExternalTransition && isSameContentTransition(recentExternalTransition, transition) && this._diskContent === transition.after) {
			const replacement = this._replaceWithAgentTransition(recentExternalTransition, transition);
			if (replacement) {
				this._recordAgentCorrelation(transition, 'applied');
				return this._result('applied', [replacement]);
			}
		}
		const recentExternalAgentResult = this._applyRecentExternalAgentTransition(transition);
		if (recentExternalAgentResult) {
			return recentExternalAgentResult;
		}

		const pendingReloadResult = this._applyPendingReloadAgentTransition(transition);
		if (pendingReloadResult) {
			return pendingReloadResult;
		}

		const changes = [...this._commitRecentExternalAgentTransitions(), ...this._commitPendingReload()];
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

	diskSnapshot(content: string, edit: StringEdit): IUnifiedDocumentReconcileResult<TSource> {
		const recentExternalChanges = this._commitRecentExternalAgentTransitions();
		if (this._pendingReload && content === this._pendingReload.after) {
			const changes = [...recentExternalChanges, ...this._commitPendingReload()];
			this._diskContent = content;
			return this._result('applied', changes);
		}

		const changes = [...recentExternalChanges, ...this._commitPendingReload()];
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

		changes.push(this._appendTransition(this._content, content, edit, this._externalSource, 'diskSnapshot'));
		this._content = content;
		return this._result('applied', changes);
	}

	resetWindow(): void {
		this._initialContent = this._content;
		this._transitions.length = 0;
		this._recentExternalTransition = undefined;
		this._recentExternalAgentTransitions.length = 0;
	}

	getSnapshot(): IUnifiedDocumentSnapshot<TSource> {
		return {
			initialContent: this._initialContent,
			content: this._content,
			diskContent: this._diskContent,
			model: this._model ? { ...this._model } : undefined,
			pendingReload: this._pendingReload ? {
				...this._pendingReload,
				transition: { ...this._pendingReload.transition },
			} : undefined,
			pendingAgentTransitions: this._pendingReloadAgentTransitions.length > 0 || this._recentExternalAgentTransitions.length > 0,
			transitions: this._transitions.map(transition => ({ ...transition })),
		};
	}

	private _commitPendingReload(): IUnifiedDocumentTransitionChange<TSource>[] {
		if (!this._pendingReload) {
			return [];
		}
		const pendingReload = this._pendingReload;
		this._pendingReload = undefined;
		const agentTransitions = this._pendingReloadAgentTransitions.splice(0);
		if (agentTransitions.length > 0) {
			const changes = agentTransitions.map(transition => this._appendAgentTransition(transition));
			const agentAfter = agentTransitions[agentTransitions.length - 1].after;
			if (agentAfter !== pendingReload.after) {
				changes.push(this._appendTransition(
					agentAfter,
					pendingReload.after,
					createMinimalEdit(agentAfter, pendingReload.after),
					this._externalSource,
					'reloadFromDisk',
				));
			}
			return changes;
		}
		this._transitions.push(pendingReload.transition);
		this._recentExternalTransition = createRecentExternalTransition(
			pendingReload.before,
			pendingReload.after,
			pendingReload.transition,
		);
		return [{
			kind: 'append',
			before: pendingReload.before,
			after: pendingReload.after,
			transition: { ...pendingReload.transition },
		}];
	}

	private _appendAgentTransition(transition: IUnifiedDocumentAgentTransition<TSource>): IUnifiedDocumentTransitionChange<TSource> {
		return this._appendTransition(
			transition.before,
			transition.after,
			transition.edit,
			transition.source,
			'agentHost',
			transition.correlation,
			transition.kind,
		);
	}

	private _appendTransition(
		before: string,
		after: string,
		edit: StringEdit,
		source: TSource,
		kind: UnifiedDocumentTransitionKind,
		correlation?: string,
		agentKind?: UnifiedDocumentAgentTransitionKind,
	): IUnifiedDocumentTransitionChange<TSource> {
		const transition = this._createTransition(edit, source, kind, correlation, agentKind);
		this._transitions.push(transition);
		const recent = createRecentTransition(before, after, transition);
		if (kind === 'agentHost') {
			this._recordRecentAgentTransition(recent);
			this._recentExternalTransition = undefined;
			this._recentExternalAgentTransitions.length = 0;
		} else if (kind === 'reloadFromDisk' || kind === 'diskSnapshot') {
			this._recentExternalTransition = createRecentExternalTransition(before, after, transition);
			this._recentExternalAgentTransitions.length = 0;
		}
		return { kind: 'append', before, after, transition: { ...transition } };
	}

	private _createTransition(
		edit: StringEdit,
		source: TSource,
		kind: UnifiedDocumentTransitionKind,
		correlation?: string,
		agentKind?: UnifiedDocumentAgentTransitionKind,
	): IUnifiedDocumentTransition<TSource> {
		return {
			id: this._nextTransitionId++,
			edit,
			source,
			kind,
			correlation,
			agentKind,
		};
	}

	private _replaceWithAgentTransition(
		existing: IRecentTransition<TSource>,
		agentTransition: IUnifiedDocumentAgentTransition<TSource>,
	): IUnifiedDocumentTransitionChange<TSource> | undefined {
		const index = this._transitions.findIndex(transition => transition.id === existing.transition.id);
		if (index < 0) {
			return undefined;
		}
		const replacement: IUnifiedDocumentTransition<TSource> = {
			...existing.transition,
			edit: agentTransition.edit,
			source: agentTransition.source,
			kind: 'agentHost',
			correlation: agentTransition.correlation,
			agentKind: agentTransition.kind,
		};
		this._transitions[index] = replacement;
		this._recordRecentAgentTransition(createRecentTransition(agentTransition.before, agentTransition.after, replacement));
		this._recentExternalTransition = undefined;
		this._recentExternalAgentTransitions.length = 0;
		return {
			kind: 'replace',
			before: agentTransition.before,
			after: agentTransition.after,
			transition: { ...replacement },
		};
	}

	private _applyPendingReloadAgentTransition(
		transition: IUnifiedDocumentAgentTransition<TSource>,
	): IUnifiedDocumentReconcileResult<TSource> | undefined {
		const pendingReload = this._pendingReload;
		if (!pendingReload || this._pendingReloadAgentTransitions.length >= MAX_RECENT_AGENT_TRANSITIONS) {
			return undefined;
		}
		const expectedBefore = this._pendingReloadAgentTransitions.length > 0
			? this._pendingReloadAgentTransitions[this._pendingReloadAgentTransitions.length - 1].after
			: pendingReload.before;
		if (transition.before !== expectedBefore) {
			return undefined;
		}

		this._pendingReloadAgentTransitions.push(transition);
		this._recordAgentCorrelation(transition, 'applied');
		if (transition.after !== pendingReload.after) {
			return this._result('applied');
		}

		this._pendingReload = undefined;
		const agentTransitions = this._pendingReloadAgentTransitions.splice(0);
		return this._result('applied', agentTransitions.map(agentTransition => this._appendAgentTransition(agentTransition)));
	}

	private _isRecentAgentTransition(before: string, after: string): boolean {
		if (isSameContentTransition(this._recentAgentTransition, { before, after })) {
			return true;
		}
		const last = this._recentAgentTransitions[this._recentAgentTransitions.length - 1];
		if (!last || last.afterId !== contentId(after)) {
			return false;
		}
		const beforeId = contentId(before);
		return this._recentAgentTransitions.some(transition => transition.beforeId === beforeId);
	}

	private _recordRecentAgentTransition(transition: IRecentTransition<TSource>): void {
		const previous = this._recentAgentTransitions[this._recentAgentTransitions.length - 1];
		if (previous && previous.afterId !== transition.beforeId) {
			this._recentAgentTransitions.length = 0;
		}
		this._recentAgentTransitions.push(transition);
		if (this._recentAgentTransitions.length > MAX_RECENT_AGENT_TRANSITIONS) {
			this._recentAgentTransitions.shift();
		}
		this._recentAgentTransition = transition;
	}

	private _applyRecentExternalAgentTransition(
		transition: IUnifiedDocumentAgentTransition<TSource>,
	): IUnifiedDocumentReconcileResult<TSource> | undefined {
		const recentExternalTransition = this._recentExternalTransition;
		if (!recentExternalTransition || this._recentExternalAgentTransitions.length >= MAX_RECENT_AGENT_TRANSITIONS) {
			return undefined;
		}
		const correlated = this._recentExternalAgentTransitions.find(candidate => candidate.correlation === transition.correlation);
		if (correlated) {
			return this._result(isSameContentTransition(correlated, transition) ? 'duplicate' : 'conflict');
		}
		const expectedBeforeId = this._recentExternalAgentTransitions.length > 0
			? contentId(this._recentExternalAgentTransitions[this._recentExternalAgentTransitions.length - 1].after)
			: recentExternalTransition.beforeId;
		if (contentId(transition.before) !== expectedBeforeId) {
			return undefined;
		}

		this._recentExternalAgentTransitions.push(transition);
		if (contentId(transition.after) !== recentExternalTransition.afterId) {
			return this._result('applied');
		}

		const changes = this._replaceExternalWithAgentTransitions(recentExternalTransition, this._recentExternalAgentTransitions.splice(0));
		return changes ? this._result('applied', changes) : undefined;
	}

	private _commitRecentExternalAgentTransitions(): IUnifiedDocumentTransitionChange<TSource>[] {
		const recentExternalTransition = this._recentExternalTransition;
		if (!recentExternalTransition) {
			this._recentExternalAgentTransitions.length = 0;
			return [];
		}
		if (this._recentExternalAgentTransitions.length === 0) {
			return [];
		}
		return this._replaceExternalWithAgentTransitions(recentExternalTransition, this._recentExternalAgentTransitions.splice(0)) ?? [];
	}

	private _replaceExternalWithAgentTransitions(
		existing: IRecentExternalTransition<TSource>,
		agentTransitions: IUnifiedDocumentAgentTransition<TSource>[],
	): IUnifiedDocumentTransitionChange<TSource>[] | undefined {
		const index = this._transitions.findIndex(transition => transition.id === existing.transition.id);
		if (index < 0 || agentTransitions.length === 0) {
			return undefined;
		}

		const replacements = agentTransitions.map((agentTransition, agentIndex): IUnifiedDocumentTransition<TSource> => ({
			...(agentIndex === 0 ? existing.transition : this._createTransition(agentTransition.edit, agentTransition.source, 'agentHost')),
			edit: agentTransition.edit,
			source: agentTransition.source,
			kind: 'agentHost',
			correlation: agentTransition.correlation,
			agentKind: agentTransition.kind,
		}));
		const changes: IUnifiedDocumentTransitionChange<TSource>[] = replacements.map((replacement, replacementIndex) => ({
			kind: replacementIndex === 0 ? 'replace' : 'append',
			before: agentTransitions[replacementIndex].before,
			after: agentTransitions[replacementIndex].after,
			transition: { ...replacement },
		}));
		const agentAfter = agentTransitions[agentTransitions.length - 1].after;
		if (contentId(agentAfter) !== existing.afterId) {
			const externalRemainder = this._createTransition(
				createMinimalEdit(agentAfter, existing.after),
				existing.transition.source,
				existing.transition.kind,
			);
			replacements.push(externalRemainder);
			changes.push({
				kind: 'append',
				before: agentAfter,
				after: existing.after,
				transition: { ...externalRemainder },
			});
			this._recentExternalTransition = createRecentExternalTransition(agentAfter, existing.after, externalRemainder);
		} else {
			this._recentExternalTransition = undefined;
		}

		this._transitions.splice(index, 1, ...replacements);
		for (let agentIndex = 0; agentIndex < agentTransitions.length; agentIndex++) {
			this._recordRecentAgentTransition(createRecentTransition(
				agentTransitions[agentIndex].before,
				agentTransitions[agentIndex].after,
				replacements[agentIndex],
			));
			this._recordAgentCorrelation(agentTransitions[agentIndex], 'applied');
		}
		return changes;
	}

	private _recordAgentCorrelation(transition: IUnifiedDocumentAgentTransition<TSource>, outcome: UnifiedDocumentReconcileOutcome): void {
		this._agentCorrelations.delete(transition.correlation);
		this._agentCorrelations.set(transition.correlation, {
			beforeId: contentId(transition.before),
			afterId: contentId(transition.after),
			outcome,
		});
		if (this._agentCorrelations.size > MAX_AGENT_CORRELATIONS) {
			const oldestCorrelation = this._agentCorrelations.keys().next().value;
			if (oldestCorrelation !== undefined) {
				this._agentCorrelations.delete(oldestCorrelation);
			}
		}
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
	left: { readonly before: string; readonly after: string } | IRecentTransition<unknown> | undefined,
	right: { readonly before: string; readonly after: string },
): boolean {
	if (!left) {
		return false;
	}
	if (hasKey(left, { beforeId: true })) {
		return left.beforeId === contentId(right.before) && left.afterId === contentId(right.after);
	}
	return left.before === right.before && left.after === right.after;
}

function contentId(content: string): string {
	return `${content.length}:${stringHash(content, 0)}:${stringHash(content, 5381)}`;
}

function createRecentTransition<TSource>(
	before: string,
	after: string,
	transition: IUnifiedDocumentTransition<TSource>,
): IRecentTransition<TSource> {
	return {
		beforeId: contentId(before),
		afterId: contentId(after),
		transition,
	};
}

function createRecentExternalTransition<TSource>(
	before: string,
	after: string,
	transition: IUnifiedDocumentTransition<TSource>,
): IRecentExternalTransition<TSource> {
	return {
		...createRecentTransition(before, after, transition),
		after,
	};
}

export function createMinimalEdit(before: string, after: string): StringEdit {
	if (before === after) {
		return StringEdit.empty;
	}
	return new StringEdit([
		StringReplacement.replace(OffsetRange.ofLength(before.length), after).removeCommonSuffixAndPrefix(before),
	]).normalize();
}
