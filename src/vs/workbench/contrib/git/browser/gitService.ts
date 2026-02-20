/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer, timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { observableValue, waitForState } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { IGitService, IGitExtensionDelegate, GitRef, GitRefQuery, IGitRepository } from '../common/gitService.js';

export class GitService extends Disposable implements IGitService {
	declare readonly _serviceBrand: undefined;

	private _delegate: IGitExtensionDelegate | undefined;
	private readonly _openRepositorySequencer = new Sequencer();

	private readonly _repositories = new ResourceMap<IGitRepository>();
	get repositories(): Iterable<IGitRepository> {
		return this._repositories.values();
	}

	readonly isInitialized = observableValue(this, false);

	setDelegate(delegate: IGitExtensionDelegate): IDisposable {
		this._delegate = delegate;
		this.isInitialized.set(true, undefined);

		return toDisposable(() => {
			this._repositories.clear();
			this._delegate = undefined;

			this.isInitialized.set(false, undefined);
		});
	}

	async openRepository(uri: URI): Promise<IGitRepository | undefined> {
		return this._openRepositorySequencer.queue(async () => {
			// Wait for the delegate to be set, but don't wait indefinitely (5 seconds)
			await Promise.race([waitForState(this.isInitialized, isInitialized => isInitialized), timeout(5000)]);

			if (!this._delegate) {
				return undefined;
			}

			const root = await this._delegate.openRepository(uri);
			if (!root) {
				return undefined;
			}

			const rootUri = URI.revive(root);
			let repository = this._repositories.get(rootUri);
			if (repository) {
				return repository;
			}

			repository = new GitRepository(this._delegate, rootUri);
			this._repositories.set(rootUri, repository);
			return repository;
		});
	}
}

export class GitRepository implements IGitRepository {
	constructor(private readonly delegate: IGitExtensionDelegate, readonly rootUri: URI) { }

	async getRefs(query: GitRefQuery, token?: CancellationToken): Promise<GitRef[]> {
		return this.delegate.getRefs(this.rootUri, query, token);
	}
}
