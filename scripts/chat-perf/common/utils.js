/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

/**
 * Shared utilities for chat performance benchmarks and leak checks.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const DATA_DIR = path.join(ROOT, '.chat-perf-data');

const SCENARIOS = [
	'text-only',
	'large-codeblock',
	'many-small-chunks',
	'mixed-content',
	'many-codeblocks',
	'long-prose',
	'rich-markdown',
	'giant-codeblock',
	'rapid-stream',
	'file-links',
	'tool-read-file',
	'tool-edit-file',
];

// -- Electron path resolution ------------------------------------------------

function getElectronPath() {
	const product = require(path.join(ROOT, 'product.json'));
	if (process.platform === 'darwin') {
		return path.join(ROOT, '.build', 'electron', `${product.nameLong}.app`, 'Contents', 'MacOS', product.nameShort);
	} else if (process.platform === 'linux') {
		return path.join(ROOT, '.build', 'electron', product.applicationName);
	} else {
		return path.join(ROOT, '.build', 'electron', `${product.nameShort}.exe`);
	}
}

/**
 * Returns true if the string looks like a VS Code version or commit hash
 * rather than a file path.
 * @param {string} value
 */
function isVersionString(value) {
	if (value === 'insiders' || value === 'stable') { return true; }
	if (/^\d+\.\d+\.\d+/.test(value)) { return true; }
	if (/^[0-9a-f]{7,40}$/.test(value)) { return true; }
	return false;
}

/**
 * Resolve a build arg to an executable path.
 * Version strings are downloaded via @vscode/test-electron.
 * @param {string | undefined} buildArg
 * @returns {Promise<string>}
 */
async function resolveBuild(buildArg) {
	if (!buildArg) {
		return getElectronPath();
	}
	if (isVersionString(buildArg)) {
		console.log(`[chat-perf] Downloading VS Code ${buildArg}...`);
		const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron');
		const exePath = await downloadAndUnzipVSCode(buildArg);
		console.log(`[chat-perf] Downloaded: ${exePath}`);

		// Install the copilot extension into our shared extensions dir so it's
		// available when we launch with --extensions-dir=DATA_DIR/extensions.
		const extDir = path.join(DATA_DIR, 'extensions');
		fs.mkdirSync(extDir, { recursive: true });
		const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(exePath);
		const extId = 'GitHub.copilot';
		console.log(`[chat-perf] Installing ${extId} into ${extDir}...`);
		const { spawnSync } = require('child_process');
		const result = spawnSync(cli, [...cliArgs, '--extensions-dir', extDir, '--install-extension', extId], {
			encoding: 'utf-8',
			stdio: 'pipe',
			shell: process.platform === 'win32',
			timeout: 120_000,
		});
		if (result.status !== 0) {
			console.warn(`[chat-perf] Extension install exited with ${result.status}: ${(result.stderr || '').substring(0, 500)}`);
		} else {
			console.log(`[chat-perf] ${extId} installed`);
		}

		return exePath;
	}
	return path.resolve(buildArg);
}

// -- Storage pre-seeding -----------------------------------------------------

/**
 * Pre-seed the VS Code storage database to prevent the
 * BuiltinChatExtensionEnablementMigration from disabling the copilot
 * extension on fresh user data directories.
 * @param {string} userDataDir
 */
function preseedStorage(userDataDir) {
	const globalStorageDir = path.join(userDataDir, 'User', 'globalStorage');
	fs.mkdirSync(globalStorageDir, { recursive: true });
	const dbPath = path.join(globalStorageDir, 'state.vscdb');
	execSync(`sqlite3 "${dbPath}" "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB); INSERT INTO ItemTable (key, value) VALUES ('builtinChatExtensionEnablementMigration', 'true');"`);
}

// -- Launch helpers ----------------------------------------------------------

/**
 * Build the environment variables for launching VS Code with the mock server.
 * @param {{ url: string }} mockServer
 * @param {{ isDevBuild?: boolean }} [opts]
 * @returns {Record<string, string>}
 */
