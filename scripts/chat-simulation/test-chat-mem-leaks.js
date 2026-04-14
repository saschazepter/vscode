/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * Chat memory leak checker.
 *
 * Sends multiple messages in a single VS Code session and tracks renderer
 * heap and DOM node count after each message with forced GC. Uses linear
 * regression to detect monotonic growth that indicates a memory leak.
 *
 * Usage:
 *   npm run perf:chat-leak                            # 10 messages, 2MB/msg threshold
 *   npm run perf:chat-leak -- --messages 20            # more messages for accuracy
 *   npm run perf:chat-leak -- --threshold 1            # stricter (1MB/msg)
 *   npm run perf:chat-leak -- --build 1.115.0          # test a specific build
 */

const fs = require('fs');
const path = require('path');
const {
	DATA_DIR, loadConfig,
	resolveBuild, buildEnv, buildArgs, prepareRunDir,
	linearRegressionSlope, launchVSCode,
} = require('./common/utils');

// -- Config (edit config.jsonc to change defaults) ---------------------------

const CONFIG = loadConfig('memLeaks');

// -- CLI args ----------------------------------------------------------------

function parseArgs() {
	const args = process.argv.slice(2);
	const opts = {
		messages: CONFIG.messages ?? 10,
		verbose: false,
		/** @type {string | undefined} */
		build: undefined,
		leakThresholdMB: CONFIG.leakThresholdMB ?? 2,
	};
	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--messages': case '-n': opts.messages = parseInt(args[++i], 10); break;
			case '--verbose': opts.verbose = true; break;
			case '--build': case '-b': opts.build = args[++i]; break;
			case '--threshold': opts.leakThresholdMB = parseFloat(args[++i]); break;
			case '--help': case '-h':
				console.log([
					'Chat memory leak checker',
					'',
					'Options:',
					'  --messages <n>      Number of messages to send (default: 10)',
					'  --build <path|ver>  Path to VS Code build or version to download',
					'  --threshold <MB>    Max per-message heap growth in MB (default: 2)',
					'  --verbose           Print per-message details',
				].join('\n'));
				process.exit(0);
		}
	}
	return opts;
}

// -- Leak check --------------------------------------------------------------

/**
 * @param {string} electronPath
 * @param {{ url: string, requestCount: () => number, waitForRequests: (n: number, ms: number) => Promise<void>, completionCount: () => number, waitForCompletion: (n: number, ms: number) => Promise<void> }} mockServer
 * @param {number} messageCount
 * @param {boolean} verbose
 */
