/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { IGitExtensionService, IGitService } from '../../contrib/git/common/gitService.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { ExtHostContext, ExtHostGitExtensionShape, MainContext, MainThreadGitExtensionShape } from '../common/extHost.protocol.js';

@extHostNamedCustomer(MainContext.MainThreadGitExtension)
export class MainThreadGitExtensionService extends Disposable implements MainThreadGitExtensionShape, IGitExtensionService {
	private readonly _proxy: ExtHostGitExtensionShape;

	constructor(
		extHostContext: IExtHostContext,
		@IGitService private readonly gitService: IGitService,
	) {
		super();

		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostGitExtension);
		gitService.setDelegate(this);
	}

	async openRepository(uri: URI): Promise<URI | undefined> {
		const result = await this._proxy.$openRepository(uri);
		return result ? URI.revive(result) : undefined;
	}

	override dispose(): void {
		this.gitService.clearDelegate();
		super.dispose();
	}
}
