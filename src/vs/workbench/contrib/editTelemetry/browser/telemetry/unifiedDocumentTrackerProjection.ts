/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IObservableWithChange, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { AnnotatedStringEdit, StringEdit } from '../../../../../editor/common/core/edits/stringEdit.js';
import { StringText } from '../../../../../editor/common/core/text/abstractText.js';
import { TextModelEditSource } from '../../../../../editor/common/textModelEditSource.js';
import { EditKeySourceData, EditSourceData, IDocumentWithAnnotatedEdits } from '../helpers/documentWithAnnotatedEdits.js';
import { IUnifiedDocumentSnapshot } from '../helpers/unifiedDocumentReconciler.js';
import { DocumentEditSourceTracker } from './editTracker.js';

export type UnifiedDocumentComputeDiff = (before: string, after: string) => Promise<StringEdit>;

export interface IEditTrackerSourceSnapshot {
	readonly sourceKey: string;
	readonly sourceIndex: number;
	readonly retainedIndex: number | undefined;
	readonly representativeKey: string;
	readonly cleanedSourceKey: string;
	readonly extensionId: string | undefined;
	readonly extensionVersion: string | undefined;
	readonly modelId: string | undefined;
	readonly conversationId: string | undefined;
	readonly requestId: string | undefined;
	readonly origin: string | undefined;
	readonly harness: string | undefined;
	readonly trackingScope: string | undefined;
	readonly insertedCount: number;
	readonly retainedCount: number;
}

export interface IEditTrackerRangeSnapshot {
	readonly start: number;
	readonly endExclusive: number;
	readonly sourceKey: string;
}

export interface IEditTrackerSnapshot {
	readonly content: string;
	readonly targetContent: string;
	readonly hasPendingReload: boolean;
	readonly totalRetainedCount: number;
	readonly sources: readonly IEditTrackerSourceSnapshot[];
	readonly ranges: readonly IEditTrackerRangeSnapshot[];
}

export interface IEditTrackerShadowComparison {
	readonly equal: boolean;
	readonly differences: readonly string[];
}

export interface IEditSourceDetailsRowSnapshot {
	readonly sourceKey: string;
	readonly cleanedSourceKey: string;
	readonly extensionId: string | undefined;
	readonly extensionVersion: string | undefined;
	readonly modelId: string | undefined;
	readonly conversationId: string | undefined;
	readonly requestId: string | undefined;
	readonly origin: string | undefined;
	readonly harness: string | undefined;
	readonly trackingScope: string | undefined;
	readonly modifiedCount: number;
	readonly deltaModifiedCount: number;
}

export interface IEditSourceDetailsSnapshot {
	readonly totalModifiedCount: number;
	readonly rows: readonly IEditSourceDetailsRowSnapshot[];
}

export type EditTrackerSourceSnapshotFilter = (source: IEditTrackerSourceSnapshot) => boolean;
export type EditSourceDetailsOrder = 'tracker' | 'retained';

/**
 * Replays a unified transition snapshot through the existing edit-source tracker.
 */
export async function projectUnifiedDocumentTracker(
	snapshot: IUnifiedDocumentSnapshot<TextModelEditSource>,
	computeDiff: UnifiedDocumentComputeDiff,
): Promise<IEditTrackerSnapshot> {
	const store = new DisposableStore();
	try {
		const document = store.add(new ProjectionDocument(snapshot.initialContent));
		const tracker = store.add(new DocumentEditSourceTracker(document, undefined));
		let content = snapshot.initialContent;
		for (const transition of snapshot.transitions) {
			if (transition.before !== content) {
				throw new Error(`Unified transition ${transition.id} starts from unexpected content`);
			}
			if (transition.before !== transition.after) {
				const edit = await computeDiff(transition.before, transition.after);
				document.apply(edit, transition.source);
			}
			content = transition.after;
		}
		await tracker.waitForQueue();
		tracker.applyPendingExternalEdits();

		if (snapshot.pendingReload) {
			if (snapshot.pendingReload.before !== content || snapshot.pendingReload.after !== snapshot.content) {
				throw new Error('Unified pending reload does not connect projected and target content');
			}
		} else if (content !== snapshot.content) {
			throw new Error('Unified transition replay produced unexpected content');
		}

		return snapshotDocumentEditSourceTracker(tracker, content, snapshot.content, !!snapshot.pendingReload);
	} finally {
		store.dispose();
	}
}

export function snapshotDocumentEditSourceTracker(
	tracker: DocumentEditSourceTracker,
	content: string,
	targetContent = content,
	hasPendingReload = false,
): IEditTrackerSnapshot {
	const ranges = tracker.getTrackedRanges().map(range => ({
		start: range.range.start,
		endExclusive: range.range.endExclusive,
		sourceKey: range.sourceKey,
	}));
	const retainedByKey = new Map<string, number>();
	const retainedIndexByKey = new Map<string, number>();
	for (const [rangeIndex, range] of ranges.entries()) {
		retainedByKey.set(range.sourceKey, (retainedByKey.get(range.sourceKey) ?? 0) + range.endExclusive - range.start);
		if (!retainedIndexByKey.has(range.sourceKey)) {
			retainedIndexByKey.set(range.sourceKey, rangeIndex);
		}
	}
	const sources = tracker.getAllKeys().map((sourceKey, sourceIndex) => {
		const representative = tracker.getRepresentative(sourceKey);
		return {
			sourceKey,
			sourceIndex,
			retainedIndex: retainedIndexByKey.get(sourceKey),
			representativeKey: representative?.toKey(Number.MAX_SAFE_INTEGER) ?? '',
			cleanedSourceKey: representative?.toKey(1, { $extensionId: false, $extensionVersion: false, $modelId: false }) ?? '',
			extensionId: representative?.props.$extensionId,
			extensionVersion: representative?.props.$extensionVersion,
			modelId: representative?.props.$modelId,
			conversationId: representative?.props.$$sessionId,
			requestId: representative?.props.$$requestId,
			origin: representative?.props.$origin,
			harness: representative?.props.$harness,
			trackingScope: representative?.props.$trackingScope,
			insertedCount: tracker.getTotalInsertedCharactersCount(sourceKey),
			retainedCount: retainedByKey.get(sourceKey) ?? 0,
		};
	}).sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));

	return {
		content,
		targetContent,
		hasPendingReload,
		totalRetainedCount: ranges.reduce((sum, range) => sum + range.endExclusive - range.start, 0),
		sources,
		ranges,
	};
}