async function runLeakCheck(electronPath, mockServer, messageCount, verbose) {
	const { userDataDir, extDir, logsDir } = prepareRunDir('leak-check', mockServer);
	const isDevBuild = !electronPath.includes('.vscode-test');

	const vscode = await launchVSCode(
		electronPath,
		buildArgs(userDataDir, extDir, logsDir, { isDevBuild }),
		buildEnv(mockServer, { isDevBuild }),
		{ verbose },
	);
	const window = vscode.page;

	try {
		await window.waitForSelector('.monaco-workbench', { timeout: 60_000 });

		const cdp = await window.context().newCDPSession(window);
		await cdp.send('HeapProfiler.enable');

		// Open chat
		const chatShortcut = process.platform === 'darwin' ? 'Control+Meta+KeyI' : 'Control+Alt+KeyI';
		await window.keyboard.press(chatShortcut);

		const CHAT_VIEW = 'div[id="workbench.panel.chat"]';
		const chatEditorSel = `${CHAT_VIEW} .interactive-input-part .monaco-editor[role="code"]`;
		await window.waitForSelector(CHAT_VIEW, { timeout: 15_000 });
		await window.waitForFunction(
			(sel) => Array.from(document.querySelectorAll(sel)).some(el => el.getBoundingClientRect().width > 0),
			chatEditorSel, { timeout: 15_000 },
		);

		// Wait for extension activation
		const reqsBefore = mockServer.requestCount();
		try { await mockServer.waitForRequests(reqsBefore + 4, 30_000); } catch { }
		await new Promise(r => setTimeout(r, 3000));

		/** @type {number[]} */
		const heapSamples = [];
		/** @type {number[]} */
		const domNodeSamples = [];

		for (let i = 0; i < messageCount; i++) {
			// Force GC and measure
			await cdp.send('HeapProfiler.collectGarbage');
			await new Promise(r => setTimeout(r, 200));
			const heapInfo = /** @type {any} */ (await cdp.send('Runtime.getHeapUsage'));
			const heapMB = Math.round(heapInfo.usedSize / 1024 / 1024 * 100) / 100;
			const domNodes = await window.evaluate(() => document.querySelectorAll('*').length);
			heapSamples.push(heapMB);
			domNodeSamples.push(domNodes);

			if (verbose) {
				console.log(`  [leak] Message ${i + 1}/${messageCount}: heap=${heapMB}MB, domNodes=${domNodes}`);
			}

			// Focus and type
			await window.click(chatEditorSel);
			await new Promise(r => setTimeout(r, 200));

			const inputSel = await window.evaluate((editorSel) => {
				const ed = document.querySelector(editorSel);
				if (!ed) { throw new Error('no editor'); }
				return ed.querySelector('.native-edit-context') ? editorSel + ' .native-edit-context' : editorSel + ' textarea';
			}, chatEditorSel);

			const msg = `[scenario:text-only] Leak check message ${i + 1}`;
			const hasDriver = await window.evaluate(() =>
				// @ts-ignore
				!!globalThis.driver?.typeInEditor
			).catch(() => false);

			if (hasDriver) {
				await window.evaluate(({ selector, text }) => {
					// @ts-ignore
					return globalThis.driver.typeInEditor(selector, text);
				}, { selector: inputSel, text: msg });
			} else {
				await window.click(inputSel);
				await new Promise(r => setTimeout(r, 200));
				await window.locator(inputSel).pressSequentially(msg, { delay: 0 });
			}

			const compBefore = mockServer.completionCount();
			await window.keyboard.press('Enter');
			try { await mockServer.waitForCompletion(compBefore + 1, 30_000); } catch { }

			// Wait for response
			const responseSelector = `${CHAT_VIEW} .interactive-item-container.interactive-response`;
			await window.waitForFunction(
				(sel) => {
					const responses = document.querySelectorAll(sel);
					if (responses.length === 0) { return false; }
					return !responses[responses.length - 1].classList.contains('chat-response-loading');
				},
				responseSelector, { timeout: 30_000 },
			);
			await new Promise(r => setTimeout(r, 500));
		}

		// Final measurement
		await cdp.send('HeapProfiler.collectGarbage');
		await new Promise(r => setTimeout(r, 200));
		const finalHeap = /** @type {any} */ (await cdp.send('Runtime.getHeapUsage'));
		heapSamples.push(Math.round(finalHeap.usedSize / 1024 / 1024 * 100) / 100);
		domNodeSamples.push(await window.evaluate(() => document.querySelectorAll('*').length));

		if (verbose) {
			console.log(`  [leak] Final: heap=${heapSamples[heapSamples.length - 1]}MB, domNodes=${domNodeSamples[domNodeSamples.length - 1]}`);
		}

		return {
			heapSamples,
			domNodeSamples,
			leakPerMessageMB: Math.round(linearRegressionSlope(heapSamples) * 100) / 100,
			leakPerMessageNodes: Math.round(linearRegressionSlope(domNodeSamples)),
		};
	} finally {
		await vscode.close();
	}
}

// -- Main --------------------------------------------------------------------

async function main() {
	const opts = parseArgs();
	const electronPath = await resolveBuild(opts.build);

	if (!fs.existsSync(electronPath)) {
		console.error(`Electron not found at: ${electronPath}`);
		process.exit(1);
	}

	const { startServer } = require('./common/mock-llm-server');
	const { registerPerfScenarios } = require('./common/perf-scenarios');
	registerPerfScenarios();
	const mockServer = await startServer(0);

	console.log(`[chat-simulation] Leak check: ${opts.messages} messages, threshold ${opts.leakThresholdMB}MB/msg`);
	console.log(`[chat-simulation] Build: ${electronPath}`);
	console.log('');

	const result = await runLeakCheck(electronPath, mockServer, opts.messages, opts.verbose);

	console.log('[chat-simulation] =================== Leak Check Results ===================');
	console.log('');
	console.log(`  Heap samples (MB): ${result.heapSamples.join(' → ')}`);
	console.log(`  DOM node samples:  ${result.domNodeSamples.join(' → ')}`);
	console.log('');
	const totalHeapDelta = Math.round((result.heapSamples[result.heapSamples.length - 1] - result.heapSamples[0]) * 100) / 100;
	console.log(`  Heap growth:     ${result.heapSamples[0]}MB → ${result.heapSamples[result.heapSamples.length - 1]}MB (delta${totalHeapDelta}MB total)`);
	console.log(`  Per-message heap growth: ${result.leakPerMessageMB}MB/msg`);
	console.log(`  Per-message DOM growth:  ${result.leakPerMessageNodes} nodes/msg`);
	console.log('');

	// Write JSON
	const jsonPath = path.join(DATA_DIR, 'chat-simulation-leak-results.json');
	fs.writeFileSync(jsonPath, JSON.stringify({ timestamp: new Date().toISOString(), ...result }, null, 2));
	console.log(`[chat-simulation] Results written to ${jsonPath}`);

	const leaked = result.leakPerMessageMB > opts.leakThresholdMB;
	console.log('');
	if (leaked) {
		console.log(`[chat-simulation] LEAK DETECTED — ${result.leakPerMessageMB}MB/msg exceeds ${opts.leakThresholdMB}MB/msg threshold`);
	} else {
		console.log(`[chat-simulation] No leak detected (${result.leakPerMessageMB}MB/msg < ${opts.leakThresholdMB}MB/msg)`);
	}

	await mockServer.close();
	process.exit(leaked ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
