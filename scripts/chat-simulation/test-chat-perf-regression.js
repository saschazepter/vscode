/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * Chat performance benchmark.
 *
 * Uses the real copilot extension with IS_SCENARIO_AUTOMATION=1 and a local
 * mock LLM server. Measures the full stack: prompt building, context
 * gathering, tool resolution, rendering, GC, and layout overhead.
 *
 * Usage:
 *   npm run perf:chat                                 # all scenarios vs 1.115.0
 *   npm run perf:chat -- --runs 10                    # 10 runs per scenario
 *   npm run perf:chat -- --scenario text-only         # single scenario
 *   npm run perf:chat -- --no-baseline                # skip baseline comparison
 *   npm run perf:chat -- --build 1.110.0 --baseline-build 1.115.0
 *   npm run perf:chat -- --resume .chat-simulation-data/2026-04-14/results.json --runs 3
 */

const path = require('path');
const fs = require('fs');
const {
	DATA_DIR, METRIC_DEFS, loadConfig,
	resolveBuild, buildEnv, buildArgs, prepareRunDir,
	robustStats, welchTTest, summarize, markDuration, launchVSCode,
} = require('./common/utils');
const { getUserTurns, getScenarioIds } = require('./common/mock-llm-server');
const { registerPerfScenarios } = require('./common/perf-scenarios');

// -- Config (edit config.jsonc to change defaults) ---------------------------

const CONFIG = loadConfig('perfRegression');

// -- CLI args ----------------------------------------------------------------

function parseArgs() {
	const args = process.argv.slice(2);
	const opts = {
		runs: CONFIG.runsPerScenario ?? 5,
		verbose: false,
		ci: false,
		noCache: false,
		/** @type {string[]} */
		scenarios: [],
		/** @type {string | undefined} */
		build: undefined,
		/** @type {string | undefined} */
		baseline: undefined,
		/** @type {string | undefined} */
		baselineBuild: CONFIG.baselineBuild ?? '1.115.0',
		saveBaseline: false,
		threshold: CONFIG.regressionThreshold ?? 0.2,
		/** @type {string | undefined} */
		resume: undefined,
	};
	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--runs': opts.runs = parseInt(args[++i], 10); break;
			case '--verbose': opts.verbose = true; break;
			case '--scenario': case '-s': opts.scenarios.push(args[++i]); break;
			case '--build': case '-b': opts.build = args[++i]; break;
			case '--baseline': opts.baseline = args[++i]; break;
			case '--baseline-build': opts.baselineBuild = args[++i]; break;
			case '--no-baseline': opts.baselineBuild = undefined; break;
			case '--save-baseline': opts.saveBaseline = true; break;
			case '--threshold': opts.threshold = parseFloat(args[++i]); break;
			case '--resume': opts.resume = args[++i]; break;
			case '--no-cache': opts.noCache = true; break;
			case '--ci': opts.ci = true; opts.noCache = true; break;
			case '--help': case '-h':
				console.log([
					'Chat performance benchmark',
					'',
					'Options:',
					'  --runs <n>          Number of runs per scenario (default: 5)',
					'  --scenario <id>     Scenario to run (repeatable; default: all)',
					'  --build <path|ver>  Path to VS Code build, or a version to download',
					'                       (e.g. "1.110.0", "insiders", commit hash; default: local dev)',
					'  --baseline <path>   Compare against a baseline JSON file',
					'  --baseline-build <v> Download a VS Code version and benchmark it as baseline',
					'                       (default: 1.115.0; accepts "insiders", "1.100.0", commit hash)',
					'  --no-baseline        Skip baseline comparison entirely',
					'  --save-baseline     Save results as the new baseline (requires --baseline <path>)',
					'  --resume <path>     Resume a previous run, adding more iterations to increase',
					'                       confidence. Merges new runs with existing rawRuns data',
					'  --threshold <frac>  Regression threshold fraction (default: 0.2 = 20%)',
					'  --no-cache          Ignore cached baseline data, always run fresh',
					'  --ci                CI mode: write Markdown summary to ci-summary.md (implies --no-cache)',
					'  --verbose           Print per-run details',
					'',
					'Scenarios: ' + getScenarioIds().join(', '),
				].join('\n'));
				process.exit(0);
		}
	}
	if (opts.scenarios.length === 0) {
		opts.scenarios = getScenarioIds();
	}
	return opts;
}

// -- Metrics -----------------------------------------------------------------

/**
 * @typedef {{
 *   timeToUIUpdated: number,
 *   timeToFirstToken: number,
 *   timeToComplete: number,
 *   instructionCollectionTime: number,
 *   agentInvokeTime: number,
 *   heapUsedBefore: number,
 *   heapUsedAfter: number,
 *   heapDelta: number,
 *   heapDeltaPostGC: number,
 *   majorGCs: number,
 *   minorGCs: number,
 *   gcDurationMs: number,
 *   layoutCount: number,
 *   recalcStyleCount: number,
 *   forcedReflowCount: number,
 *   longTaskCount: number,
 *   longAnimationFrameCount: number,
 *   longAnimationFrameTotalMs: number,
 *   frameCount: number,
 *   compositeLayers: number,
 *   paintCount: number,
 *   hasInternalMarks: boolean,
 *   responseHasContent: boolean,
 *   internalFirstToken: number,
 *   profilePath: string,
 *   tracePath: string,
 *   snapshotPath: string,
 * }} RunMetrics
 */

// -- Single run --------------------------------------------------------------

/**
 * @param {string} electronPath
 * @param {string} scenario
 * @param {{ url: string, requestCount: () => number, waitForRequests: (n: number, ms: number) => Promise<void>, completionCount: () => number, waitForCompletion: (n: number, ms: number) => Promise<void> }} mockServer
 * @param {boolean} verbose
 * @param {string} runIndex
 * @param {string} runDir - timestamped run directory for diagnostics
 * @param {'baseline' | 'test'} role - whether this is a baseline or test run
 * @returns {Promise<RunMetrics>}
 */
