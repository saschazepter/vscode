/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createMinimalEdit, UnifiedDocumentReconciler } from '../../browser/helpers/unifiedDocumentReconciler.js';

suite('UnifiedDocumentReconciler', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('deduplicates Agent Host followed by model reload', () => {
		const reconciler = createReconciler('before');
		reconciler.modelConnected({ content: 'before', dirty: false });

		assert.strictEqual(reconciler.agentTransition(agentEdit('before', 'after')).outcome, 'applied');
		assert.strictEqual(reconciler.modelEdit(reloadEdit('before', 'after')).outcome, 'duplicate');
		assert.deepStrictEqual(snapshotSummary(reconciler), {
			content: 'after',
			diskContent: 'after',
			pendingReload: false,
			transitionKinds: ['agentHost'],
		});
	});

	test('deduplicates an Agent Host transition chain followed by one model reload', () => {
		const reconciler = createReconciler('a');
		reconciler.modelConnected({ content: 'a', dirty: false });
		reconciler.agentTransition(agentEdit('a', 'ab', 'agent-1'));
		reconciler.agentTransition(agentEdit('ab', 'abc', 'agent-2'));

		const reloadResult = reconciler.modelEdit(reloadEdit('a', 'abc'));

		assert.deepStrictEqual({
			reloadOutcome: reloadResult.outcome,
			reloadChanges: reloadResult.changes,
			snapshot: snapshotSummary(reconciler),
		}, {
			reloadOutcome: 'duplicate',
			reloadChanges: [],
			snapshot: {
				content: 'abc',
				diskContent: 'abc',
				pendingReload: false,
				transitionKinds: ['agentHost', 'agentHost'],
			},
		});
	});

	test('deduplicates a recent Agent Host transition subchain', () => {
		const reconciler = createReconciler('');
		reconciler.modelConnected({ content: '', dirty: false });
		reconciler.agentTransition(agentEdit('', 'a', 'agent-0'));
		reconciler.modelEdit(reloadEdit('', 'a'));
		reconciler.agentTransition(agentEdit('a', 'ab', 'agent-1'));
		reconciler.agentTransition(agentEdit('ab', 'abc', 'agent-2'));

		const reloadResult = reconciler.modelEdit(reloadEdit('a', 'abc'));

		assert.deepStrictEqual({
			reloadOutcome: reloadResult.outcome,
			transitionKinds: reloadResult.snapshot.transitions.map(transition => transition.kind),
		}, {
			reloadOutcome: 'duplicate',
			transitionKinds: ['agentHost', 'agentHost', 'agentHost'],
		});
	});

	test('reattributes model reload followed by Agent Host', () => {
		const reconciler = createReconciler('before');
		reconciler.modelConnected({ content: 'before', dirty: false });

		const reloadResult = reconciler.modelEdit(reloadEdit('before', 'after'));
		const agentResult = reconciler.agentTransition(agentEdit('before', 'after'));

		assert.deepStrictEqual({
			reload: {
				outcome: reloadResult.outcome,
				changes: reloadResult.changes,
				pending: reloadResult.snapshot.pendingReload?.transition.kind,
			},
			agent: {
				outcome: agentResult.outcome,
				changes: agentResult.changes.map(change => change.kind),
			},
			snapshot: snapshotSummary(reconciler),
		}, {
			reload: { outcome: 'applied', changes: [], pending: 'reloadFromDisk' },
			agent: { outcome: 'applied', changes: ['append'] },
			snapshot: {
				content: 'after',
				diskContent: 'after',
				pendingReload: false,
				transitionKinds: ['agentHost'],
			},
		});
	});

	test('reattributes one pending reload from an Agent Host transition chain', () => {
		const reconciler = createReconciler('a');
		reconciler.modelConnected({ content: 'a', dirty: false });

		const reloadResult = reconciler.modelEdit(reloadEdit('a', 'abc'));
		const firstAgentResult = reconciler.agentTransition(agentEdit('a', 'ab', 'agent-1'));
		const secondAgentResult = reconciler.agentTransition(agentEdit('ab', 'abc', 'agent-2'));

		assert.deepStrictEqual({
			reload: {
				outcome: reloadResult.outcome,
				changes: reloadResult.changes,
			},
			firstAgent: {
				outcome: firstAgentResult.outcome,
				changes: firstAgentResult.changes,
			},
			secondAgent: {
				outcome: secondAgentResult.outcome,
				changes: secondAgentResult.changes.map(change => ({
					kind: change.kind,
					before: change.before,
					after: change.after,
				})),
			},
			snapshot: snapshotSummary(reconciler),
		}, {
			reload: {
				outcome: 'applied',
				changes: [],
			},
			firstAgent: {
				outcome: 'applied',
				changes: [],
			},
			secondAgent: {
				outcome: 'applied',
				changes: [
					{ kind: 'append', before: 'a', after: 'ab' },
					{ kind: 'append', before: 'ab', after: 'abc' },
				],
			},
			snapshot: {
				content: 'abc',
				diskContent: 'abc',
				pendingReload: false,
				transitionKinds: ['agentHost', 'agentHost'],
			},
		});
	});

	test('splits an incomplete Agent Host chain from the external reload remainder', () => {
		const reconciler = createReconciler('a');
		reconciler.modelConnected({ content: 'a', dirty: false });
		reconciler.modelEdit(reloadEdit('a', 'abc'));
		reconciler.agentTransition(agentEdit('a', 'ab', 'agent-1'));

		const diskResult = diskSnapshot(reconciler, 'abc');
		const lateAgentResult = reconciler.agentTransition(agentEdit('ab', 'abc', 'agent-2'));

		assert.deepStrictEqual({
			diskChanges: diskResult.changes.map(change => ({
				kind: change.kind,
				before: change.before,
				after: change.after,
				transitionKind: change.transition.kind,
			})),
			lateAgent: {
				outcome: lateAgentResult.outcome,
				changes: lateAgentResult.changes.map(change => change.kind),
			},
			transitions: reconciler.getSnapshot().transitions.map(transition => ({
				kind: transition.kind,
				correlation: transition.correlation,
			})),
		}, {
			diskChanges: [
				{ kind: 'append', before: 'a', after: 'ab', transitionKind: 'agentHost' },
				{ kind: 'append', before: 'ab', after: 'abc', transitionKind: 'reloadFromDisk' },
			],
			lateAgent: {
				outcome: 'applied',
				changes: ['replace'],
			},
			transitions: [
				{ kind: 'agentHost', correlation: 'agent-1' },
				{ kind: 'agentHost', correlation: 'agent-2' },
			],
		});
	});

	test('replaces one committed external reload with a late Agent Host transition chain', () => {
		const reconciler = createReconciler('a');
		reconciler.modelConnected({ content: 'a', dirty: false });
		reconciler.modelEdit(reloadEdit('a', 'abc'));
		diskSnapshot(reconciler, 'abc');

		const firstAgentResult = reconciler.agentTransition(agentEdit('a', 'ab', 'agent-1'));
		const secondAgentResult = reconciler.agentTransition(agentEdit('ab', 'abc', 'agent-2'));

		assert.deepStrictEqual({
			firstAgent: {
				outcome: firstAgentResult.outcome,
				changes: firstAgentResult.changes,
			},
			secondAgent: {
				outcome: secondAgentResult.outcome,
				changes: secondAgentResult.changes.map(change => change.kind),
			},
			transitions: reconciler.getSnapshot().transitions.map(transition => ({
				kind: transition.kind,
				correlation: transition.correlation,
			})),
		}, {
			firstAgent: {
				outcome: 'applied',
				changes: [],
			},
			secondAgent: {
				outcome: 'applied',
				changes: ['replace', 'append'],
			},
			transitions: [
				{ kind: 'agentHost', correlation: 'agent-1' },
				{ kind: 'agentHost', correlation: 'agent-2' },
			],
		});
	});

	test('splits a late incomplete Agent Host chain when a model edit interrupts it', () => {
		const reconciler = createReconciler('a');
		reconciler.modelConnected({ content: 'a', dirty: false });
		reconciler.modelEdit(reloadEdit('a', 'abc'));
		diskSnapshot(reconciler, 'abc');
		reconciler.agentTransition(agentEdit('a', 'ab', 'agent-1'));

		const modelResult = reconciler.modelEdit(modelEdit('abc', 'abcd'));

		assert.deepStrictEqual({
			outcome: modelResult.outcome,
			changes: modelResult.changes.map(change => ({
				kind: change.kind,
				before: change.before,
				after: change.after,
				transitionKind: change.transition.kind,
			})),
			transitions: reconciler.getSnapshot().transitions.map(transition => ({
				kind: transition.kind,
				correlation: transition.correlation,
			})),
		}, {
			outcome: 'applied',
			changes: [
				{ kind: 'replace', before: 'a', after: 'ab', transitionKind: 'agentHost' },
				{ kind: 'append', before: 'ab', after: 'abc', transitionKind: 'reloadFromDisk' },
				{ kind: 'append', before: 'abc', after: 'abcd', transitionKind: 'model' },
			],
			transitions: [
				{ kind: 'agentHost', correlation: 'agent-1' },
				{ kind: 'reloadFromDisk', correlation: undefined },
				{ kind: 'model', correlation: undefined },
			],
		});
	});

	test('preserves the external endpoint when a late Agent Host prefix follows a model edit', () => {
		const reconciler = createReconciler('a');
		reconciler.modelConnected({ content: 'a', dirty: false });
		reconciler.modelEdit(reloadEdit('a', 'abc'));
		diskSnapshot(reconciler, 'abc');
		reconciler.modelEdit(modelEdit('abc', 'abcd'));

		const agentResult = reconciler.agentTransition(agentEdit('a', 'ab', 'agent-1'));
		const diskResult = diskSnapshot(reconciler, 'abcd');
		const snapshot = reconciler.getSnapshot();
		let projectedContent = snapshot.initialContent;
		for (const transition of snapshot.transitions) {
			projectedContent = transition.edit.apply(projectedContent);
		}

		assert.deepStrictEqual({
			agentPending: agentResult.snapshot.pendingAgentTransitions,
			diskOutcome: diskResult.outcome,
			diskChanges: diskResult.changes.map(change => ({
				kind: change.kind,
				before: change.before,
				after: change.after,
				transitionKind: change.transition.kind,
			})),
			pendingAgentTransitions: snapshot.pendingAgentTransitions,
			transitionKinds: snapshot.transitions.map(transition => transition.kind),
			projectedContent,
		}, {
			agentPending: true,
			diskOutcome: 'duplicate',
			diskChanges: [
				{ kind: 'replace', before: 'a', after: 'ab', transitionKind: 'agentHost' },
				{ kind: 'append', before: 'ab', after: 'abc', transitionKind: 'reloadFromDisk' },
			],
			pendingAgentTransitions: false,
			transitionKinds: ['agentHost', 'reloadFromDisk', 'model'],
			projectedContent: 'abcd',
		});
	});

	test('replaces a recently committed external reload when Agent Host arrives late', () => {
		const reconciler = createReconciler('before');
		reconciler.modelConnected({ content: 'before', dirty: false });
		reconciler.modelEdit(reloadEdit('before', 'after'));
		reconciler.modelEdit(modelEdit('after', 'after user'));

		const result = reconciler.agentTransition(agentEdit('before', 'after'));

		assert.deepStrictEqual({
			outcome: result.outcome,
			changes: result.changes.map(change => change.kind),
			transitionKinds: reconciler.getSnapshot().transitions.map(transition => transition.kind),
		}, {
			outcome: 'applied',
			changes: ['replace'],
			transitionKinds: ['agentHost', 'model'],
		});
	});

	test('commits unmatched reload as external on disk snapshot', () => {
		const reconciler = createReconciler('before');
		reconciler.modelConnected({ content: 'before', dirty: false });
		reconciler.modelEdit(reloadEdit('before', 'after'));

		const result = diskSnapshot(reconciler, 'after');

		assert.deepStrictEqual({
			outcome: result.outcome,
			changes: result.changes.map(change => ({
				kind: change.kind,
				before: change.before,
				after: change.after,
				source: change.transition.source,
				transitionKind: change.transition.kind,
			})),
		}, {
			outcome: 'applied',
			changes: [{
				kind: 'append',
				before: 'before',
				after: 'after',
				source: 'reload',
				transitionKind: 'reloadFromDisk',
			}],
		});
	});

	test('skips new Agent Host attribution for a dirty model', () => {
		const reconciler = createReconciler('base');
		reconciler.modelConnected({ content: 'user edit', dirty: true });

		const result = reconciler.agentTransition(agentEdit('base', 'agent edit'));

		assert.deepStrictEqual({
			outcome: result.outcome,
			content: result.snapshot.content,
			diskContent: result.snapshot.diskContent,
			model: result.snapshot.model,
			transitionCount: result.snapshot.transitions.length,
			repeatedOutcome: reconciler.agentTransition(agentEdit('base', 'agent edit')).outcome,
		}, {
			outcome: 'skippedDirty',
			content: 'base',
			diskContent: 'agent edit',
			model: { content: 'user edit', dirty: true },
			transitionCount: 0,
			repeatedOutcome: 'duplicate',
		});
	});

	test('tracks create, delete, and repeated content cycles', () => {
		const reconciler = createReconciler('');
		reconciler.agentTransition(agentEdit('', 'created', 'create-1', 'create'));
		reconciler.agentTransition(agentEdit('created', '', 'delete-1', 'delete'));
		reconciler.agentTransition(agentEdit('', 'created', 'create-2', 'create'));

		assert.deepStrictEqual(
			reconciler.getSnapshot().transitions.map(transition => ({
				agentKind: transition.agentKind,
				correlation: transition.correlation,
			})),
			[
				{ agentKind: 'create', correlation: 'create-1' },
				{ agentKind: 'delete', correlation: 'delete-1' },
				{ agentKind: 'create', correlation: 'create-2' },
			],
		);
	});

	test('does not claim an old external transition after disk content cycles', () => {
		const reconciler = createReconciler('a');
		diskSnapshot(reconciler, 'b');
		diskSnapshot(reconciler, 'a');

		assert.strictEqual(reconciler.agentTransition(agentEdit('a', 'b')).outcome, 'applied');
		assert.deepStrictEqual(
			reconciler.getSnapshot().transitions.map(transition => transition.kind),
			['diskSnapshot', 'diskSnapshot', 'agentHost'],
		);
	});

	test('treats a model save as synchronization rather than another edit', () => {
		const reconciler = createReconciler('before');
		reconciler.modelConnected({ content: 'before', dirty: false });
		reconciler.modelEdit(modelEdit('before', 'user edit'));

		assert.strictEqual(diskSnapshot(reconciler, 'user edit').outcome, 'duplicate');
		assert.deepStrictEqual({
			model: reconciler.getSnapshot().model,
			sources: reconciler.getSnapshot().transitions.map(transition => transition.source),
		}, {
			model: { content: 'user edit', dirty: false },
			sources: ['user'],
		});
	});

	test('resets compact transition history at a window boundary', () => {
		const reconciler = createReconciler('a'.repeat(10_000));
		for (let i = 0; i < 100; i++) {
			const before = reconciler.getSnapshot().content;
			const after = `${before}x`;
			reconciler.modelConnected({ content: before, dirty: false });
			reconciler.modelEdit(modelEdit(before, after));
			reconciler.modelDisconnected();
		}

		const beforeReset = reconciler.getSnapshot();
		reconciler.resetWindow();
		const afterReset = reconciler.getSnapshot();

		assert.deepStrictEqual({
			beforeTransitionCount: beforeReset.transitions.length,
			storesFullContentOnTransition: Object.hasOwn(beforeReset.transitions[0], 'before') || Object.hasOwn(beforeReset.transitions[0], 'after'),
			afterTransitionCount: afterReset.transitions.length,
			initialContentLength: afterReset.initialContent.length,
		}, {
			beforeTransitionCount: 100,
			storesFullContentOnTransition: false,
			afterTransitionCount: 0,
			initialContentLength: 10_100,
		});
	});

	test('connects a stale clean model after Agent Host and waits for reload', () => {
		const reconciler = createReconciler('before');
		reconciler.agentTransition(agentEdit('before', 'after'));

		assert.strictEqual(reconciler.modelConnected({ content: 'before', dirty: false }).outcome, 'applied');
		assert.strictEqual(reconciler.modelEdit(reloadEdit('before', 'after')).outcome, 'duplicate');
		assert.deepStrictEqual(snapshotSummary(reconciler), {
			content: 'after',
			diskContent: 'after',
			pendingReload: false,
			transitionKinds: ['agentHost'],
		});
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
		edit: createMinimalEdit(before, after),
		source: 'agent',
		correlation,
		kind,
	} as const;
}

function reloadEdit(before: string, after: string) {
	return {
		before,
		after,
		edit: createMinimalEdit(before, after),
		source: 'reload',
		kind: 'reloadFromDisk',
		dirty: false,
	} as const;
}

function modelEdit(before: string, after: string) {
	return {
		before,
		after,
		edit: createMinimalEdit(before, after),
		source: 'user',
		kind: 'model',
		dirty: true,
	} as const;
}

function diskSnapshot(reconciler: UnifiedDocumentReconciler<string>, content: string) {
	return reconciler.diskSnapshot(content, createMinimalEdit(reconciler.getSnapshot().content, content));
}

function snapshotSummary(reconciler: UnifiedDocumentReconciler<string>) {
	const snapshot = reconciler.getSnapshot();
	return {
		content: snapshot.content,
		diskContent: snapshot.diskContent,
		pendingReload: !!snapshot.pendingReload,
		transitionKinds: snapshot.transitions.map(transition => transition.kind),
	};
}