export function filterEditTrackerSnapshot(
	snapshot: IEditTrackerSnapshot,
	filter: EditTrackerSourceSnapshotFilter,
): IEditTrackerSnapshot {
	const sources = snapshot.sources
		.filter(filter)
		.sort((left, right) => left.sourceIndex - right.sourceIndex)
		.map((source, sourceIndex) => ({ ...source, sourceIndex }))
		.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
	const sourceKeys = new Set(sources.map(source => source.sourceKey));
	const ranges = snapshot.ranges.filter(range => sourceKeys.has(range.sourceKey));
	return {
		...snapshot,
		totalRetainedCount: ranges.reduce((sum, range) => sum + range.endExclusive - range.start, 0),
		sources,
		ranges,
	};
}

export function snapshotEditSourceDetails(
	snapshot: IEditTrackerSnapshot,
	filter: EditTrackerSourceSnapshotFilter = () => true,
	limit = 30,
	order: EditSourceDetailsOrder = 'tracker',
): IEditSourceDetailsSnapshot {
	const filteredSources = snapshot.sources.filter(filter);
	const getOrder = (source: IEditTrackerSourceSnapshot) => order === 'retained'
		? source.retainedIndex ?? snapshot.ranges.length + source.sourceIndex
		: source.sourceIndex;
	const sources = filteredSources
		.sort((left, right) => right.retainedCount - left.retainedCount || getOrder(left) - getOrder(right))
		.slice(0, limit);
	return {
		totalModifiedCount: filteredSources.reduce((sum, source) => sum + source.retainedCount, 0),
		rows: sources.map(source => ({
			sourceKey: source.sourceKey,
			cleanedSourceKey: source.cleanedSourceKey,
			extensionId: source.extensionId,
			extensionVersion: source.extensionVersion,
			modelId: source.modelId,
			conversationId: source.conversationId,
			requestId: source.requestId,
			origin: source.origin,
			harness: source.harness,
			trackingScope: source.trackingScope,
			modifiedCount: source.retainedCount,
			deltaModifiedCount: source.insertedCount,
		})),
	};
}

export function compareEditTrackerSnapshots(
	reference: IEditTrackerSnapshot,
	candidate: IEditTrackerSnapshot,
): IEditTrackerShadowComparison {
	const differences: string[] = [];
	compareField('content', reference.content, candidate.content, differences);
	compareField('targetContent', reference.targetContent, candidate.targetContent, differences);
	compareField('hasPendingReload', reference.hasPendingReload, candidate.hasPendingReload, differences);
	compareField('totalRetainedCount', reference.totalRetainedCount, candidate.totalRetainedCount, differences);
	compareField('sources', reference.sources, candidate.sources, differences);
	compareField('ranges', reference.ranges, candidate.ranges, differences);
	return { equal: differences.length === 0, differences };
}

export function compareEditSourceDetailsSnapshots(
	reference: IEditSourceDetailsSnapshot,
	candidate: IEditSourceDetailsSnapshot,
): IEditTrackerShadowComparison {
	const differences: string[] = [];
	compareField('totalModifiedCount', reference.totalModifiedCount, candidate.totalModifiedCount, differences);
	compareField(
		'rows',
		reference.rows.toSorted((left, right) => left.sourceKey.localeCompare(right.sourceKey)),
		candidate.rows.toSorted((left, right) => left.sourceKey.localeCompare(right.sourceKey)),
		differences,
	);
	return { equal: differences.length === 0, differences };
}

export function getEditTrackerComparisonDifferenceFields(comparison: IEditTrackerShadowComparison): readonly string[] {
	return comparison.differences.map(difference => difference.substring(0, difference.indexOf(':')));
}

function compareField(field: string, reference: unknown, candidate: unknown, differences: string[]): void {
	const referenceValue = JSON.stringify(reference);
	const candidateValue = JSON.stringify(candidate);
	if (referenceValue !== candidateValue) {
		differences.push(`${field}: expected ${referenceValue}, got ${candidateValue}`);
	}
}

class ProjectionDocument extends Disposable implements IDocumentWithAnnotatedEdits<EditKeySourceData> {
	private readonly _value: ISettableObservable<StringText, { edit: AnnotatedStringEdit<EditKeySourceData> }>;
	readonly value: IObservableWithChange<StringText, { edit: AnnotatedStringEdit<EditKeySourceData> }>;

	constructor(initialContent: string) {
		super();
		this.value = this._value = observableValue(this, new StringText(initialContent));
	}

	apply(edit: StringEdit, source: TextModelEditSource): void {
		const data = new EditSourceData(source).toEditSourceData();
		this._value.set(edit.applyOnText(this._value.get()), undefined, { edit: edit.mapData(() => data) });
	}

	waitForQueue(): Promise<void> {
		return Promise.resolve();
	}
}
