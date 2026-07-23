/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { GitOverride } from './copilotOverride.ts';

/**
 * Source build for the `.copilot-version` SDK `git:<ref>` override. The SDK is
 * pure TypeScript, so this clones its public repo, runs the package's own build,
 * and packs a tarball the manifests pin via `file:`. The runtime is a full
 * native build handled separately in `build/lib/copilotRuntimeSource.ts`.
 */

const ROOT = path.join(import.meta.dirname, '../../../');

/** Where clones + build outputs live; git-ignored, cache-key neutral. */
export const OVERRIDES_DIR = path.join(ROOT, '.build', 'copilot-overrides');

const IS_WINDOWS = process.platform === 'win32';
const NPM = IS_WINDOWS ? 'npm.cmd' : 'npm';

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
	console.log(`[copilot-override] $ ${command} ${redactSecrets(args.join(' '))}  (cwd: ${cwd})`);
	// Only `.cmd`/`.bat` shims need a shell; git/node must not use one, or spaced
	// args (e.g. the http.extraheader auth header) get split on Windows.
	const shell = IS_WINDOWS && /\.(cmd|bat)$/i.test(command);
	execFileSync(command, args, { cwd, stdio: 'inherit', shell, env });
}

/** Masks credentials (tokens in URLs / auth headers) before logging a command. */
function redactSecrets(text: string): string {
	return text
		.replace(/(extraheader=AUTHORIZATION: [^\s]+ )\S+/gi, '$1***')
		.replace(/\/\/[^@\s/]+@/g, '//***@');
}

/**
 * Clones `owner/name` at `ref` into `dest` (shallow). Assumes public repos; an
 * optional `COPILOT_OVERRIDE_TOKEN` / `GITHUB_TOKEN` authenticates a private
 * clone via `http.extraheader`, keeping the token out of the URL, `.git/config`
 * and (redacted) logs.
 */
function cloneRepo(repo: string, ref: string, dest: string): void {
	fs.rmSync(dest, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(dest), { recursive: true });

	const token = (process.env['COPILOT_OVERRIDE_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '').trim();
	const authArgs = token ? ['-c', `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : [];
	const url = `https://github.com/${repo}.git`;

	// Shallow clone the single ref. A branch/tag resolves directly; a commit sha
	// needs an unshallowed fetch, so fall back to a full clone + checkout.
	try {
		run('git', [...authArgs, 'clone', '--depth', '1', '--branch', ref, url, dest], ROOT);
	} catch {
		console.log(`[copilot-override] Shallow branch clone failed for ${repo}@${ref}; retrying as a full clone + checkout (commit sha?).`);
		run('git', [...authArgs, 'clone', url, dest], ROOT);
		run('git', ['checkout', ref], dest);
	}
	console.log(`[copilot-override] Cloned ${repo}@${ref} -> ${dest}`);
}

/**
 * Builds `@github/copilot-sdk` from source and returns the absolute path to a
 * packed `.tgz`. Pure TypeScript: install dev deps (ignoring native lifecycle
 * scripts), run the package's own esbuild + `tsc`, then `npm pack`.
 */
export function buildSdkTarball(override: GitOverride): string {
	const srcDir = path.join(OVERRIDES_DIR, 'sdk-src');
	cloneRepo(override.repo, override.ref, srcDir);

	// The publishable package lives in the `nodejs/` workspace of copilot-sdk.
	const pkgDir = path.join(srcDir, 'nodejs');
	if (!fs.existsSync(path.join(pkgDir, 'package.json'))) {
		throw new Error(`[copilot-override] Expected SDK package at ${pkgDir} (nodejs/ workspace not found in ${override.repo}@${override.ref}).`);
	}

	run(NPM, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], pkgDir);
	run(NPM, ['run', 'build'], pkgDir);

	const outDir = path.join(OVERRIDES_DIR, 'sdk-pack');
	fs.rmSync(outDir, { recursive: true, force: true });
	fs.mkdirSync(outDir, { recursive: true });
	run(NPM, ['pack', '--pack-destination', outDir], pkgDir);

	const tarball = fs.readdirSync(outDir).find(name => name.endsWith('.tgz'));
	if (!tarball) {
		throw new Error(`[copilot-override] npm pack produced no tarball for SDK in ${outDir}.`);
	}
	const tarballPath = path.join(outDir, tarball);
	console.log(`[copilot-override] Built SDK tarball ${tarballPath} from ${override.repo}@${override.ref}`);
	return tarballPath;
}
