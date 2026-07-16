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
	readonly representativeKey: string;
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
				throw new Error(`Unified transition ${transition.id} starts from ${JSON.stringify(transition.before)}, expected ${JSON.stringify(content)}`);
			}
			if (transition.before !== transition.after) {
				const edit = await computeDiff(transition.before, transition.after);
				document.apply(edit, transition.source);
			}
			content = transition.after;
		}
		await tracker.waitForQueue();

		if (snapshot.pendingReload) {
			if (snapshot.pendingReload.before !== content || snapshot.pendingReload.after !== snapshot.content) {
				throw new Error('Unified pending reload does not connect projected and target content');
			}
		} else if (content !== snapshot.content) {
			throw new Error(`Unified transition replay produced ${JSON.stringify(content)}, expected ${JSON.stringify(snapshot.content)}`);
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
	for (const range of ranges) {
		retainedByKey.set(range.sourceKey, (retainedByKey.get(range.sourceKey) ?? 0) + range.endExclusive - range.start);
	}
	const sources = tracker.getAllKeys().map(sourceKey => ({
		sourceKey,
		representativeKey: tracker.getRepresentative(sourceKey)?.toKey(Number.MAX_SAFE_INTEGER) ?? '',
		insertedCount: tracker.getTotalInsertedCharactersCount(sourceKey),
		retainedCount: retainedByKey.get(sourceKey) ?? 0,
	})).sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));

	return {
		content,
		targetContent,
		hasPendingReload,
		totalRetainedCount: ranges.reduce((sum, range) => sum + range.endExclusive - range.start, 0),
		sources,
		ranges,
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
