/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import type { IServerHandle } from './testHelpers.js';

/**
 * Starts the agent host server with the real CopilotAgent registered.
 *
 * Unlike {@link startServer} in testHelpers.ts, this does NOT pass
 * `--enable-mock-agent` or `--quiet`, so the server boots the real
 * CopilotAgent backed by the Copilot SDK.
 */
export function startCopilotServer(): Promise<IServerHandle> {
	return new Promise((resolve, reject) => {
		const serverPath = fileURLToPath(new URL('../../../node/agentHostServerMain.js', import.meta.url));
		const args = ['--port', '0', '--without-connection-token'];
		const child = fork(serverPath, args, {
			stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
		});

		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`Copilot server startup timed out.\nstderr: ${stderrBuf}`));
		}, 30_000);

		let stdoutBuf = '';
		let stderrBuf = '';

		child.stdout!.on('data', (data: Buffer) => {
			stdoutBuf += data.toString();
			const match = stdoutBuf.match(/READY:(\d+)/);
			if (match) {
				clearTimeout(timer);
				resolve({ process: child, port: parseInt(match[1], 10) });
			}
		});

		child.stderr!.on('data', (data: Buffer) => {
			stderrBuf += data.toString();
		});

		child.on('error', err => {
			clearTimeout(timer);
			reject(err);
		});

		child.on('exit', code => {
			clearTimeout(timer);
			reject(new Error(`Copilot server exited prematurely with code ${code}.\nstderr: ${stderrBuf}`));
		});
	});
}