function buildEnv(mockServer, { isDevBuild = true } = {}) {
	/** @type {Record<string, string>} */
	const env = {
		...process.env,
		ELECTRON_ENABLE_LOGGING: '1',
		IS_SCENARIO_AUTOMATION: '1',
		GITHUB_PAT: 'perf-benchmark-fake-pat',
		VSCODE_COPILOT_CHAT_TOKEN: Buffer.from(JSON.stringify({
			token: 'perf-benchmark-fake-token',
			expires_at: Math.floor(Date.now() / 1000) + 3600,
			refresh_in: 1800,
			sku: 'free_limited_copilot',
			individual: true,
			isNoAuthUser: true,
			copilot_plan: 'free',
			organization_login_list: [],
			endpoints: { api: mockServer.url, proxy: mockServer.url },
		})).toString('base64'),
	};
	// Dev-only flags — these tell Electron to load the app from source (out/)
	// instead of the packaged app. Setting them on a stable build causes it
	// to fail to show a window.
	if (isDevBuild) {
		env.NODE_ENV = 'development';
		env.VSCODE_DEV = '1';
		env.VSCODE_CLI = '1';
	}
	return env;
}

/**
 * Build the default VS Code launch args.
 * @param {string} userDataDir
 * @param {string} extDir
 * @param {string} logsDir
 * @returns {string[]}
 */
function buildArgs(userDataDir, extDir, logsDir, { isDevBuild = true } = {}) {
	const args = [
		ROOT,
		'--skip-release-notes',
		'--skip-welcome',
		'--disable-telemetry',
		'--disable-updates',
		'--disable-workspace-trust',
		`--user-data-dir=${userDataDir}`,
		`--extensions-dir=${extDir}`,
		`--logsPath=${logsDir}`,
		'--enable-smoke-test-driver',
	];
	// vscode-api-tests only exists in the dev build
	if (isDevBuild) {
		args.push('--disable-extension=vscode.vscode-api-tests');
	}
	if (process.platform !== 'darwin') {
		args.push('--disable-gpu');
	}
	return args;
}

/**
 * Write VS Code settings that point the copilot extension at the mock server.
 * @param {string} userDataDir
 * @param {{ url: string }} mockServer
 */
function writeSettings(userDataDir, mockServer) {
	const settingsDir = path.join(userDataDir, 'User');
	fs.mkdirSync(settingsDir, { recursive: true });
	fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
		'github.copilot.advanced.debug.overrideProxyUrl': mockServer.url,
		'github.copilot.advanced.debug.overrideCapiUrl': mockServer.url,
		'chat.allowAnonymousAccess': true,
		// Disable MCP servers — they start async and add unpredictable
		// delay that pollutes perf measurements.
		'chat.mcp.discovery.enabled': false,
		'chat.mcp.enabled': false,
		'github.copilot.chat.githubMcpServer.enabled': false,
		'github.copilot.chat.cli.mcp.enabled': false,
	}, null, '\t'));
}

/**
 * Prepare a fresh run directory (clean, create, preseed, write settings).
 * @param {string} runId
 * @param {{ url: string }} mockServer
 * @returns {{ userDataDir: string, extDir: string, logsDir: string }}
 */
function prepareRunDir(runId, mockServer) {
	const tmpBase = path.join(os.tmpdir(), 'vscode-chat-perf');
	const userDataDir = path.join(tmpBase, `run-${runId}`);
	const extDir = path.join(DATA_DIR, 'extensions');
	const logsDir = path.join(tmpBase, 'logs', `run-${runId}`);
	// Retry rmSync to handle ENOTEMPTY race conditions from Electron cache locks
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			fs.rmSync(userDataDir, { recursive: true, force: true });
			break;
		} catch (err) {
			if (attempt < 2 && err.code === 'ENOTEMPTY') {
				require('child_process').execSync(`sleep 0.5`);
			} else {
				throw err;
			}
		}
	}
	fs.mkdirSync(userDataDir, { recursive: true });
	fs.mkdirSync(extDir, { recursive: true });
	fs.mkdirSync(logsDir, { recursive: true });
	preseedStorage(userDataDir);
	writeSettings(userDataDir, mockServer);
	return { userDataDir, extDir, logsDir };
}

// -- VS Code launch via CDP --------------------------------------------------

/**
 * Fetch JSON from a URL. Used to probe the CDP endpoint.
 * @param {string} url
 * @returns {Promise<any>}
 */
