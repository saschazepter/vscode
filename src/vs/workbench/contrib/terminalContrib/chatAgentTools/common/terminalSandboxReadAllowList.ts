/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OperatingSystem } from '../../../../../base/common/platform.js';

export const enum TerminalSandboxReadAllowListOperation {
	Git = 'git',
	Node = 'node',
	CommonDev = 'commonDev',
}

const terminalSandboxReadAllowListKeywordMap: ReadonlyMap<string, TerminalSandboxReadAllowListOperation> = new Map([
	['git', TerminalSandboxReadAllowListOperation.Git],
	['gh', TerminalSandboxReadAllowListOperation.Git],
	['node', TerminalSandboxReadAllowListOperation.Node],
	['npm', TerminalSandboxReadAllowListOperation.Node],
	['npx', TerminalSandboxReadAllowListOperation.Node],
	['pnpm', TerminalSandboxReadAllowListOperation.Node],
	['yarn', TerminalSandboxReadAllowListOperation.Node],
	['corepack', TerminalSandboxReadAllowListOperation.Node],
	['bun', TerminalSandboxReadAllowListOperation.Node],
	['deno', TerminalSandboxReadAllowListOperation.Node],
	['nvm', TerminalSandboxReadAllowListOperation.Node],
	['volta', TerminalSandboxReadAllowListOperation.Node],
	['fnm', TerminalSandboxReadAllowListOperation.Node],
	['asdf', TerminalSandboxReadAllowListOperation.Node],
	['mise', TerminalSandboxReadAllowListOperation.Node],
	['cargo', TerminalSandboxReadAllowListOperation.CommonDev],
	['rustc', TerminalSandboxReadAllowListOperation.CommonDev],
	['rustup', TerminalSandboxReadAllowListOperation.CommonDev],
	['go', TerminalSandboxReadAllowListOperation.CommonDev],
	['gofmt', TerminalSandboxReadAllowListOperation.CommonDev],
	['python', TerminalSandboxReadAllowListOperation.CommonDev],
	['python3', TerminalSandboxReadAllowListOperation.CommonDev],
	['pip', TerminalSandboxReadAllowListOperation.CommonDev],
	['pip3', TerminalSandboxReadAllowListOperation.CommonDev],
	['poetry', TerminalSandboxReadAllowListOperation.CommonDev],
	['uv', TerminalSandboxReadAllowListOperation.CommonDev],
	['pipx', TerminalSandboxReadAllowListOperation.CommonDev],
	['pyenv', TerminalSandboxReadAllowListOperation.CommonDev],
	['java', TerminalSandboxReadAllowListOperation.CommonDev],
	['javac', TerminalSandboxReadAllowListOperation.CommonDev],
	['jar', TerminalSandboxReadAllowListOperation.CommonDev],
	['mvn', TerminalSandboxReadAllowListOperation.CommonDev],
	['mvnw', TerminalSandboxReadAllowListOperation.CommonDev],
	['gradle', TerminalSandboxReadAllowListOperation.CommonDev],
	['gradlew', TerminalSandboxReadAllowListOperation.CommonDev],
	['sdk', TerminalSandboxReadAllowListOperation.CommonDev],
	['dotnet', TerminalSandboxReadAllowListOperation.CommonDev],
	['nuget', TerminalSandboxReadAllowListOperation.CommonDev],
	['msbuild', TerminalSandboxReadAllowListOperation.CommonDev],
	['ruby', TerminalSandboxReadAllowListOperation.CommonDev],
	['gem', TerminalSandboxReadAllowListOperation.CommonDev],
	['bundle', TerminalSandboxReadAllowListOperation.CommonDev],
	['bundler', TerminalSandboxReadAllowListOperation.CommonDev],
	['rake', TerminalSandboxReadAllowListOperation.CommonDev],
	['rbenv', TerminalSandboxReadAllowListOperation.CommonDev],
	['rvm', TerminalSandboxReadAllowListOperation.CommonDev],
	['ccache', TerminalSandboxReadAllowListOperation.CommonDev],
	['sccache', TerminalSandboxReadAllowListOperation.CommonDev],
	['conan', TerminalSandboxReadAllowListOperation.CommonDev],
	['cmake', TerminalSandboxReadAllowListOperation.CommonDev],
]);

export interface ITerminalSandboxReadAllowListGroup {
	readonly operation: TerminalSandboxReadAllowListOperation;
	readonly linux: readonly string[];
	readonly mac: readonly string[];
}

/**
 * Paths that common developer tools typically need to read when the user's home
 * directory is broadly denied. This list intentionally avoids obvious credential
 * and key material such as ~/.ssh, ~/.gnupg, cloud credentials, package manager
 * auth files, and git credential stores.
 */
