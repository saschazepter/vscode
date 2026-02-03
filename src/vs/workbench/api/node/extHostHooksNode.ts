/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { homedir } from 'os';
import { disposableTimeout } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { HookTypeValue, IChatRequestHooks, IHookCommand } from '../../contrib/chat/common/promptSyntax/hookSchema.js';
import { isToolInvocationContext, IToolInvocationContext } from '../../contrib/chat/common/tools/languageModelToolsService.js';
import { IHookResultDto } from '../common/extHost.protocol.js';
import { ExtHostChatAgents2 } from '../common/extHostChatAgents2.js';
import { IChatHookExecutionOptions, IExtHostHooks } from '../common/extHostHooks.js';
import { HookResultKind, IHookResult } from '../../contrib/chat/common/hooksExecutionService.js';

const SIGKILL_DELAY_MS = 5000;

export class NodeExtHostHooks implements IExtHostHooks {

	private _extHostChatAgents: ExtHostChatAgents2 | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService
	) { }

	initialize(extHostChatAgents: ExtHostChatAgents2): void {
		this._extHostChatAgents = extHostChatAgents;
	}

	async executeHook(hookType: HookTypeValue, options: IChatHookExecutionOptions, token?: CancellationToken): Promise<IHookResult[]> {
		if (!this._extHostChatAgents) {
			throw new Error('ExtHostHooks not initialized');
		}

		if (!options.toolInvocationToken || !isToolInvocationContext(options.toolInvocationToken)) {
			throw new Error('Invalid or missing tool invocation token');
		}

		const context = options.toolInvocationToken as IToolInvocationContext;
		return this._executeHooks(hookType, context.sessionResource, options.input, token);
	}

	async $executeHook(hookType: string, sessionResource: UriComponents, input: unknown): Promise<IHookResultDto[]> {
		if (!this._extHostChatAgents) {
			return [];
		}

		const uri = URI.revive(sessionResource);
		const results = await this._executeHooks(hookType as HookTypeValue, uri, input, undefined);
		return results.map(r => ({ kind: r.kind, result: r.result }));
	}

	private async _executeHooks(hookType: HookTypeValue, sessionResource: URI, input: unknown, token?: CancellationToken): Promise<IHookResult[]> {
		const hooks = this._extHostChatAgents!.getHooksForSession(sessionResource);
		if (!hooks) {
			return [];
		}

		const hookCommands = this._getHooksForType(hooks, hookType);
		if (!hookCommands || hookCommands.length === 0) {
			return [];
		}

		this._logService.debug(`[ExtHostHooks] Executing ${hookCommands.length} hook(s) for type '${hookType}'`);
		this._logService.trace(`[ExtHostHooks] Hook input:`, input);

		const results: IHookResult[] = [];
		for (const hookCommand of hookCommands) {
			try {
				this._logService.debug(`[ExtHostHooks] Running hook command: ${JSON.stringify(hookCommand)}`);
				const result = await this._executeCommand(hookCommand, input, token);
				this._logService.debug(`[ExtHostHooks] Hook completed with result kind: ${result.kind === HookResultKind.Success ? 'Success' : 'Error'}`);
				this._logService.trace(`[ExtHostHooks] Hook output:`, result.result);
				results.push(result);
			} catch (err) {
				this._logService.debug(`[ExtHostHooks] Hook failed with error: ${err instanceof Error ? err.message : String(err)}`);
				results.push({
					kind: HookResultKind.Error,
					result: err instanceof Error ? err.message : String(err)
				});
			}
		}
		return results;
	}

	private _getHooksForType(hooks: IChatRequestHooks, hookType: HookTypeValue): readonly IHookCommand[] | undefined {
		return hooks[hookType];
	}

	private _executeCommand(hook: IHookCommand, input: unknown, token?: CancellationToken): Promise<IHookResult> {
		const home = homedir();
		const cwd = hook.cwd ? hook.cwd.fsPath : home;

		// Determine shell and command based on which property is specified
		let shell: string | boolean = true;
		let commandStr: string;
		if (hook.bash) {
			shell = 'bash';
			commandStr = `-c ${JSON.stringify(hook.bash)}`;
		} else if (hook.powershell) {
			shell = 'powershell';
			commandStr = `-Command ${JSON.stringify(hook.powershell)}`;
		} else {
			commandStr = hook.command!;
		}

		const child = spawn(commandStr, [], {
			stdio: 'pipe',
			cwd,
			env: { ...process.env, ...hook.env },
			shell,
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

			// Collect output
			child.stdout.on('data', data => stdout.push(data.toString()));
			child.stderr.on('data', data => stderr.push(data.toString()));

			// Set up timeout (default 30 seconds)
			disposables.add(disposableTimeout(killWithEscalation, (hook.timeoutSec ?? 30) * 1000));

			// Set up cancellation
			if (token) {
				disposables.add(token.onCancellationRequested(killWithEscalation));
			}

			// Write input to stdin
			if (input !== undefined && input !== null) {
				try {
					child.stdin.write(JSON.stringify(input));
				} catch {
					// Ignore stdin write errors
				}
			}
			child.stdin.end();

			// Capture exit code
			child.on('exit', code => { exitCode = code; });

			// Resolve on close (after streams flush)
			child.on('close', () => {
				cleanup();
				const code = exitCode ?? 1;
				const stdoutStr = stdout.join('');
				const stderrStr = stderr.join('');

				if (code === 0) {
					// Success - try to parse stdout as JSON, otherwise return as string
					let result: string | object = stdoutStr;
					try {
						result = JSON.parse(stdoutStr);
					} catch {
						// Keep as string if not valid JSON
					}
					resolve({ kind: HookResultKind.Success, result });
				} else {
					// Error
					resolve({ kind: HookResultKind.Error, result: stderrStr });
				}
			});

			child.on('error', err => {
				cleanup();
				reject(err);
			});
		});
	}
}
