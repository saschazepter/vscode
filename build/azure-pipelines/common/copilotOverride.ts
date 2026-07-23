/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

/**
 * Shared parsing/resolution for the `.copilot-version` override mechanism.
 *
 * `.copilot-version` is a top-level `key=value` file (analogous to the electron
 * `target=` pin in `.npmrc`) that overrides the `@github/copilot` (runtime) and
 * `@github/copilot-sdk` packages VS Code depends on. See `.copilot-version` for
 * the value grammar. Queue-time pipeline parameters surface as the environment
 * variables `VSCODE_COPILOT_SDK` / `VSCODE_COPILOT_RUNTIME` and take precedence
 * over the committed file so one-off builds don't need a commit.
 */

/** The two overridable packages, keyed by their short id in `.copilot-version`. */
export type CopilotPackageId = 'sdk' | 'runtime';

/** Maps the short id to the npm package name declared in the manifests. */
export const COPILOT_NPM_NAME: Record<CopilotPackageId, string> = {
	sdk: '@github/copilot-sdk',
	runtime: '@github/copilot',
};

/**
 * Source repositories for `git:<ref>` overrides. `@github/copilot` is published
 * from the internal github/copilot-agent-runtime repo, so source builds of it
 * require credentials for that repo (a GitHub App installation token).
 */
const SOURCE_REPO: Record<CopilotPackageId, string> = {
	sdk: 'github/copilot-sdk',
	runtime: 'github/copilot-agent-runtime',
};

/**
 * A published-version override: pin the manifest to a concrete feed version,
 * range or dist-tag and let `npm ci` resolve it.
 */
export interface FeedOverride {
	readonly pkg: CopilotPackageId;
	readonly npmName: string;
	readonly kind: 'feed';
	/** npm version / range / dist-tag, e.g. `1.2.3`, `^1.2.0`, `latest`. */
	readonly spec: string;
}

/**
 * A source override: build the package from `repo` at `ref` (a branch, tag or
 * commit) with a TypeScript-only build, then consume the result locally.
 */
export interface GitOverride {
	readonly pkg: CopilotPackageId;
	readonly npmName: string;
	readonly kind: 'git';
	/** `owner/name` GitHub repository the package is built from. */
	readonly repo: string;
	/** Branch, tag or commit to build. */
	readonly ref: string;
}

export type CopilotOverride = FeedOverride | GitOverride;

/**
 * Allowlist for values interpolated into `npm view`/`git` argument strings and
 * (on Windows) run with `shell: true`. Restricts to characters that appear in
 * valid semver versions/ranges/dist-tags and git refs, rejecting anything a
 * shell could otherwise interpret. Mirrors the canary override's `SAFE_SPEC`.
 */
const SAFE_SPEC = /^[\w./+~^><=|* @#-]+$/;

function assertSafeSpec(label: string, value: string): void {
	if (!SAFE_SPEC.test(value)) {
		throw new Error(`[copilot-override] Refusing unsafe ${label} "${value}": only semver specs and git refs are allowed.`);
	}
}

/**
 * Parses a `key=value` file. Blank lines and `#` comments are ignored; values
 * are trimmed and surrounding quotes stripped. Duplicate keys: last wins.
 */
export function parseKeyValueFile(filePath: string): Map<string, string> {
	const result = new Map<string, string>();
	if (!fs.existsSync(filePath)) {
		return result;
	}
	const text = fs.readFileSync(filePath, 'utf8');
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const eq = line.indexOf('=');
		if (eq === -1) {
			throw new Error(`[copilot-override] Malformed line in ${filePath} (expected key=value): "${rawLine}"`);
		}
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
			value = value.slice(1, -1);
		}
		result.set(key, value);
	}
	return result;
}

/**
 * Reads `.copilot-version` merged with the `VSCODE_COPILOT_*` environment
 * overrides and returns one resolved override per package that requests one.
 * Returns an empty array for a normal build (all values empty).
 *
 * @param root repository root containing `.copilot-version`.
 * @param env  environment to read queue-time overrides from (defaults to process.env).
 */
export function resolveCopilotOverrides(root: string, env: NodeJS.ProcessEnv = process.env): CopilotOverride[] {
	const file = parseKeyValueFile(path.join(root, '.copilot-version'));

	const overrides: CopilotOverride[] = [];
	for (const pkg of ['sdk', 'runtime'] as const) {
		// Env (queue-time pipeline parameter) wins over the committed file, but an
		// empty/whitespace env value means "unset" and falls back to the file — the
		// pipeline normalizes its 'default' sentinel to an empty string.
		const envValue = (env[`VSCODE_COPILOT_${pkg.toUpperCase()}`] ?? '').trim();
		const value = (envValue || (file.get(pkg) ?? '')).trim();
		if (!value) {
			continue;
		}

		const npmName = COPILOT_NPM_NAME[pkg];
		if (value.startsWith('git:')) {
			const ref = value.slice('git:'.length).trim();
			if (!ref) {
				throw new Error(`[copilot-override] Empty git ref for "${pkg}" (value "${value}").`);
			}
			assertSafeSpec(`${pkg} git ref`, ref);
			overrides.push({ pkg, npmName, kind: 'git', repo: SOURCE_REPO[pkg], ref });
		} else {
			assertSafeSpec(`${pkg} version`, value);
			overrides.push({ pkg, npmName, kind: 'feed', spec: value });
		}
	}
	return overrides;
}
