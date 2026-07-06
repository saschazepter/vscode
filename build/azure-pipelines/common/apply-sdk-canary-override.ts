/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * Stage 3 of the Copilot SDK -> VS Code integration pipeline.
 * See microsoft/vscode-engineering specs/sdk-vscode-integration.spec.md.
 *
 * Overrides the `@github/copilot-sdk` and/or `@github/copilot` dependency in the
 * root and `remote` manifests to a canary version published to the private npm
 * feed, then refreshes the lockfiles so `npm ci` stays consistent (and the
 * node_modules cache key, derived from these manifests + lockfiles, naturally
 * misses).
 *
 * Driven by environment variables so it is a no-op in normal builds:
 *   VSCODE_SDK_CANARY_VERSION - version to pin `@github/copilot-sdk` to (empty =
 *                               no override / normal build)
 *   VSCODE_CLI_CANARY_VERSION - version to pin `@github/copilot` to. When empty
 *                               (and an SDK version is set) the CLI version is
 *                               inferred from the SDK's own `@github/copilot`
 *                               dependency so the two stay compatible.
 *
 * npm registry + auth must already be configured in the ambient environment
 * (the orchestrator authenticates to the private feed before invoking this).
 */

const ROOT = path.join(import.meta.dirname, '../../../');

/** On Windows `npm` is a `.cmd` shim that `execFileSync` cannot resolve without a shell. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Manifests that declare the Copilot dependencies. */
const TARGET_DIRS = ['', 'remote'];

interface Override {
	readonly name: string;
	readonly version: string;
}

/**
 * Infers the `@github/copilot` version to use from the SDK canary's own
 * `@github/copilot` dependency range, resolved to a concrete published version.
 * Returns undefined (leaving VS Code's pinned CLI) if the SDK declares no such
 * dependency or resolution fails — inference is best-effort, never fatal.
 */
function inferCliVersion(sdkVersion: string): string | undefined {
	try {
		const depsRaw = execFileSync(NPM, ['view', `@github/copilot-sdk@${sdkVersion}`, 'dependencies', '--json'], { encoding: 'utf8' });
		const deps = JSON.parse(depsRaw || '{}');
		const range = deps['@github/copilot'];
		if (!range) {
			console.log(`[canary-override] SDK ${sdkVersion} declares no @github/copilot dependency — leaving VS Code's pinned CLI.`);
			return undefined;
		}
		const versionRaw = execFileSync(NPM, ['view', `@github/copilot@${range}`, 'version', '--json'], { encoding: 'utf8' });
		const parsed = JSON.parse(versionRaw);
		const resolved = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
		if (typeof resolved !== 'string') {
			console.warn(`[canary-override] Could not resolve @github/copilot@${range} to a concrete version — leaving VS Code's pinned CLI.`);
			return undefined;
		}
		console.log(`[canary-override] Inferred @github/copilot ${resolved} from @github/copilot-sdk@${sdkVersion} (range ${range}).`);
		return resolved;
	} catch (err) {
		console.warn(`[canary-override] Failed to infer @github/copilot from SDK ${sdkVersion}: ${err instanceof Error ? err.message : err}. Leaving VS Code's pinned CLI.`);
		return undefined;
	}
}

function collectOverrides(): Override[] {
	const sdkVersion = (process.env['VSCODE_SDK_CANARY_VERSION'] ?? '').trim();
	if (!sdkVersion) {
		return [];
	}
	const overrides: Override[] = [{ name: '@github/copilot-sdk', version: sdkVersion }];

	// Explicit CLI version wins; empty means "infer from the SDK".
	const cliVersion = (process.env['VSCODE_CLI_CANARY_VERSION'] ?? '').trim() || inferCliVersion(sdkVersion);
	if (cliVersion) {
		overrides.push({ name: '@github/copilot', version: cliVersion });
	}
	return overrides;
}

function applyOverrides(dir: string, overrides: Override[]): Override[] {
	const packageJsonPath = path.join(ROOT, dir, 'package.json');
	const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
	const dependencies = packageJson.dependencies ?? {};

	const applied: Override[] = [];
	for (const override of overrides) {
		const { name, version } = override;
		if (Object.prototype.hasOwnProperty.call(dependencies, name) && dependencies[name] !== version) {
			dependencies[name] = version;
			applied.push(override);
			console.log(`[canary-override] ${path.join(dir, 'package.json')}: ${name} -> ${version}`);
		}
	}

	if (applied.length > 0) {
		packageJson.dependencies = dependencies;
		fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
	}
	return applied;
}

function refreshLockfile(dir: string): void {
	// Refresh only the lockfile (no node_modules writes, no lifecycle scripts)
	// so `npm ci` in the product build resolves the overridden versions. This
	// contacts the configured registry, so npm auth for the private feed must
	// already be established in the ambient environment.
	execFileSync(NPM, ['install', '--package-lock-only', '--ignore-scripts'], {
		cwd: path.join(ROOT, dir),
		stdio: 'inherit'
	});
}

/**
 * Confirms the refreshed lockfile actually resolved each override to the
 * requested version. Fails loudly if a version is missing (e.g. not published
 * to the feed, or a registry/auth misconfiguration) so a bad canary version is
 * caught here rather than surfacing as a confusing downstream build error.
 */
function verifyResolved(dir: string, overrides: Override[]): void {
	const lockPath = path.join(ROOT, dir, 'package-lock.json');
	const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
	const packages = lock.packages ?? {};
	for (const { name, version } of overrides) {
		const entry = packages[`node_modules/${name}`];
		if (!entry) {
			throw new Error(`[canary-override] ${path.join(dir, 'package-lock.json')}: ${name} not found after lockfile refresh — is ${name}@${version} published to the feed and is npm auth configured?`);
		}
		if (entry.version !== version) {
			throw new Error(`[canary-override] ${path.join(dir, 'package-lock.json')}: ${name} resolved to ${entry.version}, expected ${version}`);
		}
		console.log(`[canary-override] verified ${path.join(dir, 'package-lock.json')}: ${name}@${entry.version} (resolved ${entry.resolved ?? '<no url>'})`);
	}
}

function main(): void {
	const overrides = collectOverrides();
	if (overrides.length === 0) {
		console.log('[canary-override] No canary versions set — nothing to do.');
		return;
	}

	for (const dir of TARGET_DIRS) {
		const applied = applyOverrides(dir, overrides);
		if (applied.length > 0) {
			refreshLockfile(dir);
			verifyResolved(dir, applied);
		}
	}
}

main();
