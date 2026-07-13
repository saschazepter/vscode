/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { IIsolationFormState, IsolationGroupModel } from '../../common/isolationGroupModel.js';

const FOLDER_A = URI.parse('file:///workspace/a');
const FOLDER_B = URI.parse('file:///workspace/b');

function createState(overrides?: Partial<IIsolationFormState>): IIsolationFormState {
	return {
		folderUri: undefined,
		isolationMode: 'workspace',
		branch: undefined,
		...overrides,
	};
}

suite('IsolationGroupModel', () => {

	test('initializes with workspace mode by default', () => {
		const state = createState();
		const model = new IsolationGroupModel(state);
		model.recompute();
		assert.strictEqual(state.isolationMode, 'workspace');
		assert.strictEqual(state.branch, undefined);
	});

	test('initializes worktreeRequested from state.isolationMode', () => {
		const state = createState({ isolationMode: 'worktree', folderUri: FOLDER_A });
		const model = new IsolationGroupModel(state);
		assert.strictEqual(model.worktreeRequested, true);
	});

	test('preserves initial branch as selectedBranch for edits', () => {
		const state = createState({
			isolationMode: 'worktree',
			folderUri: FOLDER_A,
			branch: 'feature/existing',
		});
		const model = new IsolationGroupModel(state);
		model.recompute();
		assert.strictEqual(state.branch, 'feature/existing');
	});

	test('selecting workspace sets folderUri and keeps workspace mode', () => {
		const state = createState();
		const model = new IsolationGroupModel(state);
		model.onWorkspaceChanged(FOLDER_A);
		assert.strictEqual(state.folderUri?.toString(), FOLDER_A.toString());
		assert.strictEqual(state.isolationMode, 'workspace');
	});

	test('selecting workspace with HEAD sets branch to HEAD', () => {
		const state = createState();
		const model = new IsolationGroupModel(state);
		model.onWorkspaceChanged(FOLDER_A);
		model.onHeadChanged('main');
		assert.strictEqual(state.branch, 'main');
	});

	test('switching workspace resets selectedBranch', () => {
		const state = createState({ folderUri: FOLDER_A, isolationMode: 'worktree' });
		const model = new IsolationGroupModel(state);
		model.onHeadChanged('main');
		model.onBranchSelected('feature-x');
		assert.strictEqual(state.branch, 'feature-x');

		model.onWorkspaceChanged(FOLDER_B);
		model.onHeadChanged('main');
		assert.strictEqual(state.branch, 'main');
		assert.strictEqual(model.selectedBranch, undefined);
	});

	test('switching workspace keeps worktreeRequested', () => {
		const state = createState({ folderUri: FOLDER_A, isolationMode: 'worktree' });
		const model = new IsolationGroupModel(state);
		model.onWorkspaceChanged(FOLDER_B);
		assert.strictEqual(model.worktreeRequested, true);
		assert.strictEqual(state.isolationMode, 'worktree');
	});

	test('deselecting workspace clears worktreeRequested', () => {
		const state = createState({ folderUri: FOLDER_A, isolationMode: 'worktree' });
		const model = new IsolationGroupModel(state);
		model.onWorkspaceChanged(undefined);
		assert.strictEqual(model.worktreeRequested, false);
		assert.strictEqual(state.isolationMode, 'workspace');
		assert.strictEqual(state.branch, undefined);
	});

	test('checking worktree sets isolationMode and uses HEAD as branch', () => {
		const state = createState({ folderUri: FOLDER_A });
		const model = new IsolationGroupModel(state);
		model.onHeadChanged('main');
		model.onWorktreeToggled(true);
		assert.strictEqual(state.isolationMode, 'worktree');
		assert.strictEqual(state.branch, 'main');
	});

	test('unchecking worktree resets to HEAD and clears selectedBranch', () => {
		const state = createState({ folderUri: FOLDER_A, isolationMode: 'worktree' });
		const model = new IsolationGroupModel(state);
		model.onHeadChanged('main');
		model.onBranchSelected('feature-x');
		assert.strictEqual(state.branch, 'feature-x');

		model.onWorktreeToggled(false);
		assert.strictEqual(state.isolationMode, 'workspace');
		assert.strictEqual(state.branch, 'main');
		assert.strictEqual(model.selectedBranch, undefined);
	});

	test('unchecking worktree without HEAD clears branch', () => {
		const state = createState({ folderUri: FOLDER_A, isolationMode: 'worktree' });
		const model = new IsolationGroupModel(state);
		model.onWorktreeToggled(false);
		assert.strictEqual(state.branch, undefined);
	});

	test('selecting branch in worktree mode updates state.branch', () => {
		const state = createState({ folderUri: FOLDER_A, isolationMode: 'worktree' });
		const model = new IsolationGroupModel(state);
		model.onHeadChanged('main');
		model.onBranchSelected('feature-x');
		assert.strictEqual(state.branch, 'feature-x');
	});

	test('editing automation preserves original branch until workspace change', () => {
		const state = createState({
			folderUri: FOLDER_A,
			isolationMode: 'worktree',
			branch: 'agents/qualified-octopus',
		});
		const model = new IsolationGroupModel(state);
		model.onHeadChanged('main');
		assert.strictEqual(state.branch, 'agents/qualified-octopus');
	});

	test('editing automation resets branch when switching workspace', () => {
		const state = createState({
			folderUri: FOLDER_A,
			isolationMode: 'worktree',
			branch: 'agents/qualified-octopus',
		});
		const model = new IsolationGroupModel(state);
		model.onHeadChanged('main');

		model.onWorkspaceChanged(FOLDER_B);
		model.onHeadChanged('main');
		assert.strictEqual(state.branch, 'main');
	});

	test('editing automation save without changes keeps original branch', () => {
		const state = createState({
			folderUri: FOLDER_A,
			isolationMode: 'worktree',
			branch: 'feature/custom',
		});
		const model = new IsolationGroupModel(state);
		model.onHeadChanged('main');
		assert.strictEqual(state.branch, 'feature/custom');
		assert.strictEqual(state.isolationMode, 'worktree');
	});

	test('workspace-mode saved branch does not leak into worktree toggle', () => {
		const state = createState({
			folderUri: FOLDER_A,
			isolationMode: 'workspace',
			branch: 'stale-head-at-save-time',
		});
		const model = new IsolationGroupModel(state);
		model.onHeadChanged('current-head');

		model.onWorktreeToggled(true);
		assert.strictEqual(state.branch, 'current-head');
		assert.notStrictEqual(state.branch, 'stale-head-at-save-time');
	});

	test('branchPickerEnabled requires worktree mode and workspace', () => {
		const state = createState({ folderUri: FOLDER_A, isolationMode: 'worktree' });
		const model = new IsolationGroupModel(state);
		assert.strictEqual(model.branchPickerEnabled, true);

		model.onWorkspaceChanged(undefined);
		assert.strictEqual(model.branchPickerEnabled, false);
	});

	test('branchPickerEnabled is false in workspace mode', () => {
		const state = createState({ folderUri: FOLDER_A });
		const model = new IsolationGroupModel(state);
		assert.strictEqual(model.branchPickerEnabled, false);
	});

	test('checkboxEnabled requires workspace', () => {
		const state = createState();
		const model = new IsolationGroupModel(state);
		assert.strictEqual(model.checkboxEnabled, false);

		model.onWorkspaceChanged(FOLDER_A);
		assert.strictEqual(model.checkboxEnabled, true);
	});

	test('workspace mode always shows HEAD regardless of selectedBranch', () => {
		const state = createState({ folderUri: FOLDER_A });
		const model = new IsolationGroupModel(state);
		model.onHeadChanged('main');
		assert.strictEqual(state.branch, 'main');
		assert.strictEqual(state.isolationMode, 'workspace');
	});

	test('worktree toggle does nothing without workspace', () => {
		const state = createState();
		const model = new IsolationGroupModel(state);
		model.onWorktreeToggled(true);
		assert.strictEqual(state.isolationMode, 'workspace');
		assert.strictEqual(state.branch, undefined);
	});

	test('branch shows undefined without workspace even with HEAD', () => {
		const state = createState();
		const model = new IsolationGroupModel(state);
		model.onHeadChanged('main');
		model.recompute();
		assert.strictEqual(state.branch, undefined);
	});

	test('full flow: select workspace then check worktree then pick branch', () => {
		const state = createState();
		const model = new IsolationGroupModel(state);

		model.onWorkspaceChanged(FOLDER_A);
		model.onHeadChanged('main');
		assert.strictEqual(state.branch, 'main');

		model.onWorktreeToggled(true);
		assert.strictEqual(state.branch, 'main');
		assert.strictEqual(state.isolationMode, 'worktree');

		model.onBranchSelected('feature-x');
		assert.strictEqual(state.branch, 'feature-x');
		assert.strictEqual(state.folderUri?.toString(), FOLDER_A.toString());
		assert.strictEqual(state.isolationMode, 'worktree');
	});

	test('full flow: pick branch then switch workspace uses new HEAD', () => {
		const state = createState({ folderUri: FOLDER_A });
		const model = new IsolationGroupModel(state);
		model.onHeadChanged('main');

		model.onWorktreeToggled(true);
		model.onBranchSelected('feature-x');
		assert.strictEqual(state.branch, 'feature-x');

		model.onWorkspaceChanged(FOLDER_B);
		model.onHeadChanged('develop');
		assert.strictEqual(state.folderUri?.toString(), FOLDER_B.toString());
		assert.strictEqual(state.isolationMode, 'worktree');
		assert.strictEqual(state.branch, 'develop');
	});

	test('full flow: pick branch then uncheck worktree uses HEAD', () => {
		const state = createState({ folderUri: FOLDER_A });
		const model = new IsolationGroupModel(state);
		model.onHeadChanged('main');

		model.onWorktreeToggled(true);
		model.onBranchSelected('feature-x');
		model.onWorktreeToggled(false);

		assert.strictEqual(state.isolationMode, 'workspace');
		assert.strictEqual(state.branch, 'main');
	});

	test('full flow: edit existing then switch workspace gets new HEAD', () => {
		const state = createState({
			folderUri: FOLDER_A,
			isolationMode: 'worktree',
			branch: 'agents/qualified-octopus',
		});
		const model = new IsolationGroupModel(state);
		model.onHeadChanged('main');
		assert.strictEqual(state.branch, 'agents/qualified-octopus');

		model.onWorkspaceChanged(FOLDER_B);
		assert.strictEqual(state.branch, undefined);

		model.onHeadChanged('main');
		assert.strictEqual(state.branch, 'main');
		assert.notStrictEqual(state.branch, 'agents/qualified-octopus');
	});
});