async function runOnce(electronPath, scenario, mockServer, verbose, runIndex, runDir, role) {
	const { userDataDir, extDir, logsDir } = prepareRunDir(runIndex, mockServer);
	const isDevBuild = !electronPath.includes('.vscode-test');
	// Extract a clean build label from the path.
	// Dev:    .build/electron/Code - OSS.app/.../Code - OSS  → "dev"
	// Stable: .vscode-test/vscode-darwin-arm64-1.115.0/Visual Studio Code.app/.../Electron → "1.115.0"
	let buildLabel = 'dev';
	if (!isDevBuild) {
		const vscodeTestMatch = electronPath.match(/vscode-test\/vscode-[^/]*?-(\d+\.\d+\.\d+)/);
		buildLabel = vscodeTestMatch ? vscodeTestMatch[1] : path.basename(electronPath);
	}

	// Create a per-run diagnostics directory: <runDir>/<role>-<build>/<scenario>-<i>/
	const runDiagDir = path.join(runDir, `${role}-${buildLabel}`, runIndex.replace(/^baseline-/, ''));
	fs.mkdirSync(runDiagDir, { recursive: true });

	const vscode = await launchVSCode(
		electronPath,
		buildArgs(userDataDir, extDir, logsDir, { isDevBuild }),
		buildEnv(mockServer, { isDevBuild }),
		{ verbose },
	);
	activeVSCode = vscode;
	const window = vscode.page;

	try {
		await window.waitForSelector('.monaco-workbench', { timeout: 60_000 });

		const cdp = await window.context().newCDPSession(window);
		await cdp.send('Performance.enable');
		const heapBefore = /** @type {any} */ (await cdp.send('Runtime.getHeapUsage'));

		// Stop any existing tracing session (stable builds may have one active)
		try { await cdp.send('Tracing.end'); await new Promise(r => setTimeout(r, 200)); } catch { }
		await cdp.send('Tracing.start', {
			traceConfig: {
				includedCategories: ['v8.gc', 'devtools.timeline'],
				recordMode: 'recordContinuously',
			}
		});
		const metricsBefore = await cdp.send('Performance.getMetrics');

		// Open chat
		const chatShortcut = process.platform === 'darwin' ? 'Control+Meta+KeyI' : 'Control+Alt+KeyI';
		await window.keyboard.press(chatShortcut);

		const CHAT_VIEW = 'div[id="workbench.panel.chat"]';
		const chatEditorSel = `${CHAT_VIEW} .interactive-input-part .monaco-editor[role="code"]`;

		await window.waitForSelector(CHAT_VIEW, { timeout: 15_000 });
		await window.waitForFunction(
			(selector) => Array.from(document.querySelectorAll(selector)).some(el => {
				const rect = el.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0;
			}),
			chatEditorSel, { timeout: 15_000 },
		);

		// Dismiss dialogs
		const dismissDialog = async () => {
			for (const sel of ['.chat-setup-dialog', '.dialog-shadow', '.monaco-dialog-box']) {
				const el = await window.$(sel);
				if (el) { await window.keyboard.press('Escape'); await new Promise(r => setTimeout(r, 500)); break; }
			}
		};
		await dismissDialog();

		// Wait for extension activation
		const reqsBefore = mockServer.requestCount();
		try { await mockServer.waitForRequests(reqsBefore + 4, 30_000); } catch { }
		if (verbose) {
			console.log(`  [debug] Extension active (${mockServer.requestCount() - reqsBefore} new requests)`);
		}

		// Wait for model resolution
		await new Promise(r => setTimeout(r, 3000));
		await dismissDialog();

		// Focus input
		await window.click(chatEditorSel);
		const focusStart = Date.now();
		while (Date.now() - focusStart < 5_000) {
			const focused = await window.evaluate((sel) => {
				const el = document.querySelector(sel);
				return el && (el.classList.contains('focused') || el.contains(document.activeElement));
			}, chatEditorSel).catch(() => false);
			if (focused) { break; }
			await new Promise(r => setTimeout(r, 50));
		}

		// Type message — use the smoke-test driver's typeInEditor when available
		// (dev builds), fall back to pressSequentially for stable/insiders builds.
		const chatMessage = `[scenario:${scenario}] Explain how this code works`;
		const actualInputSelector = await window.evaluate((editorSel) => {
			const editor = document.querySelector(editorSel);
			if (!editor) { throw new Error('Chat editor not found'); }
			return editor.querySelector('.native-edit-context') ? editorSel + ' .native-edit-context' : editorSel + ' textarea';
		}, chatEditorSel);

		const hasDriver = await window.evaluate(() =>
			// @ts-ignore
			!!globalThis.driver?.typeInEditor
		).catch(() => false);

		if (hasDriver) {
			await window.evaluate(({ selector, text }) => {
				// @ts-ignore
				return globalThis.driver.typeInEditor(selector, text);
			}, { selector: actualInputSelector, text: chatMessage });
		} else {
			// Fallback: click the input element and use pressSequentially
			await window.click(actualInputSelector);
			await new Promise(r => setTimeout(r, 200));
			await window.locator(actualInputSelector).pressSequentially(chatMessage, { delay: 0 });
		}

		// Start CPU profiler to capture call stacks during the interaction
		await cdp.send('Profiler.enable');
		await cdp.send('Profiler.start');

		// Install a PerformanceObserver for Long Animation Frames (LoAF)
		// to capture frame-level jank that longTaskCount alone misses.
		await window.evaluate(() => {
			// @ts-ignore
			globalThis._chatLoAFEntries = [];
			try {
				// @ts-ignore
				globalThis._chatLoAFObserver = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						// @ts-ignore
						globalThis._chatLoAFEntries.push({ duration: entry.duration, startTime: entry.startTime });
					}
				});
				// @ts-ignore
				globalThis._chatLoAFObserver.observe({ type: 'long-animation-frame', buffered: false });
			} catch {
				// long-animation-frame not supported in this build — metrics will be 0
			}
		});

		// Start polling for code/chat/* perf marks inside the renderer.
		// The marks are emitted during the request and cleared immediately
		// after RequestComplete in the same microtask. We poll rapidly from
		// the page context to capture them before they're cleared.
		await window.evaluate(() => {
			// @ts-ignore
			globalThis._chatPerfCapture = [];
			// @ts-ignore
			globalThis._chatPerfPollId = setInterval(() => {
				// @ts-ignore
				const marks = globalThis.MonacoPerformanceMarks?.getMarks() ?? [];
				for (const m of marks) {
					// @ts-ignore
					if (m.name.startsWith('code/chat/') && !globalThis._chatPerfCapture.some(c => c.name === m.name)) {
						// @ts-ignore
						globalThis._chatPerfCapture.push({ name: m.name, startTime: m.startTime });
					}
				}
			}, 16); // poll every frame (~60fps)
		});

		// Submit
		const completionsBefore = mockServer.completionCount();
		const submitTime = Date.now();
		await window.keyboard.press('Enter');

		// Wait for mock server to serve the response
		try { await mockServer.waitForCompletion(completionsBefore + 1, 60_000); } catch { }
		const firstResponseTime = Date.now();

		// Wait for DOM response to settle
		await dismissDialog();
		const responseSelector = `${CHAT_VIEW} .interactive-item-container.interactive-response`;
		await window.waitForFunction(
			(sel) => {
				const responses = document.querySelectorAll(sel);
				if (responses.length === 0) { return false; }
				return !responses[responses.length - 1].classList.contains('chat-response-loading');
			},
			responseSelector, { timeout: 30_000 },
		);
		let responseCompleteTime = Date.now();

		// -- User turn injection loop -----------------------------------------
		// For multi-turn scenarios with user follow-ups, type each follow-up
		// message and wait for the model's response to settle.
		const userTurns = getUserTurns(scenario);
		for (let ut = 0; ut < userTurns.length; ut++) {
			const userTurn = userTurns[ut];
			if (verbose) {
				console.log(`  [debug] User follow-up ${ut + 1}/${userTurns.length}: "${userTurn.message}"`);
			}

			// Brief pause to let the UI settle between turns
			await new Promise(r => setTimeout(r, 500));

			// Focus the chat input
			await window.click(chatEditorSel);
			const utFocusStart = Date.now();
			while (Date.now() - utFocusStart < 3_000) {
				const focused = await window.evaluate((sel) => {
					const el = document.querySelector(sel);
					return el && (el.classList.contains('focused') || el.contains(document.activeElement));
				}, chatEditorSel).catch(() => false);
				if (focused) { break; }
				await new Promise(r => setTimeout(r, 50));
			}

			// Type the follow-up message
			if (hasDriver) {
				await window.evaluate(({ selector, text }) => {
					// @ts-ignore
					return globalThis.driver.typeInEditor(selector, text);
				}, { selector: actualInputSelector, text: userTurn.message });
			} else {
				await window.click(actualInputSelector);
				await new Promise(r => setTimeout(r, 200));
				await window.locator(actualInputSelector).pressSequentially(userTurn.message, { delay: 0 });
			}

			// Note current response count before submitting
			const responseCountBefore = await window.evaluate((sel) => {
				return document.querySelectorAll(sel).length;
			}, responseSelector);

			// Submit follow-up
			const utCompBefore = mockServer.completionCount();
			await window.keyboard.press('Enter');

			// Wait for mock server to serve the response for this turn
			try { await mockServer.waitForCompletion(utCompBefore + 1, 60_000); } catch { }

			// Wait for a new response element to appear and settle
			await dismissDialog();
			await window.waitForFunction(
				({ sel, prevCount }) => {
					const responses = document.querySelectorAll(sel);
					if (responses.length <= prevCount) { return false; }
					return !responses[responses.length - 1].classList.contains('chat-response-loading');
				},
				{ sel: responseSelector, prevCount: responseCountBefore },
				{ timeout: 30_000 },
			);
			responseCompleteTime = Date.now();

			if (verbose) {
				const utResponseInfo = await window.evaluate((sel) => {
					const responses = document.querySelectorAll(sel);
					const last = responses[responses.length - 1];
					return last ? (last.textContent || '').substring(0, 150) : '(empty)';
				}, responseSelector);
				console.log(`  [debug] Follow-up response (first 150 chars): ${utResponseInfo}`);
			}
		}

		// Stop CPU profiler and save the profile
		const { profile } = /** @type {any} */ (await cdp.send('Profiler.stop'));
		const profilePath = path.join(runDiagDir, 'profile.cpuprofile');
		fs.writeFileSync(profilePath, JSON.stringify(profile));
		if (verbose) {
			console.log(`  [debug] CPU profile saved to ${profilePath}`);
		}

		const responseInfo = await window.evaluate((sel) => {
			const responses = document.querySelectorAll(sel);
			const last = responses[responses.length - 1];
			if (!last) { return { hasContent: false, text: '' }; }
			const text = last.textContent || '';
			return { hasContent: text.trim().length > 0, text: text.substring(0, 200) };
		}, responseSelector);

		if (verbose) {
			console.log(`  [debug] Response content (first 200 chars): ${responseInfo.text}`);
			console.log(`  [debug] Client-side timing: firstResponse=${firstResponseTime - submitTime}ms, complete=${responseCompleteTime - submitTime}ms`);
		}

		// Collect perf marks from our polling capture and stop the poll
		const chatMarks = await window.evaluate(() => {
			// @ts-ignore
			clearInterval(globalThis._chatPerfPollId);
			// @ts-ignore
			const marks = globalThis._chatPerfCapture ?? [];
			// @ts-ignore
			delete globalThis._chatPerfCapture;
			// @ts-ignore
			delete globalThis._chatPerfPollId;
			return marks;
		});
		if (verbose && chatMarks.length > 0) {
			console.log(`  [debug] chatMarks (${chatMarks.length}): ${chatMarks.map((/** @type {any} */ m) => m.name.split('/').slice(-1)[0]).join(', ')}`);
		}

		// Collect Long Animation Frame entries and tear down the observer
		const loafData = await window.evaluate(() => {
			// @ts-ignore
			if (globalThis._chatLoAFObserver) { globalThis._chatLoAFObserver.disconnect(); }
			// @ts-ignore
			const entries = globalThis._chatLoAFEntries ?? [];
			// @ts-ignore
			delete globalThis._chatLoAFEntries;
			// @ts-ignore
			delete globalThis._chatLoAFObserver;
			const count = entries.length;
			const totalMs = entries.reduce((/** @type {number} */ sum, /** @type {any} */ e) => sum + e.duration, 0);
			return { count, totalMs };
		});

		const heapAfter = /** @type {any} */ (await cdp.send('Runtime.getHeapUsage'));
		/** @type {Array<any>} */
		const traceEvents = [];
		cdp.on('Tracing.dataCollected', (/** @type {any} */ data) => { traceEvents.push(...data.value); });
		const tracingComplete = new Promise(resolve => {
			cdp.once('Tracing.tracingComplete', () => resolve(undefined));
		});
		await cdp.send('Tracing.end');
		await tracingComplete;
		const metricsAfter = await cdp.send('Performance.getMetrics');

		// Save performance trace (Chrome DevTools format)
		const tracePath = path.join(runDiagDir, 'trace.json');
		fs.writeFileSync(tracePath, JSON.stringify({ traceEvents }));

		// Take heap snapshot
		const snapshotPath = path.join(runDiagDir, 'heap.heapsnapshot');
		await cdp.send('HeapProfiler.enable');
		const snapshotChunks = /** @type {string[]} */ ([]);
		cdp.on('HeapProfiler.addHeapSnapshotChunk', (/** @type {any} */ params) => {
			snapshotChunks.push(params.chunk);
		});
		await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
		fs.writeFileSync(snapshotPath, snapshotChunks.join(''));

		// Parse timing — prefer internal code/chat/* marks (precise, in-process)
		// with client-side Date.now() as fallback for older builds without marks.
		const timeToUIUpdated = markDuration(chatMarks, 'request/start', 'request/uiUpdated');
		const internalFirstToken = markDuration(chatMarks, 'request/start', 'request/firstToken');
		const timeToFirstToken = internalFirstToken >= 0 ? internalFirstToken : (firstResponseTime - submitTime);
		const timeToComplete = responseCompleteTime - submitTime;
		const instructionCollectionTime = markDuration(chatMarks, 'request/willCollectInstructions', 'request/didCollectInstructions');
		const agentInvokeTime = markDuration(chatMarks, 'agent/willInvoke', 'agent/didInvoke');

		// Parse GC events from trace.
		// Use the trace-event category and phase fields which are stable
		// across V8 versions, rather than matching event name substrings.
		let majorGCs = 0, minorGCs = 0, gcDurationMs = 0;
		for (const event of traceEvents) {
			const isGC = event.cat === 'v8.gc'
				|| event.cat === 'devtools.timeline,v8'
				|| (typeof event.cat === 'string' && event.cat.split(',').some((/** @type {string} */ c) => c.trim() === 'v8.gc'));
			if (!isGC) { continue; }
			// Only count complete ('X') or duration-begin ('B') events to
			// avoid double-counting begin/end pairs.
			if (event.ph && event.ph !== 'X' && event.ph !== 'B') { continue; }
			const name = event.name || '';
			if (/Major|MarkCompact|MSC|MC|IncrementalMarking|FinalizeMC/i.test(name)) { majorGCs++; }
			else if (/Minor|Scaveng/i.test(name)) { minorGCs++; }
			else { minorGCs++; } // default unknown GC events to minor
			if (event.dur) { gcDurationMs += event.dur / 1000; }
		}
		let longTaskCount = 0;
		for (const event of traceEvents) {
			if (event.name === 'RunTask' && event.dur && event.dur > 50_000) { longTaskCount++; }
		}

		/** @param {any} r @param {string} name */
		function getMetric(r, name) {
			const e = r.metrics?.find((/** @type {any} */ m) => m.name === name);
			return e ? e.value : 0;
		}

		return {
			timeToUIUpdated, timeToFirstToken, timeToComplete, instructionCollectionTime, agentInvokeTime,
			heapUsedBefore: Math.round(heapBefore.usedSize / 1024 / 1024),
			heapUsedAfter: Math.round(heapAfter.usedSize / 1024 / 1024),
			heapDelta: Math.round((heapAfter.usedSize - heapBefore.usedSize) / 1024 / 1024),
			heapDeltaPostGC: await (async () => {
				// Force a full GC then measure heap to get deterministic retained-memory delta.
				// --js-flags=--expose-gc is not required: CDP's Runtime.evaluate can call gc()
				// when includeCommandLineAPI is true.
				try {
					await cdp.send('Runtime.evaluate', { expression: 'gc()', awaitPromise: false, includeCommandLineAPI: true });
					await new Promise(r => setTimeout(r, 200));
					const heapPostGC = /** @type {any} */ (await cdp.send('Runtime.getHeapUsage'));
					return Math.round((heapPostGC.usedSize - heapBefore.usedSize) / 1024 / 1024);
				} catch {
					return -1; // gc() not available in this build
				}
			})(),
			majorGCs, minorGCs,
			gcDurationMs: Math.round(gcDurationMs * 100) / 100,
			layoutCount: getMetric(metricsAfter, 'LayoutCount') - getMetric(metricsBefore, 'LayoutCount'),
			recalcStyleCount: getMetric(metricsAfter, 'RecalcStyleCount') - getMetric(metricsBefore, 'RecalcStyleCount'),
			forcedReflowCount: getMetric(metricsAfter, 'ForcedStyleRecalcs') - getMetric(metricsBefore, 'ForcedStyleRecalcs'),
			longTaskCount,
			longAnimationFrameCount: loafData.count,
			longAnimationFrameTotalMs: Math.round(loafData.totalMs * 100) / 100,
			frameCount: getMetric(metricsAfter, 'FrameCount') - getMetric(metricsBefore, 'FrameCount'),
			compositeLayers: getMetric(metricsAfter, 'CompositeLayers') - getMetric(metricsBefore, 'CompositeLayers'),
			paintCount: getMetric(metricsAfter, 'PaintCount') - getMetric(metricsBefore, 'PaintCount'),
			hasInternalMarks: chatMarks.length > 0,
			responseHasContent: responseInfo.hasContent,
			internalFirstToken,
			profilePath,
			tracePath,
			snapshotPath,
		};
	} finally {
		activeVSCode = null;
		await vscode.close();
	}
}

