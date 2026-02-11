/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const ICopilotCliService = createDecorator<ICopilotCliService>('copilotCliService');

/**
 * Provides access to the GitHub Copilot CLI binary. On desktop, the
 * implementation fetches a native binary when npm is unavailable.
 */
export interface ICopilotCliService {
	readonly _serviceBrand: undefined;

	/**
	 * Returns the absolute filesystem path to the Copilot CLI
	 * executable, downloading the correct native build for the
	 * current OS/architecture when it is not already present.
	 */
	ensureInstalled(token: CancellationToken): Promise<string>;
}

// #region Release-asset naming helpers

/**
 * Translates a Node `process.platform` / `process.arch` pair
 * into the filename published for each Copilot CLI release.
 *
 * Convention:  `copilot-<os>-<cpu>[.exe]`
 */
export function copilotCliAssetName(osPlatform: string, cpuArch: string): string {
	const osLabel = osPlatform === 'win32' ? 'windows'
		: osPlatform === 'darwin' ? 'darwin'
			: 'linux';

	const cpuLabel = cpuArch === 'arm64' ? 'arm64' : 'amd64';

	return `copilot-${osLabel}-${cpuLabel}${osPlatform === 'win32' ? '.exe' : ''}`;
}

// #endregion