function getJson(url) {
	return new Promise((resolve, reject) => {
		http.get(url, res => {
			let data = '';
			res.on('data', chunk => { data += chunk; });
			res.on('end', () => {
				try { resolve(JSON.parse(data)); }
				catch { reject(new Error(`Invalid JSON from ${url}`)); }
			});
		}).on('error', reject);
	});
}

/**
 * Wait until VS Code exposes its CDP endpoint.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitForCDP(port, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await getJson(`http://127.0.0.1:${port}/json/version`);
			return;
		} catch {
			await new Promise(r => setTimeout(r, 500));
		}
	}
	throw new Error(`Timed out waiting for CDP on port ${port}`);
}

/**
 * Find the workbench page among all CDP pages.
 * For dev builds this checks for `globalThis.driver` (smoke-test driver).
 * For stable builds it checks for `.monaco-workbench` in the DOM.
 * @param {import('playwright').Browser} browser
 * @param {number} timeoutMs
 * @returns {Promise<import('playwright').Page>}
 */
async function findWorkbenchPage(browser, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const pages = browser.contexts().flatMap(ctx => ctx.pages());
		for (const page of pages) {
			const hasWorkbench = await page.evaluate(() =>
				// @ts-ignore
				!!globalThis.driver?.whenWorkbenchRestored || !!document.querySelector('.monaco-workbench')
			).catch(() => false);
			if (hasWorkbench) {
				return page;
			}
		}
		await new Promise(r => setTimeout(r, 500));
	}
	throw new Error('Timed out waiting for the workbench page');
}

/** @type {number} */
let nextPort = 19222;

/**
 * Launch VS Code via child_process and connect via CDP.
 * Works with dev builds, insiders, and stable releases.
 *
 * @param {string} executable - Path to the VS Code executable (Electron binary or CLI)
 * @param {string[]} launchArgs - Arguments to pass to the executable
 * @param {Record<string, string>} env - Environment variables
 * @param {{ verbose?: boolean }} [opts]
 * @returns {Promise<{ page: import('playwright').Page, browser: import('playwright').Browser, close: () => Promise<void> }>}
 */
async function launchVSCode(executable, launchArgs, env, opts = {}) {
	const { chromium } = require('playwright');
	const port = nextPort++;

	const args = [`--remote-debugging-port=${port}`, ...launchArgs];
	const isShell = process.platform === 'win32';

	if (opts.verbose) {
		console.log(`  [launch] ${executable} ${args.slice(0, 3).join(' ')} ... (port ${port})`);
	}

	const child = spawn(executable, args, {
		cwd: ROOT,
		env,
		shell: isShell,
		stdio: opts.verbose ? 'inherit' : ['ignore', 'ignore', 'ignore'],
	});

	// Track early exit
	let exitError = /** @type {Error | null} */ (null);
	child.once('exit', (code, signal) => {
		if (!exitError) {
			exitError = new Error(`VS Code exited before CDP connected (code=${code} signal=${signal})`);
		}
	});

	// Wait for CDP
	try {
		await waitForCDP(port);
	} catch (e) {
		if (exitError) { throw exitError; }
		throw e;
	}

	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	const page = await findWorkbenchPage(browser);

	return {
		page,
		browser,
		close: async () => {
			await browser.close().catch(() => { });
			const pid = child.pid;
			if (pid) {
				if (process.platform === 'win32') {
					try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }); }
					catch { }
				} else {
					try { execSync(`pkill -TERM -P ${pid}`, { stdio: 'ignore' }); }
					catch { }
					child.kill('SIGTERM');
				}
			}
			await new Promise(resolve => {
				const timer = setTimeout(() => {
					if (pid) {
						try { execSync(`pkill -9 -P ${pid}`, { stdio: 'ignore' }); }
						catch { }
					}
					child.kill('SIGKILL');
					resolve(undefined);
				}, 3000);
				child.once('exit', () => { clearTimeout(timer); resolve(undefined); });
			});
			// Kill crashpad handler — it self-daemonizes and outlives the
			// parent. Wait briefly for it to detach, then kill by pattern.
			await new Promise(r => setTimeout(r, 500));
			try { execSync('pkill -9 -f crashpad_handler.*vscode-chat-perf', { stdio: 'ignore' }); }
			catch { }
		},
	};
}

