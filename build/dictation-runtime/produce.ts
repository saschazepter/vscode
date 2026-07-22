/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-(vscode-platform, arch) dictation-runtime producer. Builds the tarball
 * needed by ONE VS Code build, optionally uploads it to the CDN, and writes a
 * small JSON results file that the gulfile-side `packageTask` reads to stamp
 * `product.json`'s `dictationRuntime` field.
 *
 * Run as a pipeline step BEFORE the gulp packaging step on the same agent (via
 * `build/azure-pipelines/common/dictation-runtime-produce.yml`).
 *
 * Behavior split by VSCODE_PUBLISH:
 *   - VSCODE_PUBLISH=true (real release builds): build → upload (HEAD-then-
 *     decide idempotent) → write results JSON → emit task.setvariable so the
 *     gulp step stamps product.dictationRuntime.
 *   - VSCODE_PUBLISH unset / not 'true' (PR / CI / test runs): build only.
 *     The tarball stays on disk at `.build/dictation-runtime/tarballs/` so the
 *     pipeline can publish it as an artifact for inspection, but no CDN upload
 *     happens and no results file is written — so product.json ships without
 *     `dictationRuntime` and the runtime falls back to the SDK's own
 *     `node_modules` payload (dev-from-source behavior).
 *
 * For VS Code builds where no runtime applies (e.g. darwin-x64, Alpine, armhf),
 * exits with no result — product.json ships without `dictationRuntime`.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
	buildCdnUrlTemplate,
	getRuntimeTargetForBuild,
	getRuntimeVersion,
	type IDictationRuntimeResult,
	KNOWN_VSCODE_PLATFORMS,
	parseFlags,
} from './common.ts';
import { buildOne } from './package.ts';
import { uploadOne } from './upload.ts';

const SCRIPT = 'produce.ts';

interface IProduceArgs {
	readonly vscodePlatform: string;
	readonly arch: string;
	readonly tarballsDir: string;
	readonly resultsFile: string;
	readonly upload: boolean;
}

async function main(): Promise<void> {
	const args = parseArgs();
	fs.mkdirSync(args.tarballsDir, { recursive: true });

	const result = await produceOne(args);

	const tarballCount = fs.readdirSync(args.tarballsDir).filter(f => f.endsWith('.tgz')).length;
	if (tarballCount > 0) {
		console.log(`##vso[task.setvariable variable=DICTATION_RUNTIME_TARBALLS_PRODUCED]true`);
	}

	if (!args.upload) {
		console.log(`[${SCRIPT}] upload=false — ${tarballCount} tarball(s) left in ${args.tarballsDir}; skipping results file and DICTATION_RUNTIME_RESULTS_FILE setvariable.`);
		return;
	}

	if (!result) {
		console.log(`[${SCRIPT}] no runtime applies to ${args.vscodePlatform}/${args.arch}; product.json ships without dictationRuntime.`);
		return;
	}

	fs.mkdirSync(path.dirname(args.resultsFile), { recursive: true });
	fs.writeFileSync(args.resultsFile, JSON.stringify(result, null, 2) + '\n');
	console.log(`[${SCRIPT}] Wrote dictationRuntime entry to ${args.resultsFile}`);

	// Tell Azure Pipelines: subsequent steps in this job see
	// DICTATION_RUNTIME_RESULTS_FILE in their env (auto-injected from the variable).
	console.log(`##vso[task.setvariable variable=DICTATION_RUNTIME_RESULTS_FILE]${args.resultsFile}`);
}

async function produceOne(args: IProduceArgs): Promise<IDictationRuntimeResult | undefined> {
	const target = getRuntimeTargetForBuild(args.vscodePlatform, args.arch);
	if (!target) {
		console.log(`[${SCRIPT}] no target for ${args.vscodePlatform}/${args.arch} — skipping`);
		return undefined;
	}
	console.log(`[${SCRIPT}] producing for ${args.vscodePlatform}/${args.arch} → ${target}`);
	const built = await buildOne({ target, outDir: args.tarballsDir });
	if (!args.upload) {
		return undefined;
	}
	// Upload returns the per-target URL; we discard it and emit the `{target}`
	// template instead. Every platform job ends up with the same `urlTemplate` —
	// only the version differs across SDK bumps. The runtime substitutes
	// `{target}` per launch.
	await uploadOne({ version: built.version, target, tgzPath: built.tgzPath, sha256: built.sha256 });
	return { version: built.version, urlTemplate: buildCdnUrlTemplate(built.version) };
}

function parseArgs(): IProduceArgs {
	const flags = parseFlags(process.argv.slice(2));
	const vscodePlatform = flags.get('vscode-platform');
	if (!vscodePlatform || !KNOWN_VSCODE_PLATFORMS.has(vscodePlatform)) {
		throw new Error(`--vscode-platform must be one of ${[...KNOWN_VSCODE_PLATFORMS].join(', ')}; got '${vscodePlatform}'`);
	}
	const arch = flags.get('arch');
	if (!arch) {
		throw new Error('--arch=<arch> is required');
	}
	// Fail loud on a bad pin before doing any work.
	getRuntimeVersion();

	const tarballsDir = path.resolve(process.cwd(), '.build', 'dictation-runtime', 'tarballs');
	const resultsFile = process.env.DICTATION_RUNTIME_RESULTS_FILE
		?? path.resolve(process.cwd(), '.build', 'dictation-runtime', `${vscodePlatform}-${arch}.json`);
	const upload = (process.env.VSCODE_PUBLISH ?? '').toLowerCase() === 'true';
	return { vscodePlatform, arch, tarballsDir, resultsFile, upload };
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
