/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import { dirname, join } from '../../../base/common/path.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';

/**
 * On-demand provisioning of the Foundry Local native runtime used by on-device
 * dictation.
 *
 * `foundry-local-sdk` ships a prebuilt N-API addon (`foundry_local_napi.node`)
 * and downloads native core libraries (Foundry Local Core + ONNX Runtime +
 * ONNX Runtime GenAI) next to it. The addon requires a newer glibc than VS
 * Code's minimum supported Linux distros, so we deliberately do NOT bundle any
 * of this native payload with the product (see `build/gulpfile.vscode.ts`).
 * Instead we download it here, at runtime, only on supported platforms, into a
 * per-user writable cache — keeping the shipped package's glibc floor intact.
 *
 * The SDK loader (`dist/detail/coreInterop.js`) is patched during
 * `postinstall` to honor `VSCODE_FOUNDRY_LOCAL_NATIVE_DIR`, pointing it at the
 * cache directory this module populates. The cache layout mirrors the SDK's
 * own package layout so the patched resolution is a trivial path join:
 *
 *   <cacheRoot>/<sdkVersion>/prebuilds/<platformKey>/foundry_local_napi.node
 *   <cacheRoot>/<sdkVersion>/foundry-local-core/<platformKey>/<core libraries>
 *
 * NOTE: downloads use plain `https` (npm registry for the addon tarball, NuGet
 * — via the SDK's own installer — for the core libraries) and do not honor VS
 * Code's proxy settings. This matches the SDK's bundled installer and the
 * Foundry Local model download, which have the same limitation.
 */

/**
 * Platforms (`<process.platform>-<process.arch>`) for which Foundry Local ships
 * a native addon + core libraries. Mirrors the SDK installer's RID map.
 */
export const FOUNDRY_LOCAL_SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set([
	'darwin-arm64',
	'linux-x64',
	'linux-arm64',
	'win32-x64',
	'win32-arm64',
]);

/** The current host platform key, or `undefined` if Foundry Local can't run here. */
export function foundryLocalPlatformKey(): string | undefined {
	const key = `${process.platform}-${process.arch}`;
	return FOUNDRY_LOCAL_SUPPORTED_PLATFORMS.has(key) ? key : undefined;
}

/** Whether on-device dictation's native runtime can run on this host. */
export function isFoundryLocalRuntimeSupported(): boolean {
	return foundryLocalPlatformKey() !== undefined;
}

/** Progress callback invoked while the native runtime is being fetched. */
export type FoundryLocalRuntimeProgress = (message: string) => void;

/** De-dupes concurrent provisioning requests targeting the same cache dir. */
const inFlight = new Map<string, Promise<string>>();

/**
 * Ensure the Foundry Local native runtime (addon + core libraries) is present
 * in `<cacheRoot>`, downloading it if necessary. Returns the versioned override
 * directory to set as `VSCODE_FOUNDRY_LOCAL_NATIVE_DIR` before loading the SDK.
 *
 * Idempotent: once a version is fully provisioned a `.complete` marker is
 * written and subsequent calls return immediately without touching the network.
 */
export async function ensureFoundryLocalRuntime(cacheRoot: string, token: CancellationToken, onProgress?: FoundryLocalRuntimeProgress): Promise<string> {
	const platformKey = foundryLocalPlatformKey();
	if (!platformKey) {
		throw new Error(`Foundry Local native runtime is not available on ${process.platform}-${process.arch}.`);
	}

	const nodeRequire = await getNativeRequire();
	const sdkVersion: string = nodeRequire('foundry-local-sdk/package.json').version;
	const overrideDir = join(cacheRoot, sdkVersion);

	// A single in-flight provisioning per override dir; late joiners share it.
	const existing = inFlight.get(overrideDir);
	if (existing) {
		return existing;
	}
	const promise = doEnsure(overrideDir, platformKey, sdkVersion, nodeRequire, token, onProgress)
		.finally(() => inFlight.delete(overrideDir));
	inFlight.set(overrideDir, promise);
	return promise;
}

async function doEnsure(overrideDir: string, platformKey: string, sdkVersion: string, nodeRequire: NodeJS.Require, token: CancellationToken, onProgress?: FoundryLocalRuntimeProgress): Promise<string> {
	const markerPath = join(overrideDir, '.complete');
	if (fs.existsSync(markerPath)) {
		return overrideDir;
	}

	const addonPath = join(overrideDir, 'prebuilds', platformKey, 'foundry_local_napi.node');
	const coreDir = join(overrideDir, 'foundry-local-core', platformKey);

	if (!fs.existsSync(addonPath)) {
		onProgress?.('Downloading dictation runtime…');
		await ensureAddon(addonPath, platformKey, sdkVersion, token);
	}

	throwIfCancelled(token);

	if (!hasAllCoreLibraries(coreDir)) {
		onProgress?.('Downloading dictation runtime…');
		await ensureCoreLibraries(coreDir, nodeRequire);
	}

	throwIfCancelled(token);

	// Final integrity check before publishing the completion marker.
	if (!fs.existsSync(addonPath) || !hasAllCoreLibraries(coreDir)) {
		throw new Error('Foundry Local native runtime download completed but expected files are missing.');
	}

	await fs.promises.writeFile(markerPath, `${sdkVersion}\n`);
	return overrideDir;
}

/**
 * Download the prebuilt N-API addon for `platformKey` from the pinned
 * `foundry-local-sdk` npm tarball and place it at `addonPath`.
 */