// -- Statistics --------------------------------------------------------------

/**
 * @param {number[]} values
 */
function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Remove outliers using IQR method.
 * @param {number[]} values
 * @returns {number[]}
 */
function removeOutliers(values) {
	if (values.length < 4) { return values; }
	const sorted = [...values].sort((a, b) => a - b);
	const q1 = sorted[Math.floor(sorted.length * 0.25)];
	const q3 = sorted[Math.floor(sorted.length * 0.75)];
	const iqr = q3 - q1;
	const lo = q1 - 1.5 * iqr;
	const hi = q3 + 1.5 * iqr;
	return sorted.filter(v => v >= lo && v <= hi);
}

/**
 * Regularized incomplete beta function I_x(a, b) via continued fraction.
 * Used for computing t-distribution CDF / p-values.
 * @param {number} x
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function betaIncomplete(x, a, b) {
	if (x <= 0) { return 0; }
	if (x >= 1) { return 1; }
	// Use symmetry relation when x > (a+1)/(a+b+2) for better convergence
	if (x > (a + 1) / (a + b + 2)) {
		return 1 - betaIncomplete(1 - x, b, a);
	}
	// Log-beta via Stirling: lnBeta(a,b) = lnGamma(a)+lnGamma(b)-lnGamma(a+b)
	const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
	const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;
	// Lentz's continued fraction
	const maxIter = 200;
	const eps = 1e-14;
	let c = 1, d = 1 - (a + b) * x / (a + 1);
	if (Math.abs(d) < eps) { d = eps; }
	d = 1 / d;
	let result = d;
	for (let m = 1; m <= maxIter; m++) {
		// Even step
		let num = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
		d = 1 + num * d; if (Math.abs(d) < eps) { d = eps; } d = 1 / d;
		c = 1 + num / c; if (Math.abs(c) < eps) { c = eps; }
		result *= d * c;
		// Odd step
		num = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
		d = 1 + num * d; if (Math.abs(d) < eps) { d = eps; } d = 1 / d;
		c = 1 + num / c; if (Math.abs(c) < eps) { c = eps; }
		const delta = d * c;
		result *= delta;
		if (Math.abs(delta - 1) < eps) { break; }
	}
	return front * result;
}

/**
 * Log-gamma via Lanczos approximation.
 * @param {number} z
 * @returns {number}
 */
function lnGamma(z) {
	const g = 7;
	const coef = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
		771.32342877765313, -176.61502916214059, 12.507343278686905,
		-0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
	if (z < 0.5) {
		return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
	}
	z -= 1;
	let x = coef[0];
	for (let i = 1; i < g + 2; i++) { x += coef[i] / (z + i); }
	const t = z + g + 0.5;
	return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Two-tailed p-value from t-distribution.
 * @param {number} t - t-statistic
 * @param {number} df - degrees of freedom
 * @returns {number}
 */
function tDistPValue(t, df) {
	const x = df / (df + t * t);
	return betaIncomplete(x, df / 2, 0.5);
}

/**
 * Welch's t-test for two independent samples (unequal variance).
 * @param {number[]} a - Sample 1 (e.g., baseline values)
 * @param {number[]} b - Sample 2 (e.g., current values)
 * @returns {{ t: number, df: number, pValue: number, significant: boolean, confidence: string } | null}
 */
function welchTTest(a, b) {
	if (a.length < 2 || b.length < 2) { return null; }
	const meanA = a.reduce((s, v) => s + v, 0) / a.length;
	const meanB = b.reduce((s, v) => s + v, 0) / b.length;
	const varA = a.reduce((s, v) => s + (v - meanA) ** 2, 0) / (a.length - 1);
	const varB = b.reduce((s, v) => s + (v - meanB) ** 2, 0) / (b.length - 1);
	const seA = varA / a.length;
	const seB = varB / b.length;
	const seDiff = Math.sqrt(seA + seB);
	if (seDiff === 0) { return null; }
	const t = (meanB - meanA) / seDiff;
	// Welch-Satterthwaite degrees of freedom
	const df = (seA + seB) ** 2 / ((seA ** 2) / (a.length - 1) + (seB ** 2) / (b.length - 1));
	const pValue = tDistPValue(t, df);
	const significant = pValue < 0.05;
	let confidence;
	if (pValue < 0.01) { confidence = 'high'; }
	else if (pValue < 0.05) { confidence = 'medium'; }
	else if (pValue < 0.1) { confidence = 'low'; }
	else { confidence = 'none'; }
	return { t: Math.round(t * 100) / 100, df: Math.round(df * 10) / 10, pValue: Math.round(pValue * 1000) / 1000, significant, confidence };
}

/**
 * Compute robust stats for a metric array.
 * @param {number[]} raw
 */
function robustStats(raw) {
	const valid = raw.filter(v => v >= 0);
	if (valid.length === 0) { return null; }
	const cleaned = removeOutliers(valid);
	if (cleaned.length === 0) { return null; }
	const sorted = [...cleaned].sort((a, b) => a - b);
	const med = median(sorted);
	const p95 = sorted[Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)];
	const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
	const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / sorted.length;
	const stddev = Math.sqrt(variance);
	const cv = mean > 0 ? stddev / mean : 0;
	return {
		median: Math.round(med * 100) / 100,
		p95: Math.round(p95 * 100) / 100,
		min: sorted[0],
		max: sorted[sorted.length - 1],
		mean: Math.round(mean * 100) / 100,
		stddev: Math.round(stddev * 100) / 100,
		cv: Math.round(cv * 1000) / 1000,
		n: sorted.length,
		nOutliers: valid.length - cleaned.length,
	};
}

