/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import picomatch from 'picomatch';

export function getWorktreeIncludePaths(repositoryRoot: string, globs: readonly string[], filesOutput: string, directoriesOutput: string, trackedFilesOutput: string): string[] {
	const ignoredFiles = filesOutput.split('\0').filter(Boolean);
	if (ignoredFiles.length === 0) {
		return [];
	}

	const matchers = globs.map(pattern => {
		const normalized = pattern.replaceAll('\\', '/');
		return picomatch(normalized.endsWith('/') ? `${normalized}**` : normalized, { dot: true });
	});
	const wholeDirectories = new Set(directoriesOutput.split('\0').filter(entry => entry.endsWith('/')));
	const trackedFiles = new Set(trackedFilesOutput.split('\0').filter(Boolean));
	const matchedFiles: string[] = [];
	const nonCollapsibleDirectories = new Set<string>();

	for (const file of trackedFiles) {
		const directory = wholeDirectories.has(`${file}/`) ? `${file}/` : findContainingDirectory(file, wholeDirectories);
		if (directory) {
			nonCollapsibleDirectories.add(directory);
		}
	}

	for (const file of ignoredFiles) {
		if (matchers.some(matcher => matcher(file)) && !hasTrackedPathOrAncestor(file, trackedFiles)) {
			matchedFiles.push(file);
			continue;
		}

		const containingDirectory = findContainingDirectory(file, wholeDirectories);
		if (containingDirectory) {
			nonCollapsibleDirectories.add(containingDirectory);
		}
	}

	const collapsedDirectories = new Set<string>();
	for (const directory of wholeDirectories) {
		if (!nonCollapsibleDirectories.has(directory)) {
			collapsedDirectories.add(directory);
		}
	}

	const includePaths = [...collapsedDirectories];
	for (const file of matchedFiles) {
		if (!findContainingDirectory(file, collapsedDirectories)) {
			includePaths.push(file);
		}
	}

	return includePaths.map(entry => path.join(repositoryRoot, entry));
}

function findContainingDirectory(file: string, directories: ReadonlySet<string>): string | undefined {
	let index = file.indexOf('/');
	while (index !== -1) {
		const prefix = file.slice(0, index + 1);
		if (directories.has(prefix)) {
			return prefix;
		}
		index = file.indexOf('/', index + 1);
	}
	return undefined;
}

function hasTrackedPathOrAncestor(file: string, trackedFiles: ReadonlySet<string>): boolean {
	if (trackedFiles.has(file)) {
		return true;
	}

	let index = file.indexOf('/');
	while (index !== -1) {
		if (trackedFiles.has(file.slice(0, index))) {
			return true;
		}
		index = file.indexOf('/', index + 1);
	}
	return false;
}
