/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export enum GitRefType {
	Head,
	RemoteHead,
	Tag
}

export interface GitRef {
	readonly type: GitRefType;
	readonly name?: string;
	readonly commit?: string;
	readonly remote?: string;
}

export interface GitRefQuery {
	readonly contains?: string;
	readonly count?: number;
	readonly pattern?: string | string[];
	readonly sort?: 'alphabetically' | 'committerdate' | 'creatordate';
}

/**
 * Delegate interface that bridges to the git extension running
 * in the extension host. Set by MainThreadGit when an extension
 * host connects.
 */
export interface IGitExtensionService {
	getRefs(uri: UriComponents, query?: GitRefQuery, token?: CancellationToken): Promise<GitRef[]>;
	openRepository(uri: UriComponents): Promise<UriComponents | undefined>;
}

export const IGitService = createDecorator<IGitService>('gitService');

export interface IGitService {
	readonly _serviceBrand: undefined;

	setDelegate(delegate: IGitExtensionService): void;
	clearDelegate(): void;

	getRefs(uri: URI, query?: GitRefQuery, token?: CancellationToken): Promise<GitRef[]>;

	openRepository(uri: URI): Promise<URI | undefined>;
}
