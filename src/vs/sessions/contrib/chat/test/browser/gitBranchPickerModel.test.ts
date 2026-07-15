/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { GitRef, GitRefType, GitRepositoryState, IGitRepository, IGitService } from '../../../../../workbench/contrib/git/common/gitService.js';
import { GitBranchPickerModel } from '../../browser/gitBranchPickerModel.js';

function createRepository(rootUri: URI, branch: string, refs: readonly string[], options?: { getRefs?: (query: unknown, token?: CancellationToken) => Promise<GitRef[]> }): IGitRepository {
	const state = observableValue<GitRepositoryState>('gitState', {
		HEAD: { type: GitRefType.Head, name: branch, commit: 'commit' },
		remotes: [],
		mergeChanges: [],
		indexChanges: [],
		workingTreeChanges: [],
		untrackedChanges: [],
	});
	return {
		rootUri,
		state,
		updateState: next => state.set(next, undefined),
		getRefs: options?.getRefs ?? (async () => refs.map(name => ({ type: GitRefType.Head, name } satisfies GitRef))),
		diffBetweenWithStats: async () => [],
		diffBetweenWithStats2: async () => [],
	};
}

suite('GitBranchPickerModel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('loads branches, filters generated worktrees, and restores a saved branch', async () => {
		const folder = URI.file('/repo');
		const repository = createRepository(folder, 'current', ['current', 'main', 'saved', 'copilot-worktree-old']);
		const folderObs = observableValue<URI | undefined>('folder', folder);
		const isolationMode = observableValue<string | undefined>('isolationMode', 'worktree');
		let selectedBranch: string | undefined;
		const gitService = upcastPartial<IGitService>({ openRepository: async () => repository });
		const model = store.add(new GitBranchPickerModel('saved', folderObs, isolationMode, branch => selectedBranch = branch, gitService, new NullLogService()));

		await timeout(0);

		assert.deepStrictEqual({
			branches: model.branches.get(),
			selectedBranch: model.selectedBranch.get(),
			disabled: model.disabled.get(),
			formBranch: selectedBranch,
		}, {
			branches: ['current', 'main', 'saved'],
			selectedBranch: 'saved',
			disabled: false,
			formBranch: 'saved',
		});
	});

	test('tracks HEAD in Folder mode and uses the default branch in Worktree mode', async () => {
		const folder = URI.file('/repo');
		const repository = createRepository(folder, 'feature', ['feature', 'main']);
		const folderObs = observableValue<URI | undefined>('folder', folder);
		const isolationMode = observableValue<string | undefined>('isolationMode', 'workspace');
		let selectedBranch: string | undefined;
		const gitService = upcastPartial<IGitService>({ openRepository: async () => repository });
		const model = store.add(new GitBranchPickerModel(undefined, folderObs, isolationMode, branch => selectedBranch = branch, gitService, new NullLogService()));
		await timeout(0);

		isolationMode.set('worktree', undefined);
		const worktreeState = {
			selectedBranch: model.selectedBranch.get(),
			disabled: model.disabled.get(),
		};
		model.setBranch('feature');
		isolationMode.set('workspace', undefined);
		repository.updateState({
			...repository.state.get(),
			HEAD: { type: GitRefType.Head, name: 'main', commit: 'next' },
		});

		assert.deepStrictEqual({
			worktreeState,
			folderBranch: model.selectedBranch.get(),
			formBranch: selectedBranch,
			disabled: model.disabled.get(),
		}, {
			worktreeState: { selectedBranch: 'main', disabled: false },
			folderBranch: 'main',
			formBranch: 'main',
			disabled: true,
		});
	});

	test('restores user-picked branch when re-enabling worktree mode', async () => {
		const folder = URI.file('/repo');
		const repository = createRepository(folder, 'main', ['main', 'feature', 'dev']);
		const folderObs = observableValue<URI | undefined>('folder', folder);
		const isolationMode = observableValue<string | undefined>('isolationMode', 'worktree');
		let selectedBranch: string | undefined;
		const gitService = upcastPartial<IGitService>({ openRepository: async () => repository });
		const model = store.add(new GitBranchPickerModel(undefined, folderObs, isolationMode, branch => selectedBranch = branch, gitService, new NullLogService()));
		await timeout(0);

		// User explicitly picks 'feature'
		model.setBranch('feature');
		assert.strictEqual(model.selectedBranch.get(), 'feature');

		// Toggle to workspace mode (tracks HEAD)
		isolationMode.set('workspace', undefined);
		assert.strictEqual(model.selectedBranch.get(), 'main');

		// Toggle back to worktree mode — should restore 'feature', not 'main'
		isolationMode.set('worktree', undefined);
		assert.deepStrictEqual({
			selectedBranch: model.selectedBranch.get(),
			formBranch: selectedBranch,
		}, {
			selectedBranch: 'feature',
			formBranch: 'feature',
		});
	});

	test('ignores a stale repository result after the folder changes', async () => {
		const firstFolder = URI.file('/first');
		const secondFolder = URI.file('/second');
		const firstRepository = new DeferredPromise<IGitRepository | undefined>();
		const secondRepository = createRepository(secondFolder, 'second', ['second']);
		const folderObs = observableValue<URI | undefined>('folder', firstFolder);
		const isolationMode = observableValue<string | undefined>('isolationMode', 'worktree');
		const gitService = upcastPartial<IGitService>({
			openRepository: (folder: URI) => isEqual(folder, firstFolder)
				? firstRepository.p
				: Promise.resolve(secondRepository),
		});
		const model = store.add(new GitBranchPickerModel(undefined, folderObs, isolationMode, () => { }, gitService, new NullLogService()));

		folderObs.set(secondFolder, undefined);
		await timeout(0);
		firstRepository.complete(createRepository(firstFolder, 'first', ['first']));
		await timeout(0);

		assert.deepStrictEqual({
			branches: model.branches.get(),
			selectedBranch: model.selectedBranch.get(),
		}, {
			branches: ['second'],
			selectedBranch: 'second',
		});
	});

	test('handles openRepository rejection gracefully', async () => {
		const folder = URI.file('/repo');
		const folderObs = observableValue<URI | undefined>('folder', folder);
		const isolationMode = observableValue<string | undefined>('isolationMode', 'worktree');
		let selectedBranch: string | undefined = 'initial';
		const gitService = upcastPartial<IGitService>({
			openRepository: async () => { throw new Error('no git'); },
		});
		const model = store.add(new GitBranchPickerModel(undefined, folderObs, isolationMode, branch => selectedBranch = branch, gitService, new NullLogService()));

		await timeout(0);

		assert.deepStrictEqual({
			branches: model.branches.get(),
			selectedBranch: model.selectedBranch.get(),
			disabled: model.disabled.get(),
			formBranch: selectedBranch,
		}, {
			branches: [],
			selectedBranch: undefined,
			disabled: true,
			formBranch: undefined,
		});
	});

	test('handles getRefs rejection gracefully', async () => {
		const folder = URI.file('/repo');
		const repository = createRepository(folder, 'main', [], {
			getRefs: async () => { throw new Error('network error'); },
		});
		const folderObs = observableValue<URI | undefined>('folder', folder);
		const isolationMode = observableValue<string | undefined>('isolationMode', 'worktree');
		let selectedBranch: string | undefined = 'initial';
		const gitService = upcastPartial<IGitService>({ openRepository: async () => repository });
		const model = store.add(new GitBranchPickerModel(undefined, folderObs, isolationMode, branch => selectedBranch = branch, gitService, new NullLogService()));

		await timeout(0);

		assert.deepStrictEqual({
			branches: model.branches.get(),
			selectedBranch: model.selectedBranch.get(),
			disabled: model.disabled.get(),
			formBranch: selectedBranch,
		}, {
			branches: [],
			selectedBranch: undefined,
			disabled: true,
			formBranch: undefined,
		});
	});

	test('cancels in-flight getRefs when folder changes', async () => {
		const firstFolder = URI.file('/first');
		const secondFolder = URI.file('/second');
		const refsDeferred = new DeferredPromise<GitRef[]>();
		const firstRepository = createRepository(firstFolder, 'first', [], {
			getRefs: async (_query, token) => {
				const result = await refsDeferred.p;
				if (token?.isCancellationRequested) {
					throw new Error('cancelled');
				}
				return result;
			},
		});
		const secondRepository = createRepository(secondFolder, 'second', ['second']);
		const folderObs = observableValue<URI | undefined>('folder', firstFolder);
		const isolationMode = observableValue<string | undefined>('isolationMode', 'worktree');
		const gitService = upcastPartial<IGitService>({
			openRepository: (folder: URI) => isEqual(folder, firstFolder)
				? Promise.resolve(firstRepository)
				: Promise.resolve(secondRepository),
		});
		const model = store.add(new GitBranchPickerModel(undefined, folderObs, isolationMode, () => { }, gitService, new NullLogService()));

		await timeout(0); // first repo opens, getRefs starts

		folderObs.set(secondFolder, undefined);
		await timeout(0); // second repo opens and resolves

		// Resolve the first getRefs (should be ignored due to cancellation/stale requestId)
		refsDeferred.complete([{ type: GitRefType.Head, name: 'stale' }]);
		await timeout(0);

		assert.deepStrictEqual({
			branches: model.branches.get(),
			selectedBranch: model.selectedBranch.get(),
		}, {
			branches: ['second'],
			selectedBranch: 'second',
		});
	});

	test('disposal during pending openRepository does not invoke callback', async () => {
		const folder = URI.file('/repo');
		const openDeferred = new DeferredPromise<IGitRepository | undefined>();
		const folderObs = observableValue<URI | undefined>('folder', folder);
		const isolationMode = observableValue<string | undefined>('isolationMode', 'worktree');
		let callbackInvoked = false;
		const gitService = upcastPartial<IGitService>({ openRepository: async () => openDeferred.p });
		const model = store.add(new GitBranchPickerModel(undefined, folderObs, isolationMode, () => { callbackInvoked = true; }, gitService, new NullLogService()));

		// Reset the flag after initial construction callback
		await timeout(0);
		callbackInvoked = false;

		model.dispose();
		openDeferred.complete(createRepository(folder, 'main', ['main']));
		await timeout(0);

		assert.strictEqual(callbackInvoked, false, 'callback should not fire after disposal');
	});

	test('clearing folder sets branches to empty and notifies callback', async () => {
		const folder = URI.file('/repo');
		const repository = createRepository(folder, 'main', ['main', 'dev']);
		const folderObs = observableValue<URI | undefined>('folder', folder);
		const isolationMode = observableValue<string | undefined>('isolationMode', 'worktree');
		let selectedBranch: string | undefined;
		const gitService = upcastPartial<IGitService>({ openRepository: async () => repository });
		const model = store.add(new GitBranchPickerModel(undefined, folderObs, isolationMode, branch => selectedBranch = branch, gitService, new NullLogService()));

		await timeout(0);
		assert.strictEqual(model.branches.get().length, 2);

		folderObs.set(undefined, undefined);
		await timeout(0);

		assert.deepStrictEqual({
			branches: model.branches.get(),
			selectedBranch: model.selectedBranch.get(),
			formBranch: selectedBranch,
		}, {
			branches: [],
			selectedBranch: undefined,
			formBranch: undefined,
		});
	});
});
