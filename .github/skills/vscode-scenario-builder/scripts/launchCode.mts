/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Launches Code OSS from sources with CDP enabled and connects Playwright over it.
 *
 * Used by scenarios under `scratchpad/<dated>/scenario.mts`. Designed for the
 * watch loop documented in SKILL.md:
 *
 *   - First launch:   --keep-open --port 9229
 *   - Replay:         --reuse --port 9229
 *   - Cold autonomous: (no flags)
 *
 * Returns Playwright handles + a `dispose` that closes the browser and, when
 * we own the Code process, terminates it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as timeout } from 'node:timers/promises';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core';
import { prepareUserDataProfile } from '../../auto-perf-optimize/scripts/userDataProfile.mts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const codeScript = process.platform === 'win32'
	? path.join(repoRoot, 'scripts', 'code.bat')
	: path.join(repoRoot, 'scripts', 'code.sh');

export interface LaunchOptions {
	/** Scenario name, used to build default output / user-data paths. */
	scenario: string;
	/** Output dir for screenshots and summary.json. */
	outputDir: string;
	/** Workspace folder Code should open. Required — must be a throwaway folder unless your scenario knows what it's doing. */
	workspace: string;
	/** CDP port. Choose something free; 9229 is a reasonable default. */
	port: number;
	/** Reuse an already-running Code window started with --keep-open at the same port. Skips launch. */
	reuse: boolean;
	/** Leave the Code window open after the scenario finishes. Pair with --reuse next time. */
	keepOpen: boolean;
	/** Use a fresh, disposable user-data-dir. Default reuses a per-scenario persistent profile so auth carries over. */
	temporaryUserData: boolean;
	/** Override the user-data-dir path. */
	userDataDir?: string;
	/** Seed the (empty) target user-data-dir from this profile before launch. */
	seedUserDataDir?: string;
	/** Override extension dir. Defaults to `<outputDir>/extensions`. */
	extensionDir?: string;
	/** Extra runtime args appended to the Code launch command. */
	runtimeArgs?: string[];
	/** Verbose: print Code stdout/stderr instead of capturing. */
	verbose?: boolean;
}

export interface LaunchedSession {
	browser: Browser;
	page: Page;
	cdp: CDPSession;
	port: number;
	outputDir: string;
	dispose: () => Promise<void>;
}

interface OwnedProcess {
	child: ChildProcess;
	failedBeforeConnect: Promise<Error>;
	markConnected(): void;
	terminate(signal: NodeJS.Signals): boolean;
}

export async function launchVSCode(options: LaunchOptions): Promise<LaunchedSession> {
	const outputDir = path.resolve(options.outputDir);
	const extensionDir = path.resolve(options.extensionDir ?? path.join(outputDir, 'extensions'));
	const persistentUserDataDir = path.join(repoRoot, '.build', 'scenario-builder', options.scenario, 'user-data');

	await mkdir(outputDir, { recursive: true });

	const { userDataDir, ownsUserDataDir } = await prepareUserDataProfile({
		outputDir,
		persistentUserDataDir,
		temporaryUserData: options.temporaryUserData,
		keepOpen: options.keepOpen,
		keepUserData: false,
		reuse: options.reuse,
		userDataDir: options.userDataDir,
		seedUserDataDir: options.seedUserDataDir,
	});

	if (!options.reuse && await isCDPAvailable(options.port)) {
		throw new Error(
			`Port ${options.port} already has a CDP endpoint. ` +
			`Stop that process, pick a different --port, or pass --reuse to attach to it.`,
		);
	}

	const ownsCode = !options.reuse;
	const owned: OwnedProcess | undefined = ownsCode
		? launchCodeProcess({
			port: options.port,
			workspace: options.workspace,
			userDataDir,
			extensionDir,
			runtimeArgs: options.runtimeArgs ?? [],
			keepOpen: options.keepOpen,
			verbose: options.verbose ?? false,
		})
		: undefined;

	let browser: Browser;
	try {
		browser = await connectWithRetry(options.port, owned?.failedBeforeConnect);
	} catch (err) {
		owned?.terminate('SIGTERM');
		throw err;
	}
	owned?.markConnected();

	const page = await findWorkbenchPage(browser);
	const cdp = await page.context().newCDPSession(page);
	await page.evaluate(() => (globalThis as unknown as { driver?: { whenWorkbenchRestored?: () => Promise<void> } }).driver?.whenWorkbenchRestored?.());

	const shouldCloseCode = ownsCode && !options.keepOpen;

	const dispose = async () => {
		await cdp.detach().catch(() => undefined);
		if (shouldCloseCode) {
			await browser.newBrowserCDPSession()
				.then(s => s.send('Browser.close'))
				.catch(() => undefined);
		}
		await browser.close().catch(() => undefined);
		if (owned && shouldCloseCode) {
			if (!await waitForChildExit(owned.child, 10000)) {
				owned.terminate('SIGTERM');
				await waitForChildExit(owned.child, 5000);
			}
		}
		if (ownsUserDataDir) {
			await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
		}
	};

	return { browser, page, cdp, port: options.port, outputDir, dispose };
}

