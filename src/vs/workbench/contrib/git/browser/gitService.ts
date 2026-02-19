/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IGitService, IGitExtensionService } from '../common/gitService.js';

export class GitService extends Disposable implements IGitService {
	declare readonly _serviceBrand: undefined;

	private _delegate: IGitExtensionService | undefined;

	setDelegate(delegate: IGitExtensionService): void {
		this._delegate = delegate;
	}

	clearDelegate(): void {
		this._delegate = undefined;
	}

	async openRepository(root: URI): Promise<URI | undefined> {
		if (!this._delegate) {
			return undefined;
		}

		const result = await this._delegate.openRepository(root);
		return result ? URI.revive(result) : undefined;
	}
}
