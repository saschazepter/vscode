/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { homedir } from 'os';
import * as nls from '../../../nls.js';
import { disposableTimeout } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { OS } from '../../../base/common/platform.js';
import { URI, isUriComponents } from '../../../base/common/uri.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { getEffectiveCommandSource, resolveEffectiveCommand } from '../../contrib/chat/common/promptSyntax/hookSchema.js';
import { IHookCommandDto } from '../common/extHost.protocol.js';
import { IExtHostHooks } from '../common/extHostHooks.js';
import { HookCommandResultKind, IHookCommandResult } from '../../contrib/chat/common/hooks/hooksCommandTypes.js';

const SIGKILL_DELAY_MS = 5000;

export class NodeExtHostHooks implements IExtHostHooks {

	constructor(
		@ILogService private readonly _logService: ILogService
	) { }

	async $runHookCommand(hookCommand: IHookCommandDto, input: unknown, token: CancellationToken): Promise<IHookCommandResult> {
		this._logService.debug(`[ExtHostHooks] Running hook command: ${JSON.stringify(hookCommand)}`);

		try {
			return await this._executeCommand(hookCommand, input, token);
		} catch (err) {
			return {
				kind: HookCommandResultKind.Error,
				result: err instanceof Error ? err.message : String(err)
			};
		}
	}

	private _executeCommand(hook: IHookCommandDto, input: unknown, token?: CancellationToken): Promise<IHookCommandResult> {
		const home = homedir();
		const cwdUri = hook.cwd ? URI.revive(hook.cwd) : undefined;
		const cwd = cwdUri ? cwdUri.fsPath : home;

		// Resolve the effective command for the current platform
		const effectiveCommand = resolveEffectiveCommand(hook as Parameters<typeof resolveEffectiveCommand>[0], OS);
		if (!effectiveCommand) {
			return Promise.resolve({
				kind: HookCommandResultKind.NonBlockingError,
				result: nls.localize('noCommandForPlatform', "No command specified for the current platform")
			});
		}

		// Execute the command using the appropriate shell
		const commandSource = getEffectiveCommandSource(hook as Parameters<typeof getEffectiveCommandSource>[0], OS);
		let shellExecutable: string | undefined;
		let shellArgs: string[] | undefined;

		if (commandSource === 'powershell') {
			shellExecutable = 'powershell.exe';
			shellArgs = ['-Command', effectiveCommand];
		} else if (commandSource === 'bash') {
			shellExecutable = 'bash';
			shellArgs = ['-c', effectiveCommand];
		}

		const child = shellExecutable && shellArgs
			? spawn(shellExecutable, shellArgs, {
				stdio: 'pipe',
				cwd,
				env: { ...process.env, ...hook.env },
			})
			: spawn(effectiveCommand, [], {
				stdio: 'pipe',
				cwd,
				env: { ...process.env, ...hook.env },
				shell: true,
			});

		return new Promise((resolve, reject) => {
			const stdout: string[] = [];
			const stderr: string[] = [];
			let exitCode: number | null = null;
			let exited = false;

			const disposables = new DisposableStore();
			const sigkillTimeout = disposables.add(new MutableDisposable());

			const killWithEscalation = () => {
				if (exited) {
					return;
				}
				child.kill('SIGTERM');
				sigkillTimeout.value = disposableTimeout(() => {
					if (!exited) {
						child.kill('SIGKILL');
					}
				}, SIGKILL_DELAY_MS);
			};

			const cleanup = () => {
				exited = true;
				disposables.dispose();
			};

			child.stdout.on('data', data => stdout.push(data.toString()));
			child.stderr.on('data', data => stderr.push(data.toString()));

			disposables.add(disposableTimeout(killWithEscalation, (hook.timeoutSec ?? 30) * 1000));

			if (token) {
				disposables.add(token.onCancellationRequested(killWithEscalation));
			}

			if (input !== undefined && input !== null) {
				try {
					child.stdin.write(JSON.stringify(input, (_key, value) => {
						if (isUriComponents(value)) {
							return URI.revive(value).fsPath;
						}
						return value;
					}));
				} catch {
					// Ignore stdin write errors
				}
			}
			child.stdin.end();

			child.on('exit', code => { exitCode = code; });

			child.on('close', () => {
				cleanup();
				const code = exitCode ?? 1;
				const stdoutStr = stdout.join('');
				const stderrStr = stderr.join('');

				if (code === 0) {
					let result: string | object = stdoutStr;
					try {
						result = JSON.parse(stdoutStr);
					} catch {
						// Keep as string if not valid JSON
					}
					resolve({ kind: HookCommandResultKind.Success, result });
				} else if (code === 2) {
					resolve({ kind: HookCommandResultKind.Error, result: stderrStr });
				} else {
					resolve({ kind: HookCommandResultKind.NonBlockingError, result: stderrStr });
				}
			});

			child.on('error', err => {
				cleanup();
				reject(err);
			});
		});
	}
}