// -- CI summary generation ---------------------------------------------------

/**
 * Generate a detailed Markdown summary table for CI.
 * Printed to stdout and written to ci-summary.md.
 *
 * @param {Record<string, any>} jsonReport
 * @param {Record<string, any> | null} baseline
 * @param {{ threshold: number, runs: number, baselineBuild?: string, build?: string }} opts
 */
function generateCISummary(jsonReport, baseline, opts) {
	const baseLabel = opts.baselineBuild || 'baseline';
	const testLabel = opts.build || 'dev (local)';
	const allMetrics = [
		['timeToFirstToken', 'timing', 'ms'],
		['timeToComplete', 'timing', 'ms'],
		['layoutCount', 'rendering', ''],
		['recalcStyleCount', 'rendering', ''],
		['forcedReflowCount', 'rendering', ''],
		['longTaskCount', 'rendering', ''],
		['longAnimationFrameCount', 'rendering', ''],
		['longAnimationFrameTotalMs', 'rendering', 'ms'],
		['frameCount', 'rendering', ''],
		['compositeLayers', 'rendering', ''],
		['paintCount', 'rendering', ''],
		['heapDelta', 'memory', 'MB'],
		['heapDeltaPostGC', 'memory', 'MB'],
		['gcDurationMs', 'memory', 'ms'],
	];
	const regressionMetricNames = new Set(['timeToFirstToken', 'timeToComplete', 'layoutCount', 'recalcStyleCount', 'forcedReflowCount', 'longTaskCount', 'longAnimationFrameCount']);

	const lines = [];
	const scenarios = Object.keys(jsonReport.scenarios);

	lines.push(`# Chat Performance Comparison`);
	lines.push('');
	lines.push(`| | |`);
	lines.push(`|---|---|`);
	lines.push(`| **Baseline** | \`${baseLabel}\` |`);
	lines.push(`| **Test** | \`${testLabel}\` |`);
	lines.push(`| **Runs per scenario** | ${opts.runs} |`);
	lines.push(`| **Regression threshold** | ${(opts.threshold * 100).toFixed(0)}% |`);
	lines.push(`| **Scenarios** | ${scenarios.length} |`);
	lines.push(`| **Platform** | ${process.platform} / ${process.arch} |`);
	lines.push('');

	// Overall status
	let totalRegressions = 0;
	let totalImprovements = 0;

	// Per-scenario tables
	for (const scenario of scenarios) {
		const current = jsonReport.scenarios[scenario];
		const base = baseline?.scenarios?.[scenario];

		lines.push(`## ${scenario}`);
		lines.push('');

		if (!base) {
			lines.push('> No baseline data for this scenario.');
			lines.push('');

			// Show absolute values
			lines.push('| Metric | Value | StdDev | CV | n |');
			lines.push('|--------|------:|-------:|---:|--:|');
			for (const [metric, group, unit] of allMetrics) {
				const cur = current[group]?.[metric];
				if (!cur) { continue; }
				lines.push(`| ${metric} | ${cur.median}${unit} | \xb1${cur.stddev}${unit} | ${(cur.cv * 100).toFixed(0)}% | ${cur.n} |`);
			}
			lines.push('');
			continue;
		}

		lines.push(`| Metric | Baseline | Test | Change | p-value | Verdict |`);
		lines.push(`|--------|----------|------|--------|---------|---------|`);

		for (const [metric, group, unit] of allMetrics) {
			const cur = current[group]?.[metric];
			const bas = base[group]?.[metric];
			if (!cur || !bas || bas.median === null || bas.median === undefined) { continue; }

			const change = bas.median !== 0 ? (cur.median - bas.median) / bas.median : 0;
			const pct = `${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}%`;
			const isRegressionMetric = regressionMetricNames.has(metric);

			// t-test
			const curRaw = (current.rawRuns || []).map((/** @type {any} */ r) => r[metric]).filter((/** @type {any} */ v) => v >= 0);
			const basRaw = (base.rawRuns || []).map((/** @type {any} */ r) => r[metric]).filter((/** @type {any} */ v) => v >= 0);
			const ttest = welchTTest(basRaw, curRaw);
			const pStr = ttest ? `${ttest.pValue}` : 'n/a';

			let verdict = '';
			if (isRegressionMetric) {
				if (change > opts.threshold) {
					if (!ttest) {
						verdict = 'REGRESSION';
						totalRegressions++;
					} else if (ttest.significant) {
						verdict = 'REGRESSION';
						totalRegressions++;
					} else {
						verdict = 'noise';
					}
				} else if (change < -opts.threshold && ttest?.significant) {
					verdict = 'improved';
					totalImprovements++;
				} else {
					verdict = 'ok';
				}
			} else {
				verdict = 'info';
			}

			const basStr = `${bas.median}${unit} \xb1${bas.stddev}${unit}`;
			const curStr = `${cur.median}${unit} \xb1${cur.stddev}${unit}`;
			lines.push(`| ${metric} | ${basStr} | ${curStr} | ${pct} | ${pStr} | ${verdict} |`);
		}
		lines.push('');
	}

	// Grand summary
	lines.push('## Summary');
	lines.push('');
	if (totalRegressions > 0) {
		lines.push(`**${totalRegressions} regression(s) detected** across ${scenarios.length} scenario(s).`);
	} else if (totalImprovements > 0) {
		lines.push(`**No regressions.** ${totalImprovements} improvement(s) detected.`);
	} else {
		lines.push(`**No significant changes** across ${scenarios.length} scenario(s).`);
	}
	lines.push('');

	// Raw data per scenario
	lines.push('<details><summary>Raw run data</summary>');
	lines.push('');
	for (const scenario of scenarios) {
		const current = jsonReport.scenarios[scenario];
		lines.push(`### ${scenario}`);
		lines.push('');
		lines.push('| Run | TTFT (ms) | Complete (ms) | Layouts | Style Recalcs | LoAF Count | LoAF (ms) | Frames | Heap Delta (MB) | Internal Marks |');
		lines.push('|----:|----------:|--------------:|--------:|--------------:|-----------:|----------:|-------:|----------------:|:--------------:|');
		const runs = current.rawRuns || [];
		for (let i = 0; i < runs.length; i++) {
			const r = runs[i];
			lines.push(`| ${i + 1} | ${r.timeToFirstToken} | ${r.timeToComplete} | ${r.layoutCount} | ${r.recalcStyleCount} | ${r.longAnimationFrameCount ?? '-'} | ${r.longAnimationFrameTotalMs ?? '-'} | ${r.frameCount ?? '-'} | ${r.heapDelta} | ${r.hasInternalMarks ? 'yes' : 'no'} |`);
		}
		lines.push('');
	}
	if (baseline) {
		for (const scenario of scenarios) {
			const base = baseline.scenarios?.[scenario];
			if (!base) { continue; }
			lines.push(`### ${scenario} (baseline)`);
			lines.push('');
			lines.push('| Run | TTFT (ms) | Complete (ms) | Layouts | Style Recalcs | LoAF Count | LoAF (ms) | Frames | Heap Delta (MB) | Internal Marks |');
			lines.push('|----:|----------:|--------------:|--------:|--------------:|-----------:|----------:|-------:|----------------:|:--------------:|');
			const runs = base.rawRuns || [];
			for (let i = 0; i < runs.length; i++) {
				const r = runs[i];
				lines.push(`| ${i + 1} | ${r.timeToFirstToken} | ${r.timeToComplete} | ${r.layoutCount} | ${r.recalcStyleCount} | ${r.longAnimationFrameCount ?? '-'} | ${r.longAnimationFrameTotalMs ?? '-'} | ${r.frameCount ?? '-'} | ${r.heapDelta} | ${r.hasInternalMarks ? 'yes' : 'no'} |`);
			}
			lines.push('');
		}
	}
	lines.push('</details>');
	lines.push('');

	return lines.join('\n');
}

