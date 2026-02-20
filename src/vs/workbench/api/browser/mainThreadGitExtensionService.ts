/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js'; import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { GitRefType as ExtHostGitRefType } from '../../api/common/extHostGitExtensionService.js';
import { IGitExtensionDelegate, IGitService, GitRef, GitRefQuery, GitRefType } from '../../contrib/git/common/gitService.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { ExtHostContext, ExtHostGitExtensionShape, MainContext, MainThreadGitExtensionShape } from '../common/extHost.protocol.js';

function toGitRefType(type: ExtHostGitRefType): GitRefType {
	switch (type) {
		case ExtHostGitRefType.Head: return GitRefType.Head;
		case ExtHostGitRefType.RemoteHead: return GitRefType.RemoteHead;
		case ExtHostGitRefType.Tag: return GitRefType.Tag;
		default: throw new Error(`Unknown GitRefType: ${type}`);
	}
}

@extHostNamedCustomer(MainContext.MainThreadGitExtension)
export class MainThreadGitExtensionService extends Disposable implements MainThreadGitExtensionShape, IGitExtensionDelegate {
	private readonly _proxy: ExtHostGitExtensionShape;

	constructor(
		extHostContext: IExtHostContext,
		@IGitService gitService: IGitService,
	) {
		super();

		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostGitExtension);
		this._register(gitService.setDelegate(this));
	}

	async openRepository(uri: URI): Promise<URI | undefined> {
		const result = await this._proxy.$openRepository(uri);
		return result ? URI.revive(result) : undefined;
	}

	async getRefs(root: URI, query: GitRefQuery, token?: CancellationToken): Promise<GitRef[]> {
		const result = await this._proxy.$getRefs(root, query, token);

		if (token?.isCancellationRequested) {
			return [];
		}

		return result.map(ref => ({
			...ref,
			type: toGitRefType(ref.type)
		} satisfies GitRef));
	}
}
