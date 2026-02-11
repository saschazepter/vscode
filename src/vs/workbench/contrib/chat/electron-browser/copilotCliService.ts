/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { join } from '../../../../base/common/path.js';
import { arch, platform } from '../../../../base/common/process.js';
import { URI } from '../../../../base/common/uri.js';
import { IDownloadService } from '../../../../platform/download/common/download.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { copilotCliAssetName, ICopilotCliService } from '../common/copilotCliService.js';

const LOG_PREFIX = '[CopilotCli]';

/**
 * Desktop (Electron) implementation of {@link ICopilotCliService}.
 *
 * Rather than shelling out to `npm install`, this fetches a
 * pre-built native binary from the Copilot CLI GitHub releases
 * page for the user's platform and architecture.
 *
 * The base URL for releases is read from the `defaultChatAgent`
 * section of product configuration (`cliReleasesUrl`).
 */
export class NativeCopilotCliService implements ICopilotCliService {

	declare readonly _serviceBrand: undefined;

	private cachedResolution: Promise<string> | undefined;

	private readonly binaryDir: string;
	private readonly releasesBaseUrl: string | undefined;

	constructor(
		@INativeEnvironmentService nativeEnv: INativeEnvironmentService,
		@IProductService product: IProductService,
		@IFileService private readonly files: IFileService,
		@IDownloadService private readonly dl: IDownloadService,
		@ILogService private readonly logger: ILogService,
	) {
		this.binaryDir = join(nativeEnv.userDataPath, 'copilot-cli');
		this.releasesBaseUrl = product.defaultChatAgent?.cliReleasesUrl;
	}

	async ensureInstalled(token: CancellationToken): Promise<string> {
		// Guard against multiple concurrent download attempts.
		// A failed attempt clears the cached promise so callers can retry.
		if (this.cachedResolution === undefined) {
			const work = this.acquireBinary(token);
			this.cachedResolution = work;
			work.catch(() => { this.cachedResolution = undefined; });
		}
		return this.cachedResolution;
	}

	// --- private helpers ---

	private async acquireBinary(token: CancellationToken): Promise<string> {
		const currentArch = arch ?? 'x64';
		if (currentArch !== 'x64' && currentArch !== 'arm64') {
			this.logger.warn(LOG_PREFIX, `Unrecognised architecture "${currentArch}" – falling back to amd64`);
		}
		const asset = copilotCliAssetName(platform, currentArch);
		const dest = join(this.binaryDir, asset);
		const destUri = URI.file(dest);

		// Already present – nothing to do.
		const alreadyExists = await this.files.exists(destUri);
		if (alreadyExists) {
			this.logger.info(LOG_PREFIX, 'Reusing existing binary at', dest);
			return dest;
		}

		if (this.releasesBaseUrl === undefined) {
			throw new Error(
				'No Copilot CLI releases URL configured – set defaultChatAgent.cliReleasesUrl in product.json'
			);
		}

		// Make sure the target directory is present.
		const dirUri = URI.file(this.binaryDir);
		const dirPresent = await this.files.exists(dirUri);
		if (!dirPresent) {
			await this.files.createFolder(dirUri);
		}

		// Download the platform-appropriate native binary.
		// Note: on POSIX systems the caller is responsible for
		// ensuring the downloaded file has the executable bit set
		// (e.g. via `chmod +x`) because the sandbox layer does not
		// expose a direct chmod API.
		const sourceUrl = `${this.releasesBaseUrl}/${asset}`;
		this.logger.info(LOG_PREFIX, 'Fetching native binary:', sourceUrl);
		try {
			await this.dl.download(URI.parse(sourceUrl), destUri, token);
		} catch (err) {
			throw new Error(`Failed to download Copilot CLI binary from ${sourceUrl}: ${err}`);
		}

		this.logger.info(LOG_PREFIX, 'Binary ready at', dest);
		return dest;
	}
}
