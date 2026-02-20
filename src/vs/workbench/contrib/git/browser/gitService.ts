/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { IGitService, IGitExtensionDelegate, GitRef, GitRefQuery, IGitRepository } from '../common/gitService.js';

export class GitService extends Disposable implements IGitService {
	declare readonly _serviceBrand: undefined;

	private _delegate: IGitExtensionDelegate | undefined;

	private readonly _repositories = new ResourceMap<IGitRepository>();
	get repositories(): Iterable<IGitRepository> {
		return this._repositories.values();
	}

	readonly isInitialized = observableValue(this, false);

	setDelegate(delegate: IGitExtensionDelegate): IDisposable {
		this._delegate = delegate;
		this.isInitialized.set(true, undefined);

		return toDisposable(() => {
			this._delegate = undefined;
			this._repositories.clear();
			this.isInitialized.set(false, undefined);
		});
	}

	async openRepository(uri: URI): Promise<IGitRepository | undefined> {
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
	}
}

export class GitRepository implements IGitRepository {
	constructor(private readonly delegate: IGitExtensionDelegate, readonly rootUri: URI) { }

	async getRefs(query: GitRefQuery, token?: CancellationToken): Promise<GitRef[]> {
		return this.delegate.getRefs(this.rootUri, query, token);
	}
}
