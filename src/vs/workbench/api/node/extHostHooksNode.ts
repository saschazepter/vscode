/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { homedir } from 'os';
import * as path from '../../../base/common/path.js';
import { untildify } from '../../../base/common/labels.js';
import { ChatHookType, IChatHookExecutionOptions, IChatHookResult, IExtHostHooks } from '../common/extHostHooks.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { isToolInvocationContext, IToolInvocationContext } from '../../contrib/chat/common/tools/languageModelToolsService.js';
import { IHookCommand, IChatRequestHooks } from '../../contrib/chat/common/promptSyntax/hookSchema.js';
import { ExtHostChatAgents2 } from '../common/extHostChatAgents2.js';
import { DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { disposableTimeout } from '../../../base/common/async.js';

const SIGKILL_DELAY_MS = 5000;

export class NodeExtHostHooks implements IExtHostHooks {

	private _extHostChatAgents: ExtHostChatAgents2 | undefined;

	initialize(extHostChatAgents: ExtHostChatAgents2): void {
		this._extHostChatAgents = extHostChatAgents;
	}

	async executeHook(extension: IExtensionDescription, options: IChatHookExecutionOptions, token?: CancellationToken): Promise<IChatHookResult[]> {
		if (!this._extHostChatAgents) {
			throw new Error('ExtHostHooks not initialized');
		}

		if (!options.toolInvocationToken || !isToolInvocationContext(options.toolInvocationToken)) {
			throw new Error('Invalid or missing tool invocation token');
		}

		const context = options.toolInvocationToken as IToolInvocationContext;
		const hooks = this._extHostChatAgents.getHooksForSession(context.sessionResource);
		if (!hooks) {
			return [];
		}

		const hookCommands = this._getHooksForType(hooks, options.hookType);
		if (!hookCommands || hookCommands.length === 0) {
			return [];
		}

		const results: IChatHookResult[] = [];
		for (const hookCommand of hookCommands) {
			try {
				results.push(await this._executeCommand(hookCommand, options.input, token));
			} catch (err) {
				results.push({
					exitCode: -1,
					stdout: '',
					stderr: err instanceof Error ? err.message : String(err)
				});
			}
		}
		return results;
	}

	private _getHooksForType(hooks: IChatRequestHooks, hookType: ChatHookType): readonly IHookCommand[] | undefined {
		return hooks[hookType];
	}

	private _executeCommand(hook: IHookCommand, input: unknown, token?: CancellationToken): Promise<IChatHookResult> {
		const home = homedir();
		let cwd = hook.cwd ? untildify(hook.cwd, home) : home;
		if (!path.isAbsolute(cwd)) {
			cwd = path.join(home, cwd);
		}

		const child = spawn(hook.command, [], {
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
				resolve({
					stdout: stdout.join(''),
					stderr: stderr.join(''),
					exitCode: exitCode ?? 1,
				});
			});

			child.on('error', err => {
				cleanup();
				reject(err);
			});
		});
	}
}
