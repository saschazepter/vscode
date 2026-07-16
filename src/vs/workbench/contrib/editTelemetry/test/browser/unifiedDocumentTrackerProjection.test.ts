/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IObservableWithChange, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AnnotatedStringEdit, StringEdit } from '../../../../../editor/common/core/edits/stringEdit.js';
import { StringText } from '../../../../../editor/common/core/text/abstractText.js';
import { computeStringDiff } from '../../../../../editor/common/services/editorWebWorker.js';
import { EditSources, TextModelEditSource } from '../../../../../editor/common/textModelEditSource.js';
import { EditKeySourceData, EditSourceData, IDocumentWithAnnotatedEdits } from '../../browser/helpers/documentWithAnnotatedEdits.js';
import { UnifiedDocumentReconciler } from '../../browser/helpers/unifiedDocumentReconciler.js';
import { DocumentEditSourceTracker } from '../../browser/telemetry/editTracker.js';
import {
	compareEditTrackerSnapshots,
	IEditTrackerSnapshot,
	projectUnifiedDocumentTracker,
	snapshotDocumentEditSourceTracker,
} from '../../browser/telemetry/unifiedDocumentTrackerProjection.js';

suite('Unified Document Tracker Projection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('matches an independently driven existing tracker', async () => {
		const initialContent = 'a';
		const agent = agentSource();
		const user = EditSources.cursor({ kind: 'type' });
		const reconciler = new UnifiedDocumentReconciler<TextModelEditSource>(initialContent, EditSources.reloadFromDisk());
		reconciler.modelConnected({ content: initialContent, dirty: false });
		reconciler.agentTransition({
			before: 'a',
			after: 'ab',
			source: agent,
			correlation: 'tool-1',
			kind: 'edit',
		});
		reconciler.modelEdit({
			before: 'a',
			after: 'ab',
			source: EditSources.reloadFromDisk(),
			kind: 'reloadFromDisk',
			dirty: false,
		});
		reconciler.modelEdit({
			before: 'ab',
			after: 'abU',
			source: user,
			kind: 'model',
			dirty: true,
		});

		const candidate = await projectUnifiedDocumentTracker(reconciler.getSnapshot(), computeDiff);
		const reference = await createReferenceSnapshot(initialContent, [
			{ before: 'a', after: 'ab', source: agent },
			{ before: 'ab', after: 'abU', source: user },
		]);

		assert.deepStrictEqual(compareEditTrackerSnapshots(reference, candidate), { equal: true, differences: [] });
	});

	test('projects reload-first attribution only after Agent Host claims it', async () => {
		const reconciler = new UnifiedDocumentReconciler<TextModelEditSource>('before', EditSources.reloadFromDisk());
		reconciler.modelConnected({ content: 'before', dirty: false });
		reconciler.modelEdit({
			before: 'before',
			after: 'after',
			source: EditSources.reloadFromDisk(),
			kind: 'reloadFromDisk',
			dirty: false,
		});

		const pending = await projectUnifiedDocumentTracker(reconciler.getSnapshot(), computeDiff);
		reconciler.agentTransition({
			before: 'before',
			after: 'after',
			source: agentSource(),
			correlation: 'tool-1',
			kind: 'edit',
		});
		const attributed = await projectUnifiedDocumentTracker(reconciler.getSnapshot(), computeDiff);

		assert.deepStrictEqual(
			{
				pending: {
					content: pending.content,
					targetContent: pending.targetContent,
					hasPendingReload: pending.hasPendingReload,
					sources: pending.sources,
				},
				attributed: {
					content: attributed.content,
					targetContent: attributed.targetContent,
					hasPendingReload: attributed.hasPendingReload,
					sources: attributed.sources.map(source => ({
						sourceKey: source.sourceKey,
						insertedCount: source.insertedCount,
						retainedCount: source.retainedCount,
					})),
				},
			},
			{
				pending: {
					content: 'before',
					targetContent: 'after',
					hasPendingReload: true,
					sources: [],
				},
				attributed: {
					content: 'after',
					targetContent: 'after',
					hasPendingReload: false,
					sources: [{
						sourceKey: 'source:Chat.applyEdits-$modelId:model-$harness:copilotcli-$origin:agentHost-$trackingScope:agentHostAIOnly',
						insertedCount: 5,
						retainedCount: 5,
					}],
				},
			},
		);
	});

	test('reports field-level shadow differences', () => {
		const reference = emptySnapshot('reference');
		const candidate = { ...emptySnapshot('candidate'), totalRetainedCount: 1 };

		assert.deepStrictEqual(compareEditTrackerSnapshots(reference, candidate), {
			equal: false,
			differences: [
				'content: expected "reference", got "candidate"',
				'targetContent: expected "reference", got "candidate"',
				'totalRetainedCount: expected 0, got 1',
			],
		});
	});
});

async function createReferenceSnapshot(
	initialContent: string,
	transitions: readonly { before: string; after: string; source: TextModelEditSource }[],
): Promise<IEditTrackerSnapshot> {
	const store = new DisposableStore();
	try {
		const document = store.add(new ReferenceDocument(initialContent));
		const tracker = store.add(new DocumentEditSourceTracker(document, undefined));
		let content = initialContent;
		for (const transition of transitions) {
			assert.strictEqual(transition.before, content);
			document.apply(await computeDiff(transition.before, transition.after), transition.source);
			content = transition.after;
		}
		await tracker.waitForQueue();
		return snapshotDocumentEditSourceTracker(tracker, content);
	} finally {
		store.dispose();
	}
}

function computeDiff(before: string, after: string): Promise<StringEdit> {
	return computeStringDiff(before, after, { maxComputationTimeMs: 500 }, 'advanced');
}

function agentSource(): TextModelEditSource {
	return EditSources.chatApplyEdits({
		modelId: 'model',
		sessionId: 'session',
		requestId: 'request',
		languageId: 'typescript',
		mode: 'agent',
		extensionId: undefined,
		codeBlockSuggestionId: undefined,
		harness: 'copilotcli',
		origin: 'agentHost',
		trackingScope: 'agentHostAIOnly',
	});
}

function emptySnapshot(content: string): IEditTrackerSnapshot {
	return {
		content,
		targetContent: content,
		hasPendingReload: false,
		totalRetainedCount: 0,
		sources: [],
		ranges: [],
	};
}

class ReferenceDocument extends Disposable implements IDocumentWithAnnotatedEdits<EditKeySourceData> {
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