// -- Cleanup on SIGINT/SIGTERM -----------------------------------------------

/** @type {{ close: () => Promise<void> } | null} */
let activeVSCode = null;
/** @type {{ close: () => Promise<void> } | null} */
let activeMockServer = null;

function installSignalHandlers() {
	const cleanup = async () => {
		console.log('\n[chat-simulation] Caught interrupt, cleaning up...');
		try { await activeVSCode?.close(); } catch { }
		try { await activeMockServer?.close(); } catch { }
		process.exit(130);
	};
	process.on('SIGINT', cleanup);
	process.on('SIGTERM', cleanup);
}

// -- Main --------------------------------------------------------------------

async function main() {
	registerPerfScenarios();
	const opts = parseArgs();

	installSignalHandlers();

	const { startServer } = require('./common/mock-llm-server');
	const mockServer = await startServer(0);
	activeMockServer = mockServer;
	console.log(`[chat-simulation] Mock LLM server: ${mockServer.url}`);

	// -- Resume mode --------------------------------------------------------
	if (opts.resume) {
		if (!fs.existsSync(opts.resume)) {
			console.error(`[chat-simulation] Resume file not found: ${opts.resume}`);
			process.exit(1);
		}
		const prevResults = JSON.parse(fs.readFileSync(opts.resume, 'utf-8'));
		const prevDir = path.dirname(opts.resume);

		// Find the associated baseline JSON in the same directory
		const baselineFiles = fs.readdirSync(prevDir).filter((/** @type {string} */ f) => f.startsWith('baseline-') && f.endsWith('.json'));
		const baselineFile = baselineFiles.length > 0 ? path.join(prevDir, baselineFiles[0]) : null;
		const prevBaseline = baselineFile ? JSON.parse(fs.readFileSync(baselineFile, 'utf-8')) : null;

		// Determine which scenarios to resume (default: all from previous run)
		const resumeScenarios = opts.scenarios.length > 0
			? opts.scenarios.filter(s => prevResults.scenarios?.[s])
			: Object.keys(prevResults.scenarios || {});

		if (resumeScenarios.length === 0) {
			console.error('[chat-simulation] No matching scenarios found in previous results');
			process.exit(1);
		}

		const testElectron = await resolveBuild(opts.build);
		const baselineVersion = prevBaseline?.baselineBuildVersion;
		const baselineElectron = baselineVersion ? await resolveBuild(baselineVersion) : null;

		const runsToAdd = opts.runs;
		console.log(`[chat-simulation] Resuming from: ${opts.resume}`);
		console.log(`[chat-simulation] Adding ${runsToAdd} runs per scenario`);
		console.log(`[chat-simulation] Scenarios: ${resumeScenarios.join(', ')}`);
		if (prevBaseline) {
			console.log(`[chat-simulation] Baseline: ${baselineVersion} (${prevBaseline.scenarios?.[resumeScenarios[0]]?.rawRuns?.length || 0} existing runs)`);
		}
		console.log('');

		for (const scenario of resumeScenarios) {
			console.log(`[chat-simulation] === Resuming: ${scenario} ===`);
			const prevTestRuns = prevResults.scenarios[scenario]?.rawRuns || [];
			const prevBaseRuns = prevBaseline?.scenarios?.[scenario]?.rawRuns || [];

			// Run additional test iterations
			console.log(`[chat-simulation]   Test build (${prevTestRuns.length} existing + ${runsToAdd} new)`);
			for (let i = 0; i < runsToAdd; i++) {
				const runIdx = `${scenario}-resume-${prevTestRuns.length + i}`;
				console.log(`[chat-simulation]     Run ${i + 1}/${runsToAdd}...`);
				try {
					const m = await runOnce(testElectron, scenario, mockServer, opts.verbose, runIdx, prevDir, 'test');
					prevTestRuns.push(m);
					if (opts.verbose) {
						const src = m.hasInternalMarks ? 'internal' : 'client-side';
						console.log(`      [${src}] firstToken=${m.timeToFirstToken}ms, complete=${m.timeToComplete}ms`);
					}
				} catch (err) { console.error(`      Run ${i + 1} failed: ${err}`); }
			}

			// Run additional baseline iterations
			if (baselineElectron && prevBaseline?.scenarios?.[scenario]) {
				console.log(`[chat-simulation]   Baseline build (${prevBaseRuns.length} existing + ${runsToAdd} new)`);
				for (let i = 0; i < runsToAdd; i++) {
					const runIdx = `baseline-${scenario}-resume-${prevBaseRuns.length + i}`;
					console.log(`[chat-simulation]     Run ${i + 1}/${runsToAdd}...`);
					try {
						const m = await runOnce(baselineElectron, scenario, mockServer, opts.verbose, runIdx, prevDir, 'baseline');
						prevBaseRuns.push(m);
					} catch (err) { console.error(`      Run ${i + 1} failed: ${err}`); }
				}
			}

			// Recompute stats with merged data
			const sd = /** @type {any} */ ({ runs: prevTestRuns.length, timing: {}, memory: {}, rendering: {}, rawRuns: prevTestRuns });
			for (const [metric, group] of METRIC_DEFS) { sd[group][metric] = robustStats(prevTestRuns.map((/** @type {any} */ r) => r[metric])); }
			prevResults.scenarios[scenario] = sd;

			if (prevBaseline?.scenarios?.[scenario]) {
				const bsd = /** @type {any} */ ({ runs: prevBaseRuns.length, timing: {}, memory: {}, rendering: {}, rawRuns: prevBaseRuns });
				for (const [metric, group] of METRIC_DEFS) { bsd[group][metric] = robustStats(prevBaseRuns.map((/** @type {any} */ r) => r[metric])); }
				prevBaseline.scenarios[scenario] = bsd;
			}
			console.log(`[chat-simulation]   Merged: test n=${prevTestRuns.length}${prevBaseRuns.length > 0 ? `, baseline n=${prevBaseRuns.length}` : ''}`);
			console.log('');
		}

		// Write updated files back
		prevResults.runsPerScenario = Math.max(prevResults.runsPerScenario || 0, ...Object.values(prevResults.scenarios).map((/** @type {any} */ s) => s.runs));
		prevResults.lastResumed = new Date().toISOString();
		fs.writeFileSync(opts.resume, JSON.stringify(prevResults, null, 2));
		console.log(`[chat-simulation] Updated results: ${opts.resume}`);

		if (prevBaseline && baselineFile) {
			prevBaseline.lastResumed = new Date().toISOString();
			fs.writeFileSync(baselineFile, JSON.stringify(prevBaseline, null, 2));
			// Also update cached baseline
			const cachedPath = path.join(DATA_DIR, path.basename(baselineFile));
			fs.writeFileSync(cachedPath, JSON.stringify(prevBaseline, null, 2));
			console.log(`[chat-simulation] Updated baseline: ${baselineFile}`);
		}

		// -- Re-run comparison with merged data --------------------------------
		opts.baseline = baselineFile || undefined;
		const jsonReport = prevResults;
		jsonReport._resultsPath = opts.resume;

		// Fall through to comparison logic below
		await printComparison(jsonReport, opts);
		await mockServer.close();
		return;
	}

	// -- Normal (non-resume) flow -------------------------------------------
	const electronPath = await resolveBuild(opts.build);

	if (!fs.existsSync(electronPath)) {
		console.error(`Electron not found at: ${electronPath}`);
		console.error('Run "node build/lib/preLaunch.ts" first, or pass --build <path>');
		process.exit(1);
	}

	// Create a timestamped run directory for all output
	const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const runDir = path.join(DATA_DIR, runTimestamp);
	fs.mkdirSync(runDir, { recursive: true });
	console.log(`[chat-simulation] Output: ${runDir}`);

	// -- Baseline build --------------------------------------------------
	if (opts.baselineBuild) {
		const baselineJsonPath = path.join(runDir, `baseline-${opts.baselineBuild}.json`);
		const cachedPath = path.join(DATA_DIR, `baseline-${opts.baselineBuild}.json`);
		const cachedBaseline = !opts.noCache && fs.existsSync(cachedPath)
			? JSON.parse(fs.readFileSync(cachedPath, 'utf-8'))
			: null;

		if (cachedBaseline?.baselineBuildVersion === opts.baselineBuild) {
			// Check if the cache covers all requested scenarios
			const cachedScenarios = new Set(Object.keys(cachedBaseline.scenarios || {}));
			const missingScenarios = opts.scenarios.filter((/** @type {string} */ s) => !cachedScenarios.has(s));

			// Also check if cached scenarios have fewer runs than requested
			const shortScenarios = opts.scenarios.filter((/** @type {string} */ s) => {
				const cached = cachedBaseline.scenarios?.[s];
				return cached && (cached.rawRuns?.length || 0) < opts.runs;
			});

			if (missingScenarios.length === 0 && shortScenarios.length === 0) {
				console.log(`[chat-simulation] Using cached baseline for ${opts.baselineBuild}`);
				fs.writeFileSync(baselineJsonPath, JSON.stringify(cachedBaseline, null, 2));
				opts.baseline = baselineJsonPath;
			} else {
				const scenariosToRun = [...new Set([...missingScenarios, ...shortScenarios])];
				if (missingScenarios.length > 0) {
					console.log(`[chat-simulation] Cached baseline missing scenarios: ${missingScenarios.join(', ')}`);
				}
				if (shortScenarios.length > 0) {
					console.log(`[chat-simulation] Cached baseline needs more runs for: ${shortScenarios.map((/** @type {string} */ s) => `${s} (${cachedBaseline.scenarios[s].rawRuns?.length || 0}/${opts.runs})`).join(', ')}`);
				}
				console.log(`[chat-simulation] Running baseline for ${scenariosToRun.length} scenario(s)...`);
				const baselineExePath = await resolveBuild(opts.baselineBuild);
				for (const scenario of scenariosToRun) {
					const existingRuns = cachedBaseline.scenarios?.[scenario]?.rawRuns || [];
					const runsNeeded = opts.runs - existingRuns.length;
					/** @type {RunMetrics[]} */
					const newResults = [];
					for (let i = 0; i < runsNeeded; i++) {
						try { newResults.push(await runOnce(baselineExePath, scenario, mockServer, opts.verbose, `baseline-${scenario}-${existingRuns.length + i}`, runDir, 'baseline')); }
						catch (err) { console.error(`[chat-simulation]   Baseline run ${i + 1} failed: ${err}`); }
					}
					const allRuns = [...existingRuns, ...newResults];
					if (allRuns.length > 0) {
						const sd = /** @type {any} */ ({ runs: allRuns.length, timing: {}, memory: {}, rendering: {}, rawRuns: allRuns });
						for (const [metric, group] of METRIC_DEFS) { sd[group][metric] = robustStats(allRuns.map((/** @type {any} */ r) => r[metric])); }
						cachedBaseline.scenarios[scenario] = sd;
					}
				}
				cachedBaseline.runsPerScenario = opts.runs;
				fs.writeFileSync(baselineJsonPath, JSON.stringify(cachedBaseline, null, 2));
				fs.writeFileSync(cachedPath, JSON.stringify(cachedBaseline, null, 2));
				opts.baseline = baselineJsonPath;
			}
		} else {
			const baselineExePath = await resolveBuild(opts.baselineBuild);
			console.log(`[chat-simulation] Benchmarking baseline build (${opts.baselineBuild})...`);
			/** @type {Record<string, RunMetrics[]>} */
			const baselineResults = {};
			for (const scenario of opts.scenarios) {
				/** @type {RunMetrics[]} */
				const results = [];
				for (let i = 0; i < opts.runs; i++) {
					try { results.push(await runOnce(baselineExePath, scenario, mockServer, opts.verbose, `baseline-${scenario}-${i}`, runDir, 'baseline')); }
					catch (err) { console.error(`[chat-simulation]   Baseline run ${i + 1} failed: ${err}`); }
				}
				if (results.length > 0) { baselineResults[scenario] = results; }
			}
			const baselineReport = {
				timestamp: new Date().toISOString(),
				baselineBuildVersion: opts.baselineBuild,
				platform: process.platform,
				runsPerScenario: opts.runs,
				scenarios: /** @type {Record<string, any>} */ ({}),
			};
			for (const [scenario, results] of Object.entries(baselineResults)) {
				const sd = /** @type {any} */ ({ runs: results.length, timing: {}, memory: {}, rendering: {}, rawRuns: results });
				for (const [metric, group] of METRIC_DEFS) { sd[group][metric] = robustStats(results.map(r => /** @type {any} */(r)[metric])); }
				baselineReport.scenarios[scenario] = sd;
			}
			fs.writeFileSync(baselineJsonPath, JSON.stringify(baselineReport, null, 2));
			// Cache at the top level for reuse across runs
			fs.writeFileSync(cachedPath, JSON.stringify(baselineReport, null, 2));
			opts.baseline = baselineJsonPath;
		}
		console.log('');
	}

	// -- Run benchmarks --------------------------------------------------
	console.log(`[chat-simulation] Electron: ${electronPath}`);
	console.log(`[chat-simulation] Runs per scenario: ${opts.runs}`);
	console.log(`[chat-simulation] Scenarios: ${opts.scenarios.join(', ')}`);
	console.log('');

	/** @type {Record<string, RunMetrics[]>} */
	const allResults = {};
	let anyFailed = false;

	for (const scenario of opts.scenarios) {
		console.log(`[chat-simulation] === Scenario: ${scenario} ===`);
		/** @type {RunMetrics[]} */
		const results = [];
		for (let i = 0; i < opts.runs; i++) {
			console.log(`[chat-simulation]   Run ${i + 1}/${opts.runs}...`);
			try {
				const metrics = await runOnce(electronPath, scenario, mockServer, opts.verbose, `${scenario}-${i}`, runDir, 'test');
				results.push(metrics);
				if (opts.verbose) {
					const src = metrics.hasInternalMarks ? 'internal' : 'client-side';
					console.log(`    [${src}] firstToken=${metrics.timeToFirstToken}ms, complete=${metrics.timeToComplete}ms, heap=delta${metrics.heapDelta}MB, longTasks=${metrics.longTaskCount}${metrics.hasInternalMarks ? `, internalTTFT=${metrics.internalFirstToken}ms` : ''}`);
				}
			} catch (err) { console.error(`    Run ${i + 1} failed: ${err}`); }
		}
		if (results.length === 0) { console.error(`[chat-simulation]   All runs failed for scenario: ${scenario}`); anyFailed = true; }
		else { allResults[scenario] = results; }
		console.log('');
	}

	// -- Summary ---------------------------------------------------------
	console.log('[chat-simulation] ======================= Summary =======================');
	for (const [scenario, results] of Object.entries(allResults)) {
		console.log('');
		console.log(`  -- ${scenario} (${results.length} runs) --`);
		console.log('');
		console.log('  Timing:');
		console.log(summarize(results.map(r => r.timeToFirstToken), '  Request → First token ', 'ms'));
		console.log(summarize(results.map(r => r.timeToComplete), '  Request → Complete    ', 'ms'));
		console.log('');
		console.log('  Rendering:');
		console.log(summarize(results.map(r => r.layoutCount), '  Layouts               ', ''));
		console.log(summarize(results.map(r => r.recalcStyleCount), '  Style recalcs         ', ''));
		console.log(summarize(results.map(r => r.forcedReflowCount), '  Forced reflows        ', ''));
		console.log(summarize(results.map(r => r.longTaskCount), '  Long tasks (>50ms)    ', ''));
		console.log(summarize(results.map(r => r.longAnimationFrameCount), '  Long anim. frames     ', ''));
		console.log(summarize(results.map(r => r.longAnimationFrameTotalMs), '  LoAF total duration   ', 'ms'));
		console.log(summarize(results.map(r => r.frameCount), '  Frames                ', ''));
		console.log(summarize(results.map(r => r.compositeLayers), '  Composite layers      ', ''));
		console.log(summarize(results.map(r => r.paintCount), '  Paints                ', ''));
		console.log('');
		console.log('  Memory:');
		console.log(summarize(results.map(r => r.heapDelta), '  Heap delta            ', 'MB'));
		console.log(summarize(results.map(r => r.heapDeltaPostGC), '  Heap delta (post-GC)  ', 'MB'));
		console.log(summarize(results.map(r => r.gcDurationMs), '  GC duration           ', 'ms'));
	}

	// -- JSON output -----------------------------------------------------
	const jsonPath = path.join(runDir, 'results.json');
	const jsonReport = /** @type {{ timestamp: string, platform: NodeJS.Platform, runsPerScenario: number, scenarios: Record<string, any>, _resultsPath?: string }} */ ({ timestamp: new Date().toISOString(), platform: process.platform, runsPerScenario: opts.runs, scenarios: /** @type {Record<string, any>} */ ({}) });
	for (const [scenario, results] of Object.entries(allResults)) {
		const sd = /** @type {any} */ ({ runs: results.length, timing: {}, memory: {}, rendering: {}, rawRuns: results });
		for (const [metric, group] of METRIC_DEFS) { sd[group][metric] = robustStats(results.map(r => /** @type {any} */(r)[metric])); }
		jsonReport.scenarios[scenario] = sd;
	}
	fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));
	jsonReport._resultsPath = jsonPath;
	console.log('');
	console.log(`[chat-simulation] Results written to ${jsonPath}`);

	// -- Save baseline ---------------------------------------------------
	if (opts.saveBaseline) {
		if (!opts.baseline) { console.error('[chat-simulation] --save-baseline requires --baseline <path>'); process.exit(1); }
		fs.writeFileSync(opts.baseline, JSON.stringify(jsonReport, null, 2));
		console.log(`[chat-simulation] Baseline saved to ${opts.baseline}`);
	}

	// -- Baseline comparison ---------------------------------------------
	await printComparison(jsonReport, opts);

	if (anyFailed) { process.exit(1); }
	await mockServer.close();
}