export const DefaultTerminalReadAllowList: readonly ITerminalSandboxReadAllowListGroup[] = [
	{
		operation: TerminalSandboxReadAllowListOperation.Git,
		linux: [
			'~/.gitconfig',
			'~/.config/git/config',
			'~/.gitignore',
			'~/.gitignore_global',
			'~/.config/git/ignore',
			'~/.config/git/attributes',
		],
		mac: [
			'~/.gitconfig',
			'~/.config/git/config',
			'~/.gitignore',
			'~/.gitignore_global',
			'~/.config/git/ignore',
			'~/.config/git/attributes',
		],
	},
	{
		operation: TerminalSandboxReadAllowListOperation.Node,
		linux: [
			'~/.npm',
			'~/.cache/node',
			'~/.cache/node/corepack',
			'~/.cache/yarn',
			'~/.yarn/berry',
			'~/.local/share/pnpm',
			'~/.pnpm-store',
			'~/.bun/install/cache',
			'~/.bun/bin',
			'~/.deno',
			'~/.cache/deno',
			'~/.nvm/versions',
			'~/.nvm/alias',
			'~/.volta/bin',
			'~/.volta/tools',
			'~/.fnm',
			'~/.asdf/installs/nodejs',
			'~/.asdf/shims',
			'~/.local/share/mise/installs/node',
			'~/.local/share/mise/shims',
		],
		mac: [
			'~/.npm',
			'~/Library/Caches/node',
			'~/Library/Caches/Yarn',
			'~/Library/Caches/deno',
			'~/Library/pnpm',
			'~/.yarn/berry',
			'~/.local/share/pnpm',
			'~/.pnpm-store',
			'~/.bun/install/cache',
			'~/.bun/bin',
			'~/.deno',
			'~/.nvm/versions',
			'~/.nvm/alias',
			'~/.volta/bin',
			'~/.volta/tools',
			'~/.fnm',
			'~/.asdf/installs/nodejs',
			'~/.asdf/shims',
			'~/.local/share/mise/installs/node',
			'~/.local/share/mise/shims',
		],
	},
	{
		operation: TerminalSandboxReadAllowListOperation.CommonDev,
		linux: [
			// Rust toolchains and package caches.
			'~/.cargo/bin',
			'~/.cargo/registry',
			'~/.cargo/git',
			'~/.rustup/toolchains',
			// Go modules, binaries, and build cache.
			'~/go/pkg/mod',
			'~/go/bin',
			'~/.cache/go-build',
			// Python package caches and environment managers.
			'~/.cache/pip',
			'~/.cache/pypoetry',
			'~/.cache/uv',
			'~/.local/bin',
			'~/.local/share/virtualenv',
			'~/.local/share/pipx',
			'~/.pyenv/versions',
			'~/.pyenv/shims',
			// Java and JVM package caches.
			'~/.m2/repository',
			'~/.gradle/caches',
			'~/.gradle/wrapper/dists',
			'~/.sdkman/candidates',
			// .NET and NuGet packages.
			'~/.nuget/packages',
			'~/.dotnet',
			'~/.local/share/NuGet/v3-cache',
			// Ruby gems and version managers.
			'~/.gem',
			'~/.rbenv/versions',
			'~/.rbenv/shims',
			'~/.rvm/rubies',
			// Native build caches.
			'~/.cache/ccache',
			'~/.cache/sccache',
			// Conan package cache.
			'~/.conan2/p',
			'~/.conan2/b',
		],
		mac: [
			// Rust toolchains and package caches.
			'~/.cargo/bin',
			'~/.cargo/registry',
			'~/.cargo/git',
			'~/.rustup/toolchains',
			// Go modules, binaries, and build cache.
			'~/go/pkg/mod',
			'~/go/bin',
			'~/Library/Caches/go-build',
			// Python package caches and environment managers.
			'~/Library/Caches/pip',
			'~/Library/Caches/pypoetry',
			'~/Library/Caches/uv',
			'~/.local/bin',
			'~/.local/share/virtualenv',
			'~/.local/share/pipx',
			'~/.pyenv/versions',
			'~/.pyenv/shims',
			// Java and JVM package caches.
			'~/.m2/repository',
			'~/.gradle/caches',
			'~/.gradle/wrapper/dists',
			'~/.sdkman/candidates',
			// .NET and NuGet packages.
			'~/.nuget/packages',
			'~/.dotnet',
			'~/Library/Caches/NuGet/v3-cache',
			// Ruby gems and version managers.
			'~/.gem',
			'~/.rbenv/versions',
			'~/.rbenv/shims',
			'~/.rvm/rubies',
			// Native build caches.
			'~/Library/Caches/ccache',
			'~/Library/Caches/sccache',
			// Conan package cache.
			'~/.conan2/p',
			'~/.conan2/b',
		],
	},
];

export function getTerminalSandboxReadAllowList(os: OperatingSystem): readonly string[] {
	const paths = DefaultTerminalReadAllowList.flatMap(group => os === OperatingSystem.Macintosh ? group.mac : group.linux);
	return [...new Set(paths)];
}

export function getTerminalSandboxReadAllowListForCommands(os: OperatingSystem, commandKeywords: readonly string[]): readonly string[] {
	if (commandKeywords.length === 0) {
		return [];
	}

	const operations = new Set<TerminalSandboxReadAllowListOperation>();
	for (const keyword of commandKeywords) {
		const operation = terminalSandboxReadAllowListKeywordMap.get(keyword.toLowerCase());
		if (operation) {
			operations.add(operation);
		}
	}

	if (operations.size === 0) {
		return [];
	}

	const paths = DefaultTerminalReadAllowList
		.filter(group => operations.has(group.operation))
		.flatMap(group => os === OperatingSystem.Macintosh ? group.mac : group.linux);
	return [...new Set(paths)];
}
