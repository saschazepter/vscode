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
export const terminalSandboxReadAllowListGroups: readonly ITerminalSandboxReadAllowListGroup[] = [
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
			'~/.cargo/bin',
			'~/.cargo/registry',
			'~/.cargo/git',
			'~/.rustup/toolchains',
			'~/go/pkg/mod',
			'~/go/bin',
			'~/.cache/go-build',
			'~/.cache/pip',
			'~/.cache/pypoetry',
			'~/.cache/uv',
			'~/.local/bin',
			'~/.local/share/virtualenv',
			'~/.local/share/pipx',
			'~/.pyenv/versions',
			'~/.pyenv/shims',
			'~/.m2/repository',
			'~/.gradle/caches',
			'~/.gradle/wrapper/dists',
			'~/.sdkman/candidates',
			'~/.nuget/packages',
			'~/.dotnet',
			'~/.local/share/NuGet/v3-cache',
			'~/.gem',
			'~/.rbenv/versions',
			'~/.rbenv/shims',
			'~/.rvm/rubies',
			'~/.cache/ccache',
			'~/.cache/sccache',
			'~/.conan2/p',
			'~/.conan2/b',
		],
		mac: [
			'~/.cargo/bin',
			'~/.cargo/registry',
			'~/.cargo/git',
			'~/.rustup/toolchains',
			'~/go/pkg/mod',
			'~/go/bin',
			'~/Library/Caches/go-build',
			'~/Library/Caches/pip',
			'~/Library/Caches/pypoetry',
			'~/Library/Caches/uv',
			'~/.local/bin',
			'~/.local/share/virtualenv',
			'~/.local/share/pipx',
			'~/.pyenv/versions',
			'~/.pyenv/shims',
			'~/.m2/repository',
			'~/.gradle/caches',
			'~/.gradle/wrapper/dists',
			'~/.sdkman/candidates',
			'~/.nuget/packages',
			'~/.dotnet',
			'~/Library/Caches/NuGet/v3-cache',
			'~/.gem',
			'~/.rbenv/versions',
			'~/.rbenv/shims',
			'~/.rvm/rubies',
			'~/Library/Caches/ccache',
			'~/Library/Caches/sccache',
			'~/.conan2/p',
			'~/.conan2/b',
		],
	},
];

export function getTerminalSandboxReadAllowList(os: OperatingSystem): readonly string[] {
	const paths = terminalSandboxReadAllowListGroups.flatMap(group => os === OperatingSystem.Macintosh ? group.mac : group.linux);
	return [...new Set(paths)];
}