function launchCodeProcess(args: {
	port: number;
	workspace: string;
	userDataDir: string;
	extensionDir: string;
	runtimeArgs: string[];
	keepOpen: boolean;
	verbose: boolean;
}): OwnedProcess {
	const argv = [
		'--enable-smoke-test-driver',
		'--disable-workspace-trust',
		`--remote-debugging-port=${args.port}`,
		`--user-data-dir=${args.userDataDir}`,
		`--extensions-dir=${args.extensionDir}`,
		'--skip-welcome',
		'--skip-release-notes',
		...args.runtimeArgs,
		args.workspace,
	];

	let failBeforeConnect: (err: Error) => void = () => undefined;
	let connected = false;
	let terminating = false;
	const failedBeforeConnect = new Promise<Error>(resolve => failBeforeConnect = resolve);

	// Strip ELECTRON_RUN_AS_NODE — when set (commonly inherited from VS Code's
	// integrated terminal or agent environments), Electron's binary launches as
	// a plain Node process and the workbench fails to start with cryptic ESM
	// import errors like `import { Menu } from 'electron'`.
	const childEnv = { ...process.env };
	delete childEnv.ELECTRON_RUN_AS_NODE;

	const child = spawn(codeScript, argv, {
		cwd: repoRoot,
		detached: args.keepOpen,
		shell: process.platform === 'win32',
		stdio: args.keepOpen ? 'ignore' : args.verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
		env: childEnv,
	});
	if (args.keepOpen) {
		child.unref();
	}

	if (!args.verbose && !args.keepOpen) {
		child.stdout?.on('data', data => process.stdout.write(`[code] ${data}`));
		child.stderr?.on('data', data => process.stderr.write(`[code] ${data}`));
	}

	child.once('error', err => failBeforeConnect(new Error(`Failed to launch Code: ${err.message}`)));
	child.once('exit', (code, signal) => {
		if (!connected && !terminating) {
			failBeforeConnect(new Error(`Code exited before CDP connect. code=${code} signal=${signal}`));
		}
	});

	return {
		child,
		failedBeforeConnect,
		markConnected: () => { connected = true; },
		terminate: signal => { terminating = true; return child.kill(signal); },
	};
}

async function connectWithRetry(port: number, failedBeforeConnect?: Promise<Error>): Promise<Browser> {
	const start = Date.now();
	const deadline = start + 60000;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			return await Promise.race([
				chromium.connectOverCDP(`http://127.0.0.1:${port}`),
				failedBeforeConnect ? failedBeforeConnect.then(e => { throw e; }) : new Promise<Browser>(() => undefined),
			]);
		} catch (err) {
			lastErr = err;
			await timeout(500);
		}
	}
	throw new Error(`Could not connect to CDP at 127.0.0.1:${port} within 60s: ${lastErr}`);
}

async function findWorkbenchPage(browser: Browser): Promise<Page> {
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline) {
		for (const ctx of browser.contexts()) {
			for (const page of ctx.pages()) {
				const url = page.url();
				if (url.startsWith('file://') && url.includes('workbench')) {
					return page;
				}
				if (url.includes('workbench.html')) {
					return page;
				}
			}
		}
		await timeout(250);
	}
	throw new Error('Could not find workbench page over CDP. Is --enable-smoke-test-driver set?');
}

async function isCDPAvailable(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1000 }, res => {
			res.resume();
			resolve(res.statusCode === 200);
		});
		req.on('error', () => resolve(false));
		req.on('timeout', () => { req.destroy(); resolve(false); });
	});
}

async function waitForChildExit(child: ChildProcess, ms: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return true;
	}
	return await Promise.race([
		new Promise<boolean>(resolve => child.once('exit', () => resolve(true))),
		timeout(ms).then(() => false),
	]);
}

/**
 * Parse the standard launch flags every scenario script accepts. Scenarios may layer
 * additional flags on top — this just gives a consistent baseline.
 */
export interface CommonArgs {
	port: number;
	reuse: boolean;
	keepOpen: boolean;
	temporaryUserData: boolean;
	verbose: boolean;
	userDataDir?: string;
	seedUserDataDir?: string;
	workspace?: string;
	output?: string;
	rest: string[];
}

export function parseCommonArgs(argv: string[]): CommonArgs {
	const out: CommonArgs = {
		port: 9229,
		reuse: false,
		keepOpen: false,
		temporaryUserData: false,
		verbose: false,
		rest: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		switch (a) {
			case '--port': out.port = Number(next()); break;
			case '--reuse': out.reuse = true; break;
			case '--keep-open': out.keepOpen = true; break;
			case '--temporary-user-data': out.temporaryUserData = true; break;
			case '--verbose': out.verbose = true; break;
			case '--user-data-dir': out.userDataDir = next(); break;
			case '--seed-user-data-dir': out.seedUserDataDir = next(); break;
			case '--workspace': out.workspace = next(); break;
			case '--output': out.output = next(); break;
			default: out.rest.push(a);
		}
	}
	return out;
}
