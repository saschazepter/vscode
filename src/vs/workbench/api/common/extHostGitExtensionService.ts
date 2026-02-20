/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { ExtensionIdentifier } from '../../../platform/extensions/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IExtHostExtensionService } from './extHostExtensionService.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import { ExtHostGitExtensionShape } from './extHost.protocol.js';

const GIT_EXTENSION_ID = 'vscode.git';

interface GitExtensionAPI {
	openRepository(root: vscode.Uri): Promise<{ readonly rootUri: vscode.Uri } | null>;
}

interface GitExtension {
	getAPI(version: 1): GitExtensionAPI;
}

export interface IExtHostGitExtensionService extends ExtHostGitExtensionShape {
	readonly _serviceBrand: undefined;
}

export const IExtHostGitExtensionService = createDecorator<IExtHostGitExtensionService>('IExtHostGitExtensionService');

export class ExtHostGitExtensionService extends Disposable implements IExtHostGitExtensionService {
	declare readonly _serviceBrand: undefined;

	private _gitApi: GitExtensionAPI | undefined;
	private readonly _disposables = this._register(new DisposableStore());

	constructor(
		@IExtHostRpcService _extHostRpc: IExtHostRpcService,
		@IExtHostExtensionService private readonly _extHostExtensionService: IExtHostExtensionService,
	) {
		super();
	}

	// --- Called by the main thread via RPC (ExtHostGitShape) ---

	async $openRepository(uri: UriComponents): Promise<UriComponents | undefined> {
		const api = await this._ensureGitApi();
		if (!api) {
			return undefined;
		}

		const repository = await api.openRepository(URI.revive(uri));
		return repository?.rootUri;
	}

	// --- Private helpers ---

	private async _ensureGitApi(): Promise<GitExtensionAPI | undefined> {
		if (this._gitApi) {
			return this._gitApi;
		}

		try {
			await this._extHostExtensionService.activateByIdWithErrors(
				new ExtensionIdentifier(GIT_EXTENSION_ID),
				{ startup: false, extensionId: new ExtensionIdentifier(GIT_EXTENSION_ID), activationEvent: 'api' }
			);

			const exports = this._extHostExtensionService.getExtensionExports(new ExtensionIdentifier(GIT_EXTENSION_ID));
			if (!!exports && typeof (exports as GitExtension).getAPI === 'function') {
				this._gitApi = (exports as GitExtension).getAPI(1);
			}
		} catch {
			// Git extension not available
		}

		return this._gitApi;
	}

	override dispose(): void {
		this._disposables.dispose();
		super.dispose();
	}
}
