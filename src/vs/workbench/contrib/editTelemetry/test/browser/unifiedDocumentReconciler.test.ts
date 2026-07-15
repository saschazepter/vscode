/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { UnifiedDocumentReconciler } from '../../browser/helpers/unifiedDocumentReconciler.js';

suite('UnifiedDocumentReconciler', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('deduplicates Agent Host followed by model reload', () => {
		const reconciler = createReconciler('before');
		reconciler.modelConnected({ content: 'before', dirty: false });

		assert.strictEqual(reconciler.agentTransition(agentEdit('before', 'after')).outcome, 'applied');
		assert.strictEqual(reconciler.modelEdit(reloadEdit('before', 'after')).outcome, 'duplicate');
		assert.deepStrictEqual(reconciler.getSnapshot(), expectedAgentSnapshot('before', 'after'));
	});

	test('reattributes model reload followed by Agent Host', () => {
		const reconciler = createReconciler('before');
		reconciler.modelConnected({ content: 'before', dirty: false });

		const reloadResult = reconciler.modelEdit(reloadEdit('before', 'after'));
		assert.deepStrictEqual(
			{ outcome: reloadResult.outcome, changes: reloadResult.changes, pending: reloadResult.snapshot.pendingReload?.kind },
			{ outcome: 'applied', changes: [], pending: 'reloadFromDisk' },
		);
		const agentResult = reconciler.agentTransition(agentEdit('before', 'after'));
		assert.deepStrictEqual(
			{ outcome: agentResult.outcome, changes: agentResult.changes.map(change => change.kind) },
			{ outcome: 'applied', changes: ['append'] },
		);
		assert.deepStrictEqual(reconciler.getSnapshot(), expectedAgentSnapshot('before', 'after'));
	});

	test('produces identical final state for either Agent Host and reload order', () => {
		const agentFirst = createReconciler('before');
		agentFirst.modelConnected({ content: 'before', dirty: false });
		agentFirst.agentTransition(agentEdit('before', 'after'));
		agentFirst.modelEdit(reloadEdit('before', 'after'));

		const reloadFirst = createReconciler('before');
		reloadFirst.modelConnected({ content: 'before', dirty: false });
		reloadFirst.modelEdit(reloadEdit('before', 'after'));
		reloadFirst.agentTransition(agentEdit('before', 'after'));

		assert.deepStrictEqual(reloadFirst.getSnapshot(), agentFirst.getSnapshot());
	});

	test('commits unmatched reload as external on disk snapshot', () => {
		const reconciler = createReconciler('before');
		reconciler.modelConnected({ content: 'before', dirty: false });
		reconciler.modelEdit(reloadEdit('before', 'after'));

		const result = reconciler.diskSnapshot('after');
		assert.deepStrictEqual(
			{ outcome: result.outcome, changes: result.changes },
			{
				outcome: 'applied',
				changes: [{
					kind: 'append',
					transition: {
						id: 1,
						before: 'before',
						after: 'after',
						source: 'reload',
						kind: 'reloadFromDisk',
						correlation: undefined,
						agentKind: undefined,
					},
				}],
			},
		);
	});

	test('skips new Agent Host attribution for a dirty model', () => {
		const reconciler = createReconciler('base');
		reconciler.modelConnected({ content: 'user edit', dirty: true });

		const result = reconciler.agentTransition(agentEdit('base', 'agent edit'));
		assert.deepStrictEqual(
			{ outcome: result.outcome, snapshot: result.snapshot },
			{
				outcome: 'skippedDirty',
				snapshot: {
					initialContent: 'base',
					content: 'base',
					diskContent: 'agent edit',
					model: { content: 'user edit', dirty: true },
					pendingReload: undefined,
					transitions: [],
				},
			},
		);
		assert.strictEqual(reconciler.agentTransition(agentEdit('base', 'agent edit')).outcome, 'duplicate');
	});

	test('claims an already observed reload even if the model became dirty later', () => {
		const reconciler = createReconciler('before');
		reconciler.modelConnected({ content: 'before', dirty: false });
		reconciler.modelEdit(reloadEdit('before', 'after'));
		reconciler.modelEdit({
			before: 'after',
			after: 'after user',
			source: 'user',
			kind: 'model',
			dirty: true,
		});

		assert.strictEqual(reconciler.agentTransition(agentEdit('before', 'after')).outcome, 'applied');
		assert.deepStrictEqual(reconciler.getSnapshot().transitions.map(transition => transition.kind), ['agentHost', 'model']);
	});

	test('tracks create and delete Agent Host transitions', () => {
		const reconciler = createReconciler('');

		assert.strictEqual(reconciler.agentTransition(agentEdit('', 'created', 'create-1', 'create')).outcome, 'applied');
		assert.strictEqual(reconciler.agentTransition(agentEdit('created', '', 'delete-1', 'delete')).outcome, 'applied');
		assert.deepStrictEqual(
			reconciler.getSnapshot().transitions.map(transition => ({
				before: transition.before,
				after: transition.after,
				agentKind: transition.agentKind,
			})),
			[
				{ before: '', after: 'created', agentKind: 'create' },
				{ before: 'created', after: '', agentKind: 'delete' },
			],
		);
	});

	test('does not deduplicate a later real transition after content cycles', () => {
		const reconciler = createReconciler('a');
		reconciler.agentTransition(agentEdit('a', 'b', 'agent-1'));
		reconciler.agentTransition(agentEdit('b', 'a', 'agent-2'));

		assert.strictEqual(reconciler.agentTransition(agentEdit('a', 'b', 'agent-3')).outcome, 'applied');
		assert.deepStrictEqual(
			reconciler.getSnapshot().transitions.map(transition => transition.correlation),
			['agent-1', 'agent-2', 'agent-3'],
		);
	});

	test('does not claim an old external transition after disk content cycles', () => {
		const reconciler = createReconciler('a');
		reconciler.diskSnapshot('b');
		reconciler.diskSnapshot('a');

		assert.strictEqual(reconciler.agentTransition(agentEdit('a', 'b')).outcome, 'applied');
		assert.deepStrictEqual(
			reconciler.getSnapshot().transitions.map(transition => ({
				before: transition.before,
				after: transition.after,
				kind: transition.kind,
			})),
			[
				{ before: 'a', after: 'b', kind: 'diskSnapshot' },
				{ before: 'b', after: 'a', kind: 'diskSnapshot' },
				{ before: 'a', after: 'b', kind: 'agentHost' },
			],
		);
	});

	test('applies disk snapshots as external edits without a model', () => {
		const reconciler = createReconciler('before');

		assert.strictEqual(reconciler.diskSnapshot('after').outcome, 'applied');
		assert.deepStrictEqual(
			reconciler.getSnapshot().transitions.map(transition => ({
				before: transition.before,
				after: transition.after,
				source: transition.source,
				kind: transition.kind,
			})),
			[{ before: 'before', after: 'after', source: 'external', kind: 'diskSnapshot' }],
		);
	});

	test('deduplicates a disk snapshot followed by model reload', () => {
		const reconciler = createReconciler('before');
		reconciler.modelConnected({ content: 'before', dirty: false });

		assert.strictEqual(reconciler.diskSnapshot('after').outcome, 'applied');
		assert.strictEqual(reconciler.modelEdit(reloadEdit('before', 'after')).outcome, 'duplicate');
		assert.deepStrictEqual(
			reconciler.getSnapshot().transitions.map(transition => transition.kind),
			['diskSnapshot'],
		);
	});

	test('treats a model save as synchronization rather than another edit', () => {
		const reconciler = createReconciler('before');
		reconciler.modelConnected({ content: 'before', dirty: false });
		reconciler.modelEdit({
			before: 'before',
			after: 'user edit',
			source: 'user',
			kind: 'model',
			dirty: true,
		});

		assert.strictEqual(reconciler.diskSnapshot('user edit').outcome, 'duplicate');
		assert.deepStrictEqual(
			{
				model: reconciler.getSnapshot().model,
				sources: reconciler.getSnapshot().transitions.map(transition => transition.source),
			},
			{ model: { content: 'user edit', dirty: false }, sources: ['user'] },
		);
		assert.strictEqual(reconciler.agentTransition(agentEdit('user edit', 'agent edit')).outcome, 'applied');
	});

	test('reports a disk conflict while the model is dirty', () => {
		const reconciler = createReconciler('before');
		reconciler.modelConnected({ content: 'before', dirty: false });
		reconciler.modelEdit({
			before: 'before',
			after: 'user edit',
			source: 'user',
			kind: 'model',
			dirty: true,
		});

		const result = reconciler.diskSnapshot('external edit');
		assert.deepStrictEqual(
			{ outcome: result.outcome, content: result.snapshot.content, diskContent: result.snapshot.diskContent },
			{ outcome: 'conflict', content: 'user edit', diskContent: 'external edit' },
		);
	});

	test('continues observing a skipped dirty model and resynchronizes on save', () => {
		const reconciler = createReconciler('base');
		reconciler.modelConnected({ content: 'dirty one', dirty: true });

		const modelEditResult = reconciler.modelEdit({
			before: 'dirty one',
			after: 'dirty two',
			source: 'user',
			kind: 'model',
			dirty: true,
		});
		assert.deepStrictEqual(
			{ outcome: modelEditResult.outcome, model: modelEditResult.snapshot.model },
			{ outcome: 'conflict', model: { content: 'dirty two', dirty: true } },
		);

		const saveResult = reconciler.diskSnapshot('dirty two');
		assert.deepStrictEqual(
			{
				outcome: saveResult.outcome,
				model: saveResult.snapshot.model,
				content: saveResult.snapshot.content,
				transition: saveResult.snapshot.transitions[0],
			},
			{
				outcome: 'applied',
				model: { content: 'dirty two', dirty: false },
				content: 'dirty two',
				transition: {
					id: 1,
					before: 'base',
					after: 'dirty two',
					source: 'external',
					kind: 'diskSnapshot',
					correlation: undefined,
					agentKind: undefined,
				},
			},
		);
	});

	test('resynchronizes when a dirty save overwrites a skipped Agent Host edit', () => {
		const reconciler = createReconciler('base');
		reconciler.modelConnected({ content: 'user edit', dirty: true });
		reconciler.agentTransition(agentEdit('base', 'agent edit'));

		const result = reconciler.diskSnapshot('user edit');
		assert.deepStrictEqual(
			{
				outcome: result.outcome,
				content: result.snapshot.content,
				diskContent: result.snapshot.diskContent,
				model: result.snapshot.model,
				transition: result.snapshot.transitions[0],
			},
			{
				outcome: 'applied',
				content: 'user edit',
				diskContent: 'user edit',
				model: { content: 'user edit', dirty: false },
				transition: {
					id: 1,
					before: 'base',
					after: 'user edit',
					source: 'external',
					kind: 'diskSnapshot',
					correlation: undefined,
					agentKind: undefined,
				},
			},
		);
	});

	test('accepts rename as a correlated no-content transition', () => {
		const reconciler = createReconciler('content');
		const rename = agentEdit('content', 'content', 'rename-1', 'rename');

		assert.strictEqual(reconciler.agentTransition(rename).outcome, 'applied');
		assert.strictEqual(reconciler.agentTransition(rename).outcome, 'duplicate');
		assert.deepStrictEqual(reconciler.getSnapshot().transitions, []);
	});

	test('connects, disconnects, and reconnects without resetting attribution', () => {
		const reconciler = createReconciler('before');
		reconciler.agentTransition(agentEdit('before', 'after'));

		assert.strictEqual(reconciler.modelConnected({ content: 'after', dirty: false }).outcome, 'applied');
		assert.strictEqual(reconciler.modelDisconnected().outcome, 'applied');
		assert.strictEqual(reconciler.modelConnected({ content: 'after', dirty: false }).outcome, 'applied');
		assert.deepStrictEqual(reconciler.getSnapshot().transitions, expectedAgentSnapshot('before', 'after').transitions);
	});

	test('reports conflicting state and correlation reuse', () => {
		const reconciler = createReconciler('before');

		assert.strictEqual(reconciler.agentTransition(agentEdit('other', 'after')).outcome, 'conflict');
		assert.strictEqual(reconciler.agentTransition(agentEdit('before', 'after')).outcome, 'applied');
		assert.strictEqual(reconciler.agentTransition(agentEdit('before', 'different')).outcome, 'conflict');
	});
});

function createReconciler(initialContent: string): UnifiedDocumentReconciler<string> {
	return new UnifiedDocumentReconciler(initialContent, 'external');
}

function agentEdit(
	before: string,
	after: string,
	correlation = 'agent-1',
	kind: 'create' | 'edit' | 'delete' | 'rename' = 'edit',
) {
	return {
		before,
		after,
		source: 'agent',
		correlation,
		kind,
	} as const;
}

function reloadEdit(before: string, after: string) {
	return {
		before,
		after,
		source: 'reload',
		kind: 'reloadFromDisk',
		dirty: false,
	} as const;
}

function expectedAgentSnapshot(initialContent: string, content: string) {
	return {
		initialContent,
		content,
		diskContent: content,
		model: { content, dirty: false },
		pendingReload: undefined,
		transitions: [{
			id: 1,
			before: initialContent,
			after: content,
			source: 'agent',
			kind: 'agentHost',
			correlation: 'agent-1',
			agentKind: 'edit',
		}],
	};
}