/**
 * Print baseline comparison and exit with code 1 if regressions found.
 * @param {Record<string, any>} jsonReport
 * @param {{ baseline?: string, threshold: number, ci?: boolean, runs?: number, baselineBuild?: string, build?: string, resume?: string }} opts
 */
async function printComparison(jsonReport, opts) {
	let regressionFound = false;
	let inconclusiveFound = false;
	if (opts.baseline && fs.existsSync(opts.baseline)) {
		const baseline = JSON.parse(fs.readFileSync(opts.baseline, 'utf-8'));
		console.log('');
		console.log(`[chat-simulation] =========== Baseline Comparison (threshold: ${(opts.threshold * 100).toFixed(0)}%) ===========`);
		console.log(`[chat-simulation] Baseline: ${baseline.baselineBuildVersion || baseline.timestamp}`);
		console.log('');

		// Metrics that trigger regression failure when they exceed the threshold
		const regressionMetrics = [
			// [metric, group, unit]
			['timeToFirstToken', 'timing', 'ms'],
			['timeToComplete', 'timing', 'ms'],
			['layoutCount', 'rendering', ''],
			['recalcStyleCount', 'rendering', ''],
			['forcedReflowCount', 'rendering', ''],
			['longTaskCount', 'rendering', ''],
		];
		// Informational metrics — shown in comparison but don't trigger failure
		const infoMetrics = [
			['heapDelta', 'memory', 'MB'],
			['gcDurationMs', 'memory', 'ms'],
		];

		for (const scenario of Object.keys(jsonReport.scenarios)) {
			const current = jsonReport.scenarios[scenario];
			const base = baseline.scenarios?.[scenario];
			if (!base) { console.log(`  ${scenario}: (no baseline)`); continue; }

			/** @type {string[]} */
			const diffs = [];
			let scenarioRegression = false;

			for (const [metric, group, unit] of regressionMetrics) {
				const cur = current[group]?.[metric];
				const bas = base[group]?.[metric];
				if (!cur || !bas || !bas.median) { continue; }
				const change = (cur.median - bas.median) / bas.median;
				const pct = `${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}%`;

				// Statistical significance via Welch's t-test on raw run values
				const curRaw = (current.rawRuns || []).map((/** @type {any} */ r) => r[metric]).filter((/** @type {any} */ v) => v >= 0);
				const basRaw = (base.rawRuns || []).map((/** @type {any} */ r) => r[metric]).filter((/** @type {any} */ v) => v >= 0);
				const ttest = welchTTest(basRaw, curRaw);

				let flag = '';
				if (change > opts.threshold) {
					if (!ttest) {
						flag = ' ← possible regression (n too small for significance test)';
						inconclusiveFound = true;
					} else if (ttest.significant) {
						flag = ` ← REGRESSION (p=${ttest.pValue}, ${ttest.confidence} confidence)`;
						scenarioRegression = true;
						regressionFound = true;
					} else {
						flag = ` (likely noise — p=${ttest.pValue}, not significant)`;
						inconclusiveFound = true;
					}
				} else if (ttest && change > 0 && ttest.significant && ttest.confidence === 'high') {
					flag = ` (significant increase, p=${ttest.pValue})`;
				}
				diffs.push(`    ${metric}: ${bas.median}${unit} → ${cur.median}${unit} (${pct})${flag}`);
			}
			for (const [metric, group, unit] of infoMetrics) {
				const cur = current[group]?.[metric];
				const bas = base[group]?.[metric];
				if (!cur || !bas || bas.median === null || bas.median === undefined) { continue; }
				const change = bas.median !== 0 ? (cur.median - bas.median) / bas.median : 0;
				const pct = `${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}%`;
				diffs.push(`    ${metric}: ${bas.median}${unit} → ${cur.median}${unit} (${pct}) [info]`);
			}
			console.log(`  ${scenario}: ${scenarioRegression ? 'FAIL' : 'OK'}`);
			diffs.forEach(d => console.log(d));
		}

		console.log('');
		console.log(regressionFound
			? `[chat-simulation] REGRESSION DETECTED — exceeded ${(opts.threshold * 100).toFixed(0)}% threshold with statistical significance`
			: `[chat-simulation] All metrics within ${(opts.threshold * 100).toFixed(0)}% of baseline (or not statistically significant)`);

		if (inconclusiveFound && !regressionFound) {
			// Find the results.json path to suggest in the hint
			const resultsPath = Object.keys(jsonReport.scenarios).length > 0
				? (jsonReport._resultsPath || opts.resume || 'path/to/results.json')
				: 'path/to/results.json';
			// Estimate required runs from the observed effect size and variance
			// using power analysis for Welch's t-test (alpha=0.05, 80% power).
			// n_per_group = 2 * ((z_alpha/2 + z_beta) / d)^2 where d = Cohen's d
			let maxNeeded = 0;
			for (const scenario of Object.keys(jsonReport.scenarios)) {
				const current = jsonReport.scenarios[scenario];
				const base = baseline.scenarios?.[scenario];
				if (!base) { continue; }
				for (const [metric, group] of [['timeToFirstToken', 'timing'], ['timeToComplete', 'timing'], ['layoutCount', 'rendering'], ['recalcStyleCount', 'rendering']]) {
					const curRaw = (current.rawRuns || []).map((/** @type {any} */ r) => r[metric]).filter((/** @type {any} */ v) => v >= 0);
					const basRaw = (base.rawRuns || []).map((/** @type {any} */ r) => r[metric]).filter((/** @type {any} */ v) => v >= 0);
					if (curRaw.length < 2 || basRaw.length < 2) { continue; }
					const meanA = basRaw.reduce((/** @type {number} */ s, /** @type {number} */ v) => s + v, 0) / basRaw.length;
					const meanB = curRaw.reduce((/** @type {number} */ s, /** @type {number} */ v) => s + v, 0) / curRaw.length;
					const varA = basRaw.reduce((/** @type {number} */ s, /** @type {number} */ v) => s + (v - meanA) ** 2, 0) / (basRaw.length - 1);
					const varB = curRaw.reduce((/** @type {number} */ s, /** @type {number} */ v) => s + (v - meanB) ** 2, 0) / (curRaw.length - 1);
					const pooledSD = Math.sqrt((varA + varB) / 2);
					if (pooledSD === 0) { continue; }
					const d = Math.abs(meanB - meanA) / pooledSD;
					if (d === 0) { continue; }
					// z_0.025 = 1.96, z_0.2 = 0.842
					const nPerGroup = Math.ceil(2 * ((1.96 + 0.842) / d) ** 2);
					const currentN = Math.min(curRaw.length, basRaw.length);
					maxNeeded = Math.max(maxNeeded, nPerGroup - currentN);
				}
			}
			const suggestedRuns = Math.max(1, Math.min(maxNeeded, 20));
			console.log('');
			console.log('[chat-simulation] Some metrics exceeded the threshold but were not statistically significant.');
			console.log('[chat-simulation] To increase confidence, add more runs with --resume:');
			console.log(`[chat-simulation]   npm run perf:chat -- --resume ${resultsPath} --runs ${suggestedRuns}`);
		}
	}

	// -- CI summary ------------------------------------------------------
	if (opts.ci) {
		const ciBaseline = opts.baseline && fs.existsSync(opts.baseline)
			? JSON.parse(fs.readFileSync(opts.baseline, 'utf-8'))
			: null;
		const summary = generateCISummary(jsonReport, ciBaseline, {
			threshold: opts.threshold,
			runs: jsonReport.runsPerScenario || opts.runs,
			baselineBuild: ciBaseline?.baselineBuildVersion || opts.baselineBuild,
			build: opts.build,
		});

		// Write to file for GitHub Actions $GITHUB_STEP_SUMMARY
		const summaryPath = path.join(DATA_DIR, 'ci-summary.md');
		fs.writeFileSync(summaryPath, summary);
		console.log(`[chat-simulation] CI summary written to ${summaryPath}`);

		// Also print the full summary table to stdout
		console.log('');
		console.log('==================================================================');
		console.log('               CHAT PERF COMPARISON RESULTS                       ');
		console.log('==================================================================');
		console.log('');
		console.log(summary);
	}

	if (regressionFound) { process.exit(1); }
}

main().catch(err => { console.error(err); process.exit(1); });
