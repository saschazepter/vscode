/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, ITransaction, observableValue, transaction } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IGitRepository, IGitService } from '../../../../workbench/contrib/git/common/gitService.js';
import { IBranchPickerModel } from './branchPicker.js';
import { COPILOT_WORKTREE_BRANCH_PREFIX } from '../common/constants.js';

/**
 * Shared model that loads git branches for a given folder and isolation mode,
 * implementing {@link IBranchPickerModel} so it can drive the {@link BranchPicker} widget.
 *
 * Handles: repository opening, HEAD watching, ref fetching, worktree-branch
 * filtering, and default-branch heuristics.
 */
export class GitBranchPickerModel extends Disposable implements IBranchPickerModel {

	private readonly _branches = observableValue<readonly string[]>(this, []);
	readonly branches: IObservable<readonly string[]> = this._branches;

	private readonly _selectedBranch = observableValue<string | undefined>(this, undefined);
	readonly selectedBranch: IObservable<string | undefined> = this._selectedBranch;

	private readonly _loading = observableValue(this, false);
	readonly disabled = derived(this, reader =>
		this._loading.read(reader)
		|| this._isolationMode.read(reader) !== 'worktree'
		|| this._branches.read(reader).length === 0
	);

	private readonly _repositoryState = this._register(new MutableDisposable());
	private readonly _refsCancellation = this._register(new MutableDisposable<CancellationTokenSource>());
	private _repository: IGitRepository | undefined;
	private _defaultBranch: string | undefined;
	private _preferredBranch: string | undefined;
	private _requestId = 0;
	private _lastIsolationMode: string | undefined;

	constructor(
		initialBranch: string | undefined,
		private readonly _folder: IObservable<URI | undefined>,
		private readonly _isolationMode: IObservable<string | undefined>,
		private readonly _onDidChangeBranch: (branch: string | undefined) => void,
		@IGitService private readonly _gitService: IGitService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._preferredBranch = initialBranch;
		this._lastIsolationMode = this._isolationMode.get();

		let didResolveFolder = false;
		this._register(autorun(reader => {
			const folder = this._folder.read(reader);
			if (didResolveFolder) {
				this._preferredBranch = undefined;
			}
			const preserveSelection = !didResolveFolder;
			didResolveFolder = true;
			this._resolveRepository(folder, preserveSelection);
		}));

		this._register(autorun(reader => {
			const mode = this._isolationMode.read(reader);
			if (mode === this._lastIsolationMode) {
				return;
			}
			this._lastIsolationMode = mode;
			if (mode === 'worktree') {
				const branches = this._branches.read(undefined);
				const selected = this._preferredBranch && branches.includes(this._preferredBranch)
					? this._preferredBranch
					: this._defaultBranch;
				this._setSelectedBranch(selected);
			} else {
				this._syncFolderBranch();
			}
		}));
	}

	setBranch(name: string): void {
		if (!this._branches.get().includes(name)) {
			return;
		}
		this._preferredBranch = name;
		this._setSelectedBranch(name);
	}

	private async _resolveRepository(folder: URI | undefined, preserveSelection: boolean): Promise<void> {
		const requestId = ++this._requestId;
		this._repositoryState.clear();
		this._cancelRefsLoad();
		this._repository = undefined;
		this._defaultBranch = undefined;
		transaction(tx => {
			this._branches.set([], tx);
			this._loading.set(!!folder, tx);
			this._setSelectedBranch(preserveSelection ? this._preferredBranch : undefined, tx);
		});

		if (!folder) {
			this._setSelectedBranch(undefined);
			return;
		}

		let repository: IGitRepository | undefined;
		try {
			repository = await this._gitService.openRepository(folder);
		} catch (error) {
			if (requestId === this._requestId) {
				this._logService.trace('[GitBranchPickerModel] Failed to open Git repository.', error);
				transaction(tx => {
					this._loading.set(false, tx);
					this._setSelectedBranch(undefined, tx);
				});
			}
			return;
		}

		if (requestId !== this._requestId || !repository) {
			if (requestId === this._requestId) {
				transaction(tx => {
					this._loading.set(false, tx);
					this._setSelectedBranch(undefined, tx);
				});
			}
			return;
		}

		this._repository = repository;
		this._repositoryState.value = autorun(reader => {
			repository.state.read(reader);
			if (this._isolationMode.read(reader) !== 'worktree') {
				this._syncFolderBranch();
			}
		});

		const cancellation = new CancellationTokenSource();
		this._refsCancellation.value = cancellation;
		try {
			const refs = await repository.getRefs({ pattern: 'refs/heads' }, cancellation.token);
			if (requestId !== this._requestId || cancellation.token.isCancellationRequested) {
				return;
			}

			const branches = refs
				.map(ref => ref.name)
				.filter((name): name is string => !!name)
				.filter(name => !name.includes(COPILOT_WORKTREE_BRANCH_PREFIX));
			const currentBranch = this._getCurrentBranch();
			this._defaultBranch = branches.find(branch => branch === 'main')
				?? branches.find(branch => branch === 'master')
				?? branches.find(branch => branch === currentBranch)
				?? branches[0];

			let selectedBranch: string | undefined;
			if (this._isolationMode.get() === 'worktree') {
				selectedBranch = this._preferredBranch && branches.includes(this._preferredBranch)
					? this._preferredBranch
					: this._defaultBranch;
			} else {
				selectedBranch = this._getCurrentBranch() ?? this._defaultBranch;
			}
			transaction(tx => {
				this._branches.set(branches, tx);
				this._setSelectedBranch(selectedBranch, tx);
			});
		} catch (error) {
			if (!cancellation.token.isCancellationRequested && requestId === this._requestId) {
				this._logService.trace('[GitBranchPickerModel] Failed to load Git branches.', error);
				transaction(tx => {
					this._branches.set([], tx);
					this._setSelectedBranch(undefined, tx);
				});
			}
		} finally {
			if (requestId === this._requestId) {
				this._loading.set(false, undefined);
			}
		}
	}

	private _syncFolderBranch(): void {
		this._setSelectedBranch(this._getCurrentBranch() ?? this._defaultBranch);
	}

	private _getCurrentBranch(): string | undefined {
		const head = this._repository?.state.get().HEAD;
		return head?.commit ? head.name : undefined;
	}

	private _setSelectedBranch(branch: string | undefined, tx: ITransaction | undefined = undefined): void {
		this._selectedBranch.set(branch, tx);
		this._onDidChangeBranch(branch);
	}

	private _cancelRefsLoad(): void {
		this._refsCancellation.value?.cancel();
		this._refsCancellation.clear();
	}

	override dispose(): void {
		++this._requestId;
		this._cancelRefsLoad();
		super.dispose();
	}
}
