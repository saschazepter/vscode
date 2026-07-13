/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

export interface IIsolationFormState {
	folderUri: URI | undefined;
	isolationMode: string | undefined;
	branch: string | undefined;
}

/**
 * Pure state model for the isolation group. Separated from the view item so
 * the state transitions can be unit-tested without DOM dependencies.
 */
export class IsolationGroupModel {
	worktreeRequested: boolean;
	selectedBranch: string | undefined;
	headBranch: string | undefined;

	constructor(
		private readonly state: IIsolationFormState,
	) {
		this.worktreeRequested = state.isolationMode === 'worktree';
		this.selectedBranch = state.isolationMode === 'worktree' ? state.branch : undefined;
	}

	onWorktreeToggled(checked: boolean): void {
		this.worktreeRequested = checked;
		if (!checked) {
			this.selectedBranch = undefined;
		}
		this.recompute();
	}

	onWorkspaceChanged(folder: URI | undefined): void {
		this.selectedBranch = undefined;
		this.headBranch = undefined;
		if (!folder) {
			this.worktreeRequested = false;
		}
		this.state.folderUri = folder;
		this.recompute();
	}

	onBranchSelected(branch: string): void {
		this.selectedBranch = branch;
		this.recompute();
	}

	onHeadChanged(headBranch: string | undefined): void {
		this.headBranch = headBranch;
		this.recompute();
	}

	recompute(): void {
		const hasWorkspace = !!this.state.folderUri;
		const isolationMode = hasWorkspace && this.worktreeRequested ? 'worktree' : 'workspace';
		const effectiveBranch = !hasWorkspace
			? undefined
			: isolationMode === 'worktree'
				? this.selectedBranch ?? this.headBranch
				: this.headBranch;

		this.state.isolationMode = isolationMode;
		this.state.branch = effectiveBranch;
	}

	get branchPickerEnabled(): boolean {
		const hasWorkspace = !!this.state.folderUri;
		return hasWorkspace && this.worktreeRequested;
	}

	get checkboxEnabled(): boolean {
		return !!this.state.folderUri;
	}
}
