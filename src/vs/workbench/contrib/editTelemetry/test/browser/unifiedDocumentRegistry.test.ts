/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createMinimalEdit } from '../../browser/helpers/unifiedDocumentReconciler.js';
import { UnifiedDocumentRegistry } from '../../browser/helpers/unifiedDocumentRegistry.js';

suite('UnifiedDocumentRegistry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses canonical resource identity', () => {
		const registry = createRegistry();
		const first = URI.file('C:\\repo\\File.ts');
		const alias = URI.file('c:\\REPO\\file.ts');

		registry.agentTransition(first, agentEdit('', 'content'));

		assert.strictEqual(registry.get(alias), registry.get(first));
		assert.strictEqual(registry.size, 1);
	});

	test('keeps matching remote paths on different authorities separate', () => {
		const registry = createRegistry();
		const first = URI.from({ scheme: 'vscode-agent-host', authority: 'remote-one', path: '/repo/file.ts' });
		const second = URI.from({ scheme: 'vscode-agent-host', authority: 'remote-two', path: '/repo/file.ts' });

		registry.diskSnapshot(first, 'one', createMinimalEdit('one', 'one'));
		registry.diskSnapshot(second, 'two', createMinimalEdit('two', 'two'));

		assert.strictEqual(registry.size, 2);
		assert.notStrictEqual(registry.get(first), registry.get(second));
	});

	test('lazily creates a reconciler from an Agent Host transition', () => {
		const registry = createRegistry();
		const resource = URI.file('C:\\repo\\file.ts');

		const result = registry.agentTransition(resource, agentEdit('before', 'after'));

		assert.deepStrictEqual(
			{
				outcome: result.outcome,
				resource: result.resource.toString(),
				snapshot: registry.get(resource)?.reconciler.getSnapshot(),
			},
			{
				outcome: 'applied',
				resource: URI.file('c:\\repo\\file.ts').toString(),
				snapshot: {
					initialContent: 'before',
					content: 'after',
					diskContent: 'after',
					model: undefined,
					pendingReload: undefined,
					pendingAgentTransitions: false,
					transitions: [{
						id: 1,
						edit: createMinimalEdit('before', 'after'),
						source: 'agent',
						kind: 'agentHost',
						correlation: 'agent-1',
						agentKind: 'edit',
					}],
				},
			},
		);
	});

	test('preserves one reconciler across model connect and disconnect', () => {
		const registry = createRegistry();
		const resource = URI.file('C:\\repo\\file.ts');
		registry.agentTransition(resource, agentEdit('before', 'after'));
		const reconciler = registry.get(resource)?.reconciler;

		assert.strictEqual(registry.modelConnected(resource, 'before', { content: 'after', dirty: false }).outcome, 'applied');
		assert.strictEqual(registry.modelDisconnected(resource).outcome, 'applied');
		assert.strictEqual(registry.modelConnected(resource, 'unused', { content: 'after', dirty: false }).outcome, 'applied');
		assert.strictEqual(registry.get(resource)?.reconciler, reconciler);
	});

	test('transfers reconciler identity across a rename', () => {
		const registry = createRegistry();
		const before = URI.file('C:\\repo\\before.ts');
		const after = URI.file('C:\\repo\\after.ts');
		registry.agentTransition(before, agentEdit('content', 'content', 'rename-1', 'rename'));
		const reconciler = registry.get(before)?.reconciler;

		const result = registry.transfer(before, after);

		assert.deepStrictEqual(
			{
				outcome: result.outcome,
				oldEntry: registry.get(before),
				sameReconciler: registry.get(after)?.reconciler === reconciler,
			},
			{ outcome: 'applied', oldEntry: undefined, sameReconciler: true },
		);
	});

	test('rejects a rename onto an existing resource', () => {
		const registry = createRegistry();
		const before = URI.file('C:\\repo\\before.ts');
		const after = URI.file('C:\\repo\\after.ts');
		registry.diskSnapshot(before, 'before', createMinimalEdit('before', 'before'));
		registry.diskSnapshot(after, 'after', createMinimalEdit('after', 'after'));

		assert.strictEqual(registry.transfer(before, after).outcome, 'conflict');
		assert.strictEqual(registry.size, 2);
	});

	test('treats a canonical-only rename as a duplicate', () => {
		const registry = createRegistry();
		const before = URI.file('C:\\repo\\File.ts');
		const after = URI.file('c:\\REPO\\file.ts');
		registry.diskSnapshot(before, 'content', createMinimalEdit('content', 'content'));

		assert.strictEqual(registry.transfer(before, after).outcome, 'duplicate');
		assert.strictEqual(registry.size, 1);
		assert.strictEqual(registry.get(after)?.resource.toString(), URI.file('c:\\repo\\file.ts').toString());
	});

	test('reports model inputs for unknown resources explicitly', () => {
		const registry = createRegistry();
		const resource = URI.file('C:\\repo\\file.ts');

		assert.strictEqual(registry.modelDisconnected(resource).outcome, 'duplicate');
		assert.strictEqual(registry.modelEdit(resource, {
			before: 'before',
			after: 'after',
			edit: createMinimalEdit('before', 'after'),
			source: 'user',
			kind: 'model',
			dirty: true,
		}).outcome, 'conflict');
	});

	test('deletes and clears registry entries', () => {
		const registry = createRegistry();
		const first = URI.file('C:\\repo\\first.ts');
		const second = URI.file('C:\\repo\\second.ts');
		registry.diskSnapshot(first, 'first', createMinimalEdit('first', 'first'));
		registry.diskSnapshot(second, 'second', createMinimalEdit('second', 'second'));

		assert.strictEqual(registry.delete(first), true);
		assert.strictEqual(registry.delete(first), false);
		registry.clear();
		assert.strictEqual(registry.size, 0);
	});
});

function createRegistry(): UnifiedDocumentRegistry<string> {
	return new UnifiedDocumentRegistry({
		externalSource: 'external',
		canonicalize: resource => resource.with({ path: resource.path.toLowerCase() }),
		getComparisonKey: resource => resource.toString().toLowerCase(),
	});
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
