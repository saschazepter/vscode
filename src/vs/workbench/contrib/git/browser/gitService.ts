/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IGitService, IGitExtensionService, GitRef, GitRefQuery } from '../common/gitService.js';

export class GitService extends Disposable implements IGitService {
	declare readonly _serviceBrand: undefined;

	private _delegate: IGitExtensionService | undefined;

	setDelegate(delegate: IGitExtensionService): void {
		this._delegate = delegate;
	}

	clearDelegate(): void {
		this._delegate = undefined;
	}

	async getRefs(root: URI, query?: GitRefQuery): Promise<GitRef[]> {
		if (!this._delegate) {
			return [];
		}

		return this._delegate.getRefs(root, query);
	}

	async openRepository(root: URI): Promise<URI | undefined> {
		if (!this._delegate) {
			return undefined;
		}

		const result = await this._delegate.openRepository(root);
		return result ? URI.revive(result) : undefined;
	}
}
