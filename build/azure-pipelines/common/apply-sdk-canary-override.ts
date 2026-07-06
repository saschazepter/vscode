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
 *   VSCODE_SDK_CANARY_VERSION - version to pin `@github/copilot-sdk` to
 *   VSCODE_CLI_CANARY_VERSION - version to pin `@github/copilot` to
 *
 * npm registry + auth must already be configured in the ambient environment
 * (the orchestrator authenticates to the private feed before invoking this).
 */

const ROOT = path.join(import.meta.dirname, '../../../');

/** Manifests that declare the Copilot dependencies. */
const TARGET_DIRS = ['', 'remote'];

interface Override {
	readonly name: string;
	readonly version: string;
}

function collectOverrides(): Override[] {
	const overrides: Override[] = [];
	const sdkVersion = process.env['VSCODE_SDK_CANARY_VERSION'];
	const cliVersion = process.env['VSCODE_CLI_CANARY_VERSION'];
	if (sdkVersion) {
		overrides.push({ name: '@github/copilot-sdk', version: sdkVersion });
	}
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
	execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
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
