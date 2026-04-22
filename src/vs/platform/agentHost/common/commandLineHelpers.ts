/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isWindows } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';

/**
 * Result of {@link extractCdPrefix}: the directory the `cd` jumps to and the
 * remaining command after the chain operator.
 */
export interface IExtractedCdPrefix {
	readonly directory: string;
	readonly command: string;
}

/**
 * Extracts a `cd <dir> &&` (or PowerShell equivalent) prefix from a command
 * line, returning the directory and remaining command. Does not check whether
 * the directory matches anything — callers do that comparison themselves.
 *
 * Recognized forms:
 * - bash:       `cd <dir> && <suffix>`
 * - powershell: `cd <dir> && <suffix>`, `cd <dir>; <suffix>`
 *               `cd /d <dir> && <suffix>`, `cd /d <dir>; <suffix>`
 *               `Set-Location <dir> && <suffix>`, `Set-Location <dir>; <suffix>`
 *               `Set-Location -Path <dir> && <suffix>`, `Set-Location -Path <dir>; <suffix>`
 *
 * Surrounding double quotes around `<dir>` are stripped.
 */
export function extractCdPrefix(commandLine: string, isPowerShell: boolean): IExtractedCdPrefix | undefined {
	const cdPrefixMatch = commandLine.match(
		isPowerShell
			? /^(?:cd(?: \/d)?|Set-Location(?: -Path)?) (?<dir>"[^"]*"|[^\s]+) ?(?:&&|;)\s+(?<suffix>.+)$/i
			: /^cd (?<dir>"[^"]*"|[^\s]+) &&\s+(?<suffix>.+)$/
	);
	const cdDir = cdPrefixMatch?.groups?.dir;
	const cdSuffix = cdPrefixMatch?.groups?.suffix;
	if (cdDir && cdSuffix) {
		let cdDirPath = cdDir;
		if (cdDirPath.startsWith('"') && cdDirPath.endsWith('"')) {
			cdDirPath = cdDirPath.slice(1, -1);
		}
		return { directory: cdDirPath, command: cdSuffix };
	}
	return undefined;
}

/**
 * If `toolName` is a shell tool (`bash` or `powershell`) and
 * `parameters.command` starts with a `cd <workingDirectory> && …` (or
 * PowerShell equivalent) prefix, mutate `parameters.command` to drop the
 * prefix and return `true`. Returns `false` otherwise.
 *
 * Path comparison normalizes trailing slashes and is case-insensitive on
 * Windows.
 */
export function stripRedundantCdPrefix(
	toolName: string,
	parameters: Record<string, unknown> | undefined,
	workingDirectory: URI | undefined,
): boolean {
	if (!workingDirectory || !parameters) {
		return false;
	}
	const isBash = toolName === 'bash';
	const isPowerShell = toolName === 'powershell';
	if (!isBash && !isPowerShell) {
		return false;
	}
	const command = parameters.command;
	if (typeof command !== 'string') {
		return false;
	}
	const extracted = extractCdPrefix(command, isPowerShell);
	if (!extracted) {
		return false;
	}
	if (!sameDirectory(extracted.directory, workingDirectory.fsPath)) {
		return false;
	}
	parameters.command = extracted.command;
	return true;
}

/** Compares two filesystem paths, ignoring trailing slashes and (on Windows) case. */
function sameDirectory(a: string, b: string): boolean {
	const normalize = (p: string) => p.replace(/[\\/]+$/, '');
	const na = normalize(a);
	const nb = normalize(b);
	return isWindows ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

