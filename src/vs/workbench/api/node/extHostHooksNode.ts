/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { homedir } from 'os';
import * as path from '../../../base/common/path.js';
import { untildify } from '../../../base/common/labels.js';
import { IChatHookExecutionOptions, IChatHookResult, IExtHostHooks } from '../common/extHostHooks.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { isToolInvocationContext, IToolInvocationContext } from '../../contrib/chat/common/tools/languageModelToolsService.js';
import { HookTypeId, IHookCommand, IChatRequestHooks } from '../../contrib/chat/common/promptSyntax/hookSchema.js';
import { ExtHostChatAgents2 } from '../common/extHostChatAgents2.js';

export class NodeExtHostHooks implements IExtHostHooks {

	private _extHostChatAgents: ExtHostChatAgents2 | undefined;

	initialize(extHostChatAgents: ExtHostChatAgents2): void {
		this._extHostChatAgents = extHostChatAgents;
	}

	async executeHook(extension: IExtensionDescription, options: IChatHookExecutionOptions, token?: CancellationToken): Promise<IChatHookResult[]> {
		if (!this._extHostChatAgents) {
			throw new Error('ExtHostHooks not initialized');
		}

		// Validate the toolInvocationToken
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

		// Execute all hooks of this type
		const results: IChatHookResult[] = [];
		for (const hookCommand of hookCommands) {
			try {
				const result = await this._executeCommand(hookCommand, options.input, token);
				results.push(result);
			} catch (err) {
				// Capture per-hook errors in results instead of rejecting the whole array
				results.push({
					exitCode: -1,
					stdout: '',
					stderr: err instanceof Error ? err.message : String(err)
				});
			}
		}
		return results;
	}

	private _getHooksForType(hooks: IChatRequestHooks, hookType: HookTypeId): readonly IHookCommand[] | undefined {
		return hooks[hookType];
	}

	private async _executeCommand(hook: IHookCommand, input: unknown, token?: CancellationToken): Promise<IChatHookResult> {
		return new Promise((resolve, reject) => {
			let child: ChildProcessWithoutNullStreams | undefined;
			let outputStdout = '';
			let outputStderr = '';
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			let sigkillHandle: ReturnType<typeof setTimeout> | undefined;
			let cancelRef: IDisposable | undefined;
			let exited = false;
			let exitCode: number | null = null;

			const setSigkillTimeout = () => {
				// Clear any existing SIGKILL timeout to prevent leaks
				if (sigkillHandle) {
					clearTimeout(sigkillHandle);
				}
				sigkillHandle = setTimeout(() => {
					if (!exited && child) {
						child.kill('SIGKILL');
					}
				}, 5000);
			};

			const cleanup = () => {
				exited = true;
				if (child && child.exitCode === null) {
					child.kill();
				}
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}
				if (sigkillHandle) {
					clearTimeout(sigkillHandle);
				}
				if (cancelRef) {
					cancelRef.dispose();
				}
			};

			try {
				const home = homedir();
				let cwd = hook.cwd ? untildify(hook.cwd, home) : home;
				if (!path.isAbsolute(cwd)) {
					cwd = path.join(home, cwd);
				}

				const env = { ...process.env, ...hook.env };

				child = spawn(hook.command, [], {
					stdio: 'pipe',
					cwd,
					env,
					shell: true,
				});

				// Set up stdout/stderr listeners
				if (child.stdout) {
					child.stdout.on('data', (data) => {
						outputStdout += data.toString();
					});
				}

				if (child.stderr) {
					child.stderr.on('data', (data) => {
						outputStderr += data.toString();
					});
				}

				// Set up timeout with default of 30 seconds
				const timeoutSec = hook.timeoutSec ?? 30;
				timeoutHandle = setTimeout(() => {
					if (!exited && child) {
						child.kill('SIGTERM');
						// If still not exited after 5 seconds, force kill
						setSigkillTimeout();
					}
				}, timeoutSec * 1000);

				// Set up cancellation with SIGKILL escalation
				if (token) {
					cancelRef = token.onCancellationRequested(() => {
						if (!exited && child) {
							child.kill('SIGTERM');
							// If still not exited after 5 seconds, force kill
							setSigkillTimeout();
						}
					});
				}

				// Send input via stdin if provided
				if (input !== undefined && input !== null && child.stdin) {
					try {
						child.stdin.write(JSON.stringify(input));
					} catch (e) {
						// Ignore errors writing to stdin
					}
					child.stdin.end();
				} else if (child.stdin) {
					child.stdin.end();
				}

				// Capture exit code from exit event
				child.on('exit', (code) => {
					exitCode = code;
				});

				// Resolve on close event to ensure streams are fully flushed
				child.on('close', () => {
					cleanup();
					resolve({
						stdout: outputStdout,
						stderr: outputStderr,
						exitCode: exitCode ?? 1,
					});
				});

				child.on('error', (err) => {
					cleanup();
					reject(err);
				});

			} catch (err) {
				cleanup();
				reject(err);
			}
		});
	}
}
