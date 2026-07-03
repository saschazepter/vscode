/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';

/**
 * Detects whether the current Linux system uses musl libc (Alpine Linux).
 * Mirrors the detection used in `node-vsce-sign` and the VS Code extension management.
 */
export function isAlpineLinux(): boolean {
	let content: string | undefined;
	for (const filePath of ['/etc/os-release', '/usr/lib/os-release']) {
		try {
			content = fs.readFileSync(filePath, 'utf8');
			break;
		} catch (err) {
			// ignore and try the next file
		}
	}
	return !!content && (content.match(/^ID=([^\u001b\r\n]*)/m) || [])[1] === 'alpine';
}

/**
 * Normalizes an architecture (from `VSCODE_ARCH` or `process.arch`) to the suffix used
 * by the marketplace target platform identifiers.
 */
function toTargetArch(arch: string): string {
	switch (arch) {
		case 'arm': return 'armhf';
		case 'ia32': return 'x86';
		default: return arch;
	}
}

/**
 * Returns the marketplace target platform (e.g. `win32-x64`, `linux-armhf`, `alpine-x64`)
 * for the given platform and architecture. Mirrors the `TargetPlatform` enum in
 * `src/vs/platform/extensions/common/extensions.ts`.
 *
 * @returns the target platform string, or `undefined` when the combination is not supported.
 */
export function getExtensionTarget(platform: string, arch: string, isAlpine: () => boolean = isAlpineLinux): string | undefined {
	const targetArch = toTargetArch(arch);
	switch (platform) {
		case 'darwin':
			return `darwin-${targetArch}`;
		case 'win32':
			return `win32-${targetArch}`;
		case 'linux':
			return isAlpine() ? `alpine-${targetArch}` : `linux-${targetArch}`;
		default:
			return undefined;
	}
}

/**
 * Reads an environment variable, ignoring empty values and unexpanded Azure Pipelines
 * macros (e.g. a literal `$(VSCODE_ARCH)` left in place when the variable is not defined).
 */
function readEnv(name: string): string | undefined {
	const value = process.env[name];
	if (!value || value.startsWith('$(')) {
		return undefined;
	}
	return value;
}

/**
 * Returns the marketplace target platform for the current build.
 *
 * Resolution order:
 * 1. `VSCODE_EXTENSION_TARGET` env, when set — an explicit override for cross-compilation
 *    scenarios where the target cannot be detected from the host (e.g. building the alpine
 *    target on a glibc host).
 * 2. `process.platform` + (`VSCODE_ARCH` ?? `process.arch`) + runtime alpine detection.
 */
export function getCurrentExtensionTarget(): string | undefined {
	const override = readEnv('VSCODE_EXTENSION_TARGET');
	if (override) {
		return override;
	}
	const arch = readEnv('VSCODE_ARCH') ?? process.arch;
	return getExtensionTarget(process.platform, arch);
}

/**
 * Derives the GitHub release asset name for a platform-specific extension from its name and
 * marketplace target platform, following the `node-vsce-sign` naming pattern:
 * `<name>-<osAlias>-<arch>.vsix` where osAlias is one of `osx`, `win`, `linux`, `alpine`.
 */
export function getPlatformSpecificAssetName(name: string, target: string): string {
	const index = target.lastIndexOf('-');
	const targetOs = target.substring(0, index);
	const targetArch = target.substring(index + 1);

	let osAlias: string;
	switch (targetOs) {
		case 'darwin': osAlias = 'osx'; break;
		case 'win32': osAlias = 'win'; break;
		case 'linux': osAlias = 'linux'; break;
		case 'alpine': osAlias = 'alpine'; break;
		default: osAlias = targetOs; break;
	}

	const assetArch = targetArch === 'armhf' ? 'arm' : targetArch;

	return `${name}-${osAlias}-${assetArch}.vsix`;
}
