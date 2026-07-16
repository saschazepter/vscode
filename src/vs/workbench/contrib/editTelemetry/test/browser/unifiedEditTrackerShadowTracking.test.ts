/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IObservable, IObservableWithChange, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { OffsetRange } from '../../../../../editor/common/core/ranges/offsetRange.js';
import { StringText } from '../../../../../editor/common/core/text/abstractText.js';
import { computeStringDiff } from '../../../../../editor/common/services/editorWebWorker.js';
import { EditSources, TextModelEditSource } from '../../../../../editor/common/textModelEditSource.js';
import { IObservableDocument, ObservableWorkspace, StringEditWithReason } from '../../browser/helpers/observableWorkspace.js';
import { UnifiedDocumentReconciler } from '../../browser/helpers/unifiedDocumentReconciler.js';
import { IEditTrackerSnapshot, projectUnifiedDocumentTracker } from '../../browser/telemetry/unifiedDocumentTrackerProjection.js';
import { UnifiedEditTrackerShadowTracking } from '../../browser/telemetry/unifiedEditTrackerShadowTracking.js';

suite('Unified Edit Tracker Shadow Tracking', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('mirrors model and Agent Host inputs without duplicating attribution', async () => {
		const store = new DisposableStore();
		const workspace = new TestWorkspace();
		const document = store.add(new TestObservableDocument('before'));
		workspace.setDocuments([document]);
		const shadow = store.add(createShadow(workspace, () => false));

		const agentResult = shadow.applyAgentEdit({
			resource: document.uri,
			before: 'before',
			after: 'after',
			source: agentSource(),
			correlation: 'tool-1',
			kind: 'edit',
		});
		document.apply(StringEditWithReason.replace(OffsetRange.ofLength(6), 'after', EditSources.reloadFromDisk()));
		const candidate = await shadow.project(document.uri, computeDiff);

		assert.deepStrictEqual({
			agentOutcome: agentResult.transitionResult.outcome,
			lastOutcome: shadow.getLastResult(document.uri)?.outcome,
			content: candidate?.content,
			hasPendingReload: candidate?.hasPendingReload,
			sources: candidate?.sources.map(source => ({
				sourceKey: source.sourceKey,
				insertedCount: source.insertedCount,
				retainedCount: source.retainedCount,
			})),
		}, {
			agentOutcome: 'applied',
			lastOutcome: 'duplicate',
			content: 'after',
			hasPendingReload: false,
			sources: [{
				sourceKey: 'source:Chat.applyEdits-$modelId:model-$harness:copilotcli-$origin:agentHost-$trackingScope:agentHostAIOnly',
				insertedCount: 5,
				retainedCount: 5,
			}],
		});
		store.dispose();
	});

	test('tracks dirty skips and flush-time disk snapshots', () => {
		const store = new DisposableStore();
		const workspace = new TestWorkspace();
		const document = store.add(new TestObservableDocument('dirty'));
		workspace.setDocuments([document]);
		const shadow = store.add(createShadow(workspace, () => true));

		const agentResult = shadow.applyAgentEdit({
			resource: document.uri,
			before: 'disk',
			after: 'agent',
			source: agentSource(),
			correlation: 'tool-1',
			kind: 'edit',
		});
		const diskResult = shadow.applyDiskSnapshot(document.uri, 'agent');

		assert.deepStrictEqual({
			agentOutcome: agentResult.transitionResult.outcome,
			diskOutcome: diskResult.outcome,
			snapshot: shadow.getSnapshot(document.uri),
		}, {
			agentOutcome: 'skippedDirty',
			diskOutcome: 'conflict',
			snapshot: {
				initialContent: 'dirty',
				content: 'dirty',
				diskContent: 'agent',
				model: { content: 'dirty', dirty: true },
				pendingReload: undefined,
				transitions: [],
			},
		});
		store.dispose();
	});

	test('compares a projected candidate on demand', async () => {
		const store = new DisposableStore();
		const workspace = new TestWorkspace();
		const shadow = store.add(createShadow(workspace, () => false));
		const resource = URI.file('C:\\repo\\file.ts');
		shadow.applyAgentEdit({
			resource,
			before: '',
			after: 'agent',
			source: agentSource(),
			correlation: 'tool-1',
			kind: 'create',
		});
		const candidate = await shadow.project(resource, computeDiff);
		const reference: IEditTrackerSnapshot = {
			...candidate!,
			totalRetainedCount: 0,
		};
		const result = await shadow.compare(resource, reference, computeDiff);

		assert.deepStrictEqual(result?.trackerComparison, {
			equal: false,
			differences: ['totalRetainedCount: expected 0, got 5'],
		});
		store.dispose();
	});

	test('checkpoints repeated Agent Host comparison windows', async () => {
		const store = new DisposableStore();
		const workspace = new TestWorkspace();
		const shadow = store.add(createShadow(workspace, () => false));
		const resource = URI.file('C:\\repo\\file.ts');
		shadow.applyAgentEdit({
			resource,
			before: '',
			after: 'one',
			source: agentSource(),
			correlation: 'tool-1',
			kind: 'create',
		});
		const firstReference = await projectSingleAgentTransition('', 'one', 'tool-1', 'create');
		const first = await shadow.compareAndCheckpoint(
			'agentHost',
			resource,
			firstReference,
			computeDiff,
			{ sourceFilter: source => source.trackingScope === 'agentHostAIOnly' },
		);

		shadow.applyAgentEdit({
			resource,
			before: 'one',
			after: 'two',
			source: agentSource(),
			correlation: 'tool-2',
			kind: 'edit',
		});
		const secondReference = await projectSingleAgentTransition('one', 'two', 'tool-2', 'edit');
		const second = await shadow.compareAndCheckpoint(
			'agentHost',
			resource,
			secondReference,
			computeDiff,
			{ sourceFilter: source => source.trackingScope === 'agentHostAIOnly' },
		);

		assert.deepStrictEqual({
			firstTracker: first?.trackerComparison,
			firstDetails: first?.detailsComparison,
			secondTracker: second?.trackerComparison,
			secondDetails: second?.detailsComparison,
			secondCandidateContent: second?.candidate.content,
			secondInsertedCount: second?.candidate.sources[0]?.insertedCount,
		}, {
			firstTracker: { equal: true, differences: [] },
			firstDetails: { equal: true, differences: [] },
			secondTracker: { equal: true, differences: [] },
			secondDetails: { equal: true, differences: [] },
			secondCandidateContent: 'two',
			secondInsertedCount: 3,
		});
		store.dispose();
	});

	test('checkpoints local windows containing Agent Host transitions without comparing them', async () => {
		const store = new DisposableStore();
		const workspace = new TestWorkspace();
		const document = store.add(new TestObservableDocument('before'));
		workspace.setDocuments([document]);
		const shadow = store.add(createShadow(workspace, () => false));
		shadow.startComparison('local', document.uri);
		shadow.applyAgentEdit({
			resource: document.uri,
			before: 'before',
			after: 'after',
			source: agentSource(),
			correlation: 'tool-1',
			kind: 'edit',
		});
		document.apply(StringEditWithReason.replace(OffsetRange.ofLength(6), 'after', EditSources.reloadFromDisk()));
		const skipped = await shadow.compareAndCheckpoint(
			'local',
			document.uri,
			emptySnapshot('after'),
			computeDiff,
			{ skipAgentHostTransitions: true },
		);

		document.apply(StringEditWithReason.replace(new OffsetRange(5, 5), '!', EditSources.cursor({ kind: 'type' })));
		const userReference = await projectSingleModelTransition('after', 'after!');
		const compared = await shadow.compareAndCheckpoint(
			'local',
			document.uri,
			userReference,
			computeDiff,
			{ skipAgentHostTransitions: true },
		);

		assert.deepStrictEqual({
			skipped,
			trackerComparison: compared?.trackerComparison,
			detailsComparison: compared?.detailsComparison,
		}, {
			skipped: undefined,
			trackerComparison: { equal: true, differences: [] },
			detailsComparison: { equal: true, differences: [] },
		});
		store.dispose();
	});

	test('releases closed resources after queued comparisons complete', async () => {
		const store = new DisposableStore();
		const workspace = new TestWorkspace();
		const document = store.add(new TestObservableDocument('content'));
		workspace.setDocuments([document]);
		const shadow = store.add(createShadow(workspace, () => false));
		shadow.startComparison('local', document.uri);
		const comparison = shadow.compareAndCheckpoint('local', document.uri, emptySnapshot('content'), computeDiff);

		workspace.setDocuments([]);
		await comparison;
		await Promise.resolve();

		assert.strictEqual(shadow.getSnapshot(document.uri), undefined);
		store.dispose();
	});

	test('retains closed resources while an Agent Host tracker owns them', async () => {
		const store = new DisposableStore();
		const workspace = new TestWorkspace();
		const shadow = store.add(createShadow(workspace, () => false));
		const resource = URI.file('C:\\repo\\file.ts');
		shadow.applyAgentEdit({
			resource,
			before: '',
			after: 'content',
			source: agentSource(),
			correlation: 'tool-1',
			kind: 'create',
		});
		shadow.retainAgentResource(resource);
		const retained = !!shadow.getSnapshot(resource);
		shadow.releaseAgentResource(resource);
		await Promise.resolve();

		assert.deepStrictEqual({
			retained,
			afterRelease: shadow.getSnapshot(resource),
		}, {
			retained: true,
			afterRelease: undefined,
		});
		store.dispose();
	});
});

