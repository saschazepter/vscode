/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Scenario template — copy this into `scratchpad/<YYYY-MM-DD>-<short-description>/scenario.mts`
 * and edit the body of `run()`. See ../SKILL.md for the full workflow.
 *
 * Quick start:
 *
 *   # Iterate with the window kept open + agent-browser observing port 9229
 *   node scratchpad/.../scenario.mts --keep-open --port 9229
 *   node scratchpad/.../scenario.mts --reuse     --port 9229   # replay
 *
 *   # Cold autonomous run
 *   node scratchpad/.../scenario.mts
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { launchVSCode, parseCommonArgs } from '../../scripts/launchCode.mts';
import { createHelpers } from '../../scripts/vscodeHelpers.mts';

// ─── Edit this ───────────────────────────────────────────────────────────────
const SCENARIO = 'example-feature';
// ─────────────────────────────────────────────────────────────────────────────

const args = parseCommonArgs(process.argv.slice(2));
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..', '..');

const outputDir = path.resolve(args.output ?? path.join(
	repoRoot, '.build', 'scenario-builder', SCENARIO, new Date().toISOString().replace(/[:.]/g, '-'),
));
const workspace = path.resolve(args.workspace ?? path.join(outputDir, 'workspace'));
await mkdir(workspace, { recursive: true });

const session = await launchVSCode({
	scenario: SCENARIO,
	outputDir,
	workspace,
	port: args.port,
	reuse: args.reuse,
	keepOpen: args.keepOpen,
	temporaryUserData: args.temporaryUserData,
	userDataDir: args.userDataDir,
	seedUserDataDir: args.seedUserDataDir,
	verbose: args.verbose,
});

const helpers = createHelpers(session, { scenario: SCENARIO });

try {
	await run();
} catch (err) {
	console.error(`[scenario] FAILED: ${err instanceof Error ? err.message : err}`);
	process.exitCode = 1;
} finally {
	const summary = await helpers.finish();
	console.log(`[scenario] ${summary.ok ? 'OK' : 'FAIL'} — ${summary.steps.length} steps`);
	console.log(`[scenario] output: ${outputDir}`);
	await session.dispose();
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario body. Wrap each meaningful action in a `step()` so failures attach
// a screenshot and the run name to summary.json automatically.
// ─────────────────────────────────────────────────────────────────────────────
async function run(): Promise<void> {

	await helpers.step('workbench restored', async () => {
		await helpers.waitForElement('.monaco-workbench');
	});

	await helpers.step('toggle activity bar', async () => {
		await helpers.runCommand('workbench.action.toggleActivityBarVisibility');
		// Replace this assertion with whatever proves the feature works:
		await helpers.page.waitForTimeout(100);
	});

	// Discover further selectors with:
	//   npx agent-browser connect <port>
	//   npx agent-browser snapshot -i
	// then add more steps here.
}
