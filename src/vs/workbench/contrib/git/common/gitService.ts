/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI, UriComponents } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Delegate interface that bridges to the git extension running
 * in the extension host. Set by MainThreadGit when an extension
 * host connects.
 */
export interface IGitExtensionService {
	openRepository(uri: UriComponents): Promise<UriComponents | undefined>;
}

export const IGitService = createDecorator<IGitService>('gitService');

export interface IGitService {
	readonly _serviceBrand: undefined;

	setDelegate(delegate: IGitExtensionService): void;
	clearDelegate(): void;

	/**
	 * Open a git repository at the given URI.
	 * @returns The repository root URI or `undefined` if the repository could not be opened.
	 */
	openRepository(uri: URI): Promise<URI | undefined>;
}