function createShadow(workspace: ObservableWorkspace, isDirty: (resource: URI) => boolean): UnifiedEditTrackerShadowTracking {
	return new UnifiedEditTrackerShadowTracking(workspace, {
		isDirty,
		canonicalize: resource => resource.with({ path: resource.path.toLowerCase() }),
		getComparisonKey: resource => resource.toString().toLowerCase(),
	});
}

function computeDiff(before: string, after: string) {
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

async function projectSingleAgentTransition(
	before: string,
	after: string,
	correlation: string,
	kind: 'create' | 'edit',
): Promise<IEditTrackerSnapshot> {
	const reconciler = new UnifiedDocumentReconciler<TextModelEditSource>(before, EditSources.reloadFromDisk());
	reconciler.agentTransition({ before, after, source: agentSource(), correlation, kind });
	return projectUnifiedDocumentTracker(reconciler.getSnapshot(), computeDiff);
}

async function projectSingleModelTransition(before: string, after: string): Promise<IEditTrackerSnapshot> {
	const reconciler = new UnifiedDocumentReconciler<TextModelEditSource>(before, EditSources.reloadFromDisk());
	reconciler.modelConnected({ content: before, dirty: false });
	reconciler.modelEdit({
		before,
		after,
		source: EditSources.cursor({ kind: 'type' }),
		kind: 'model',
		dirty: true,
	});
	return projectUnifiedDocumentTracker(reconciler.getSnapshot(), computeDiff);
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

class TestWorkspace extends ObservableWorkspace {
	private readonly _documents = observableValue<readonly IObservableDocument[]>(this, []);
	override readonly documents: IObservable<readonly IObservableDocument[]> = this._documents;

	setDocuments(documents: readonly IObservableDocument[]): void {
		this._documents.set(documents, undefined);
	}
}

class TestObservableDocument extends Disposable implements IObservableDocument {
	private readonly _value: ISettableObservable<StringText, StringEditWithReason>;
	readonly value: IObservableWithChange<StringText, StringEditWithReason>;
	readonly version: IObservable<number>;
	readonly languageId: IObservable<string>;

	constructor(initialContent: string, readonly uri = URI.file('C:\\repo\\file.ts')) {
		super();
		this.value = this._value = observableValue(this, new StringText(initialContent));
		this.version = observableValue(this, 1);
		this.languageId = observableValue(this, 'typescript');
	}

	apply(edit: StringEditWithReason): void {
		this._value.set(edit.applyOnText(this._value.get()), undefined, edit);
	}
}
