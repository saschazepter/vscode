/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { OffsetRange } from '../../../../../editor/common/core/ranges/offsetRange.js';
import { StringEdit } from '../../../../../editor/common/core/edits/stringEdit.js';
import { EditSources, TextModelEditSource } from '../../../../../editor/common/textModelEditSource.js';
import { createMinimalEdit, UnifiedDocumentReconciler } from '../../browser/helpers/unifiedDocumentReconciler.js';
import { projectUnifiedDocumentTracker } from '../../browser/telemetry/unifiedDocumentTrackerProjection.js';

suite('Unified Document Tracker Projection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('projects exact model deltas and compact Agent Host edits', async () => {
		const reconciler = new UnifiedDocumentReconciler<TextModelEditSource>('base', EditSources.reloadFromDisk());
		reconciler.modelConnected({ content: 'base', dirty: false });
		reconciler.agentTransition({
			before: 'base',
			after: 'baseA',
			edit: StringEdit.insert(4, 'A'),
			source: agentSource(),
			correlation: 'tool-1',
			kind: 'edit',
		});
		reconciler.modelEdit({
			before: 'base',
			after: 'baseA',
			edit: StringEdit.insert(4, 'A'),
			source: EditSources.reloadFromDisk(),
			kind: 'reloadFromDisk',
			dirty: false,
		});
		reconciler.modelEdit({
			before: 'baseA',
			after: 'baseAU',
			edit: StringEdit.insert(5, 'U'),
			source: EditSources.cursor({ kind: 'type' }),
			kind: 'model',
			dirty: true,
		});

		const projected = await projectUnifiedDocumentTracker(reconciler.getSnapshot());

		assert.deepStrictEqual({
			content: projected.content,
			totalRetainedCount: projected.totalRetainedCount,
			sources: projected.sources.map(source => ({
				sourceKey: source.sourceKey,
				insertedCount: source.insertedCount,
				retainedCount: source.retainedCount,
			})),
		}, {
			content: 'baseAU',
			totalRetainedCount: 2,
			sources: [
				{
					sourceKey: 'source:Chat.applyEdits-$modelId:model-$harness:copilotcli-$origin:agentHost',
					insertedCount: 1,
					retainedCount: 1,
				},
				{
					sourceKey: 'source:cursor-kind:type',
					insertedCount: 1,
					retainedCount: 1,
				},
			],
		});
	});

	test('projects a reload only after Agent Host claims it', async () => {
		const reconciler = new UnifiedDocumentReconciler<TextModelEditSource>('before', EditSources.reloadFromDisk());
		reconciler.modelConnected({ content: 'before', dirty: false });
		reconciler.modelEdit({
			before: 'before',
			after: 'after',
			edit: createMinimalEdit('before', 'after'),
			source: EditSources.reloadFromDisk(),
			kind: 'reloadFromDisk',
			dirty: false,
		});

		const pending = await projectUnifiedDocumentTracker(reconciler.getSnapshot());
		reconciler.agentTransition({
			before: 'before',
			after: 'after',
			edit: createMinimalEdit('before', 'after'),
			source: agentSource(),
			correlation: 'tool-1',
			kind: 'edit',
		});
		const attributed = await projectUnifiedDocumentTracker(reconciler.getSnapshot());

		assert.deepStrictEqual({
			pending: {
				content: pending.content,
				targetContent: pending.targetContent,
				hasPendingReload: pending.hasPendingReload,
				sources: pending.sources,
			},
			attributed: {
				content: attributed.content,
				hasPendingReload: attributed.hasPendingReload,
				sources: attributed.sources.map(source => source.sourceKey),
			},
		}, {
			pending: {
				content: 'before',
				targetContent: 'after',
				hasPendingReload: true,
				sources: [],
			},
			attributed: {
				content: 'after',
				hasPendingReload: false,
				sources: ['source:Chat.applyEdits-$modelId:model-$harness:copilotcli-$origin:agentHost'],
			},
		});
	});

	test('applies trailing external edits to retained attribution', async () => {
		const reconciler = new UnifiedDocumentReconciler<TextModelEditSource>('', EditSources.reloadFromDisk());
		reconciler.agentTransition({
			before: '',
			after: 'ABCDEFGHIJ',
			edit: StringEdit.insert(0, 'ABCDEFGHIJ'),
			source: agentSource(),
			correlation: 'tool-1',
			kind: 'create',
		});
		reconciler.diskSnapshot('ABCD', StringEdit.delete(new OffsetRange(4, 10)));

		const projected = await projectUnifiedDocumentTracker(reconciler.getSnapshot());

		assert.deepStrictEqual({
			content: projected.content,
			totalRetainedCount: projected.totalRetainedCount,
			sources: projected.sources.map(source => ({
				sourceKey: source.sourceKey,
				insertedCount: source.insertedCount,
				retainedCount: source.retainedCount,
			})),
		}, {
			content: 'ABCD',
			totalRetainedCount: 4,
			sources: [{
				sourceKey: 'source:Chat.applyEdits-$modelId:model-$harness:copilotcli-$origin:agentHost',
				insertedCount: 10,
				retainedCount: 4,
			}, {
				sourceKey: 'source:reloadFromDisk',
				insertedCount: 0,
				retainedCount: 0,
			}],
		});
	});
});

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
	});
}