/**
 * Simple linear regression slope (y per unit x).
 * @param {number[]} values
 */
function linearRegressionSlope(values) {
	const n = values.length;
	if (n < 2) { return 0; }
	let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
	for (let i = 0; i < n; i++) {
		sumX += i;
		sumY += values[i];
		sumXY += i * values[i];
		sumX2 += i * i;
	}
	return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
}

/**
 * Format a single metric line for console output.
 * @param {number[]} values
 * @param {string} label
 * @param {string} unit
 */
function summarize(values, label, unit) {
	const s = robustStats(values);
	if (!s) { return `  ${label}: (no data)`; }
	const cv = s.cv > 0.15 ? ` cv=${(s.cv * 100).toFixed(0)}%⚠` : ` cv=${(s.cv * 100).toFixed(0)}%`;
	const outliers = s.nOutliers > 0 ? ` (${s.nOutliers} outlier${s.nOutliers > 1 ? 's' : ''} removed)` : '';
	return `  ${label}: median=${s.median}${unit}, p95=${s.p95}${unit},${cv}${outliers} [n=${s.n}]`;
}

/**
 * Compute duration between two chat perf marks.
 * @param {Array<{name: string, startTime: number}>} marks
 * @param {string} from
 * @param {string} to
 */
function markDuration(marks, from, to) {
	const fromMark = marks.find(m => m.name.endsWith('/' + from));
	const toMark = marks.find(m => m.name.endsWith('/' + to));
	if (fromMark && toMark) {
		return toMark.startTime - fromMark.startTime;
	}
	return -1;
}

/** @type {Array<[string, string, string]>} */
const METRIC_DEFS = [
	['timeToFirstToken', 'timing', 'ms'],
	['timeToComplete', 'timing', 'ms'],
	['timeToUIUpdated', 'timing', 'ms'],
	['instructionCollectionTime', 'timing', 'ms'],
	['agentInvokeTime', 'timing', 'ms'],
	['heapDelta', 'memory', 'MB'],
	['gcDurationMs', 'memory', 'ms'],
	['layoutCount', 'rendering', ''],
	['recalcStyleCount', 'rendering', ''],
	['forcedReflowCount', 'rendering', ''],
	['longTaskCount', 'rendering', ''],
];

module.exports = {
	ROOT,
	DATA_DIR,
	SCENARIOS,
	METRIC_DEFS,
	getElectronPath,
	isVersionString,
	resolveBuild,
	preseedStorage,
	buildEnv,
	buildArgs,
	writeSettings,
	prepareRunDir,
	median,
	removeOutliers,
	robustStats,
	welchTTest,
	linearRegressionSlope,
	summarize,
	markDuration,
	launchVSCode,
};