async function ensureAddon(addonPath: string, platformKey: string, sdkVersion: string, token: CancellationToken): Promise<void> {
	const tarballUrl = `https://registry.npmjs.org/foundry-local-sdk/-/foundry-local-sdk-${sdkVersion}.tgz`;
	const entryName = `package/prebuilds/${platformKey}/foundry_local_napi.node`;

	const tmpDir = await fs.promises.mkdtemp(join(os.tmpdir(), 'vscode-foundry-addon-'));
	try {
		const tarballPath = join(tmpDir, 'sdk.tgz');
		await downloadFile(tarballUrl, tarballPath, token);
		throwIfCancelled(token);

		// npm tarballs are gzip'd tar; extract only the single addon we need.
		// `tar` is a node_modules package, so it must be imported dynamically.
		const tar = await import('tar');
		await tar.x({ file: tarballPath, cwd: tmpDir, filter: p => p.replace(/\\/g, '/') === entryName });

		const extracted = join(tmpDir, entryName);
		if (!fs.existsSync(extracted)) {
			throw new Error(`Foundry Local addon for ${platformKey} not found in ${tarballUrl}.`);
		}

		await fs.promises.mkdir(dirname(addonPath), { recursive: true });
		// Publish atomically: copy to a sibling temp file, then rename into place.
		const stagingPath = `${addonPath}.download`;
		await fs.promises.copyFile(extracted, stagingPath);
		await fs.promises.rename(stagingPath, addonPath);
	} finally {
		await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
	}
}

/**
 * Download the Foundry Local core libraries into `coreDir` by reusing the SDK's
 * own NuGet installer (`script/install-utils.cjs`), targeted at our cache with
 * its `binDir` option. Replicates the standard variant's artifact selection
 * (`script/install-standard.cjs`), including the linux-x64 GPU ORT package.
 */
async function ensureCoreLibraries(coreDir: string, nodeRequire: NodeJS.Require): Promise<void> {
	const deps = nodeRequire('foundry-local-sdk/deps_versions.json');
	const { runInstall } = nodeRequire('foundry-local-sdk/script/install-utils.cjs') as {
		runInstall(artifacts: { name: string; version: string }[], options?: { binDir?: string }): Promise<void>;
	};

	// Microsoft.ML.OnnxRuntime.Gpu.Linux only ships x86_64 native binaries, so
	// linux-arm64 falls back to the cross-platform Foundry ORT package.
	const isLinuxX64 = process.platform === 'linux' && process.arch === 'x64';
	const ortPackageName = isLinuxX64 ? 'Microsoft.ML.OnnxRuntime.Gpu.Linux' : 'Microsoft.ML.OnnxRuntime.Foundry';

	const artifacts = [
		{ name: 'Microsoft.AI.Foundry.Local.Core', version: deps['foundry-local-core'].nuget },
		{ name: ortPackageName, version: deps.onnxruntime.version },
		{ name: 'Microsoft.ML.OnnxRuntimeGenAI.Foundry', version: deps['onnxruntime-genai'].version },
	];

	await fs.promises.mkdir(coreDir, { recursive: true });
	await runInstall(artifacts, { binDir: coreDir });
}

/** Whether all three required core libraries already exist in `coreDir`. */
function hasAllCoreLibraries(coreDir: string): boolean {
	const ext = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
	const prefix = process.platform === 'win32' ? '' : 'lib';
	const required = [
		`Microsoft.AI.Foundry.Local.Core${ext}`,
		`${prefix}onnxruntime${ext}`,
		`${prefix}onnxruntime-genai${ext}`,
	];
	return required.every(name => fs.existsSync(join(coreDir, name)));
}

/** Download `url` to `dest`, following redirects, honoring cancellation. */
async function downloadFile(url: string, dest: string, token: CancellationToken): Promise<void> {
	// `https` is a slow-to-load builtin; import it lazily at runtime.
	const https = await import('https');
	return new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			file.close();
			fs.promises.rm(dest, { force: true }).catch(() => { /* best effort */ });
		};
		const file = fs.createWriteStream(dest);
		const request = (currentUrl: string, redirectsLeft: number): void => {
			if (token.isCancellationRequested) {
				cleanup();
				reject(new CancellationError());
				return;
			}
			https.get(currentUrl, response => {
				const status = response.statusCode ?? 0;
				if (status >= 300 && status < 400 && response.headers.location) {
					response.resume();
					if (redirectsLeft <= 0) {
						cleanup();
						reject(new Error(`Too many redirects downloading ${url}.`));
						return;
					}
					request(new URL(response.headers.location, currentUrl).toString(), redirectsLeft - 1);
					return;
				}
				if (status !== 200) {
					response.resume();
					cleanup();
					reject(new Error(`Download failed with status ${status}: ${currentUrl}`));
					return;
				}
				response.pipe(file);
				file.on('finish', () => file.close(err => err ? reject(err) : resolve()));
				response.on('error', err => { cleanup(); reject(err); });
			}).on('error', err => { cleanup(); reject(err); });
		};
		file.on('error', err => { cleanup(); reject(err); });
		request(url, 5);
	});
}

function throwIfCancelled(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
}

let cachedNativeRequire: NodeJS.Require | undefined;
/**
 * A CommonJS `require` bound to this module for loading `foundry-local-sdk`'s
 * package metadata and its NuGet installer at runtime. `foundry-local-sdk` has
 * no `exports` map, so its subpaths resolve directly; it is kept external from
 * the bundle (loaded from `node_modules`) like the SDK's own dynamic import.
 * Uses a dynamic `import('node:module')` so the `node:` specifier is resolved
 * lazily at runtime rather than at bundle/load time.
 */
async function getNativeRequire(): Promise<NodeJS.Require> {
	if (!cachedNativeRequire) {
		const nodeModule = await import('node:module');
		cachedNativeRequire = nodeModule.createRequire(import.meta.url);
	}
	return cachedNativeRequire;
}
