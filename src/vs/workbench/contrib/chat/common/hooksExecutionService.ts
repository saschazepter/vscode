/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { HookType, HookTypeValue, IChatRequestHooks, IHookCommand } from './promptSyntax/hookSchema.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { StopWatch } from '../../../../base/common/stopwatch.js';
import { Extensions, IOutputChannelRegistry, IOutputService } from '../../../services/output/common/output.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { localize } from '../../../../nls.js';
import { vEnum, vObj, vOptionalProp, vString } from '../../../../base/common/validation.js';

export const hooksOutputChannelId = 'hooksExecution';
const hooksOutputChannelLabel = localize('hooksExecutionChannel', "Hooks");

//#region Hook Input Types

/**
 * Common properties added to all hook inputs by the execution service.
 * These are built internally when executing hooks - callers don't provide them.
 */
export interface ICommonHookInput {
	readonly timestamp: string;
	readonly cwd: string;
	readonly sessionId: string;
	readonly hookEventName: string;
}

//#endregion

//#region PreToolUse Hook Types

/**
 * Input provided by the caller when invoking the preToolUse hook.
 * This is the minimal set of data that the tool service knows about.
 */
export interface IPreToolUseCallerInput {
	readonly toolName: string;
	readonly toolArgs: unknown;
}

/**
 * Full input passed to the preToolUse hook.
 * Combines the caller input with common hook properties.
 */
export interface IPreToolUseHookInput extends ICommonHookInput {
	readonly toolName: string;
	readonly toolArgs: unknown;
}

/**
 * Valid permission decisions for preToolUse hooks.
 */
export type PreToolUsePermissionDecision = 'allow' | 'deny';

/**
 * Output from the preToolUse hook.
 */
export interface IPreToolUseHookOutput {
	readonly permissionDecision: PreToolUsePermissionDecision;
	readonly permissionDecisionReason?: string;
}

const preToolUseOutputValidator = vObj({
	permissionDecision: vEnum('allow', 'deny'),
	permissionDecisionReason: vOptionalProp(vString()),
});

//#endregion

//#region Stop Hook Types

/**
 * Input provided by the caller when invoking the stop hook.
 */
export interface IStopHookCallerInput {
	/**
	 * True when agent is already continuing as a result of a stop hook to prevent infinite loops.
	 */
	readonly stop_hook_active: boolean;
}

/**
 * Full input passed to the stop hook.
 * Combines the caller input with common hook properties.
 */
export interface IStopHookInput extends ICommonHookInput {
	readonly stop_hook_active: boolean;
}

/**
 * Valid decisions for stop hooks.
 * "block" prevents the agent from stopping.
 */
export type StopHookDecision = 'block';

/**
 * Output from the stop hook.
 */
export interface IStopHookOutput {
	/**
	 * "block" prevents the agent from stopping. Omit to allow the agent to stop.
	 */
	readonly decision: StopHookDecision;
	/**
	 * Required when decision is "block". Tells the agent why it should continue.
	 */
	readonly reason: string;
}

const stopHookOutputValidator = vObj({
	decision: vEnum('block'),
	reason: vString(),
});

//#endregion

export const enum HookResultKind {
	Success = 1,
	Error = 2
}

export interface IHookResult {
	readonly kind: HookResultKind;
	readonly result: string | object;
}

export interface IHooksExecutionOptions {
	readonly input?: unknown;
	readonly token?: CancellationToken;
}

/**
 * Callback interface for hook execution proxies.
 * MainThreadHooks implements this to forward calls to the extension host.
 */
export interface IHooksExecutionProxy {
	runHookCommand(hookCommand: IHookCommand, input: unknown, token: CancellationToken): Promise<IHookResult>;
}

export const IHooksExecutionService = createDecorator<IHooksExecutionService>('hooksExecutionService');

export interface IHooksExecutionService {
	_serviceBrand: undefined;

	/**
	 * Called by mainThreadHooks when extension host is ready
	 */
	setProxy(proxy: IHooksExecutionProxy): void;

	/**
	 * Register hooks for a session. Returns a disposable that unregisters them.
	 */
	registerHooks(sessionResource: URI, hooks: IChatRequestHooks): IDisposable;

	/**
	 * Get hooks registered for a session.
	 */
	getHooksForSession(sessionResource: URI): IChatRequestHooks | undefined;

	/**
	 * Execute hooks of the given type for the given session
	 */
	executeHook(hookType: HookTypeValue, sessionResource: URI, options?: IHooksExecutionOptions): Promise<IHookResult[]>;

	/**
	 * Execute preToolUse hooks with typed input and validated output.
	 * The execution service builds the full hook input from the caller input plus session context.
	 * Output is optional, but if provided, it must conform to the expected schema.
	 */
	executePreToolUseHook(sessionResource: URI, input: IPreToolUseCallerInput, token?: CancellationToken): Promise<IPreToolUseHookOutput | undefined>;

	/**
	 * Execute stop hooks with typed input and validated output.
	 * The execution service builds the full hook input from the caller input plus session context.
	 * Returns the hook output if any hook returns decision "block", otherwise undefined.
	 */
	executeStopHook(sessionResource: URI, input: IStopHookCallerInput, token?: CancellationToken): Promise<IStopHookOutput | undefined>;
}

export class HooksExecutionService implements IHooksExecutionService {
	declare readonly _serviceBrand: undefined;

	private _proxy: IHooksExecutionProxy | undefined;
	private readonly _sessionHooks = new Map<string, IChatRequestHooks>();
	private _channelRegistered = false;
	private _requestCounter = 0;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IOutputService private readonly _outputService: IOutputService,
	) { }

	setProxy(proxy: IHooksExecutionProxy): void {
		this._proxy = proxy;
	}

	private _ensureOutputChannel(): void {
		if (this._channelRegistered) {
			return;
		}
		Registry.as<IOutputChannelRegistry>(Extensions.OutputChannels).registerChannel({
			id: hooksOutputChannelId,
			label: hooksOutputChannelLabel,
			log: false
		});
		this._channelRegistered = true;
	}

	private _log(requestId: number, hookType: HookTypeValue, message: string): void {
		this._ensureOutputChannel();
		const channel = this._outputService.getChannel(hooksOutputChannelId);
		if (channel) {
			channel.append(`${new Date().toISOString()} [#${requestId}] [${hookType}] ${message}\n`);
		}
	}

	private async _runSingleHook(
		requestId: number,
		hookType: HookTypeValue,
		hookCommand: IHookCommand,
		sessionResource: URI,
		callerInput: unknown,
		token: CancellationToken
	): Promise<IHookResult> {
		// Build the common hook input properties
		const commonInput: ICommonHookInput = {
			timestamp: new Date().toISOString(),
			cwd: hookCommand.cwd?.fsPath ?? '',
			sessionId: sessionResource.toString(),
			hookEventName: hookType,
		};

		// Merge common properties with caller-specific input
		const fullInput = callerInput !== undefined && callerInput !== null && typeof callerInput === 'object'
			? { ...commonInput, ...callerInput }
			: commonInput;

		const hookCommandJson = JSON.stringify({
			...hookCommand,
			cwd: hookCommand.cwd?.fsPath
		});
		this._log(requestId, hookType, `Running: ${hookCommandJson}`);
		// Log input with toolArgs truncated to avoid excessively long logs
		const inputForLog = { ...fullInput as object, toolArgs: '...' };
		this._log(requestId, hookType, `Input: ${JSON.stringify(inputForLog)}`);

		const sw = StopWatch.create();
		try {
			const result = await this._proxy!.runHookCommand(hookCommand, fullInput, token);
			this._logResult(requestId, hookType, result, Math.round(sw.elapsed()));
			return result;
		} catch (err) {
			const errMessage = err instanceof Error ? err.message : String(err);
			this._log(requestId, hookType, `Error in ${Math.round(sw.elapsed())}ms: ${errMessage}`);
			return { kind: HookResultKind.Error, result: errMessage };
		}
	}

	private _logResult(requestId: number, hookType: HookTypeValue, result: IHookResult, elapsed: number): void {
		const resultKindStr = result.kind === HookResultKind.Success ? 'Success' : 'Error';
		const resultStr = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
		const hasOutput = resultStr.length > 0 && resultStr !== '{}' && resultStr !== '[]';
		if (hasOutput) {
			this._log(requestId, hookType, `Completed (${resultKindStr}) in ${elapsed}ms`);
			this._log(requestId, hookType, `Output: ${resultStr}`);
		} else {
			this._log(requestId, hookType, `Completed (${resultKindStr}) in ${elapsed}ms, no output`);
		}
	}

	registerHooks(sessionResource: URI, hooks: IChatRequestHooks): IDisposable {
		const key = sessionResource.toString();
		this._sessionHooks.set(key, hooks);
		return toDisposable(() => {
			this._sessionHooks.delete(key);
		});
	}

	getHooksForSession(sessionResource: URI): IChatRequestHooks | undefined {
		return this._sessionHooks.get(sessionResource.toString());
	}

	async executeHook(hookType: HookTypeValue, sessionResource: URI, options?: IHooksExecutionOptions): Promise<IHookResult[]> {
		if (!this._proxy) {
			return [];
		}

		const hooks = this.getHooksForSession(sessionResource);
		if (!hooks) {
			return [];
		}

		const hookCommands = hooks[hookType];
		if (!hookCommands || hookCommands.length === 0) {
			return [];
		}

		const requestId = this._requestCounter++;
		const token = options?.token ?? CancellationToken.None;

		this._logService.debug(`[HooksExecutionService] Executing ${hookCommands.length} hook(s) for type '${hookType}'`);
		this._log(requestId, hookType, `Executing ${hookCommands.length} hook(s)`);

		const results: IHookResult[] = [];
		for (const hookCommand of hookCommands) {
			const result = await this._runSingleHook(requestId, hookType, hookCommand, sessionResource, options?.input, token);
			results.push(result);
		}

		return results;
	}

	async executePreToolUseHook(sessionResource: URI, input: IPreToolUseCallerInput, token?: CancellationToken): Promise<IPreToolUseHookOutput | undefined> {
		// Pass the caller input directly - common properties are added in _runSingleHook
		const results = await this.executeHook(HookType.PreToolUse, sessionResource, {
			input,
			token: token ?? CancellationToken.None,
		});

		// Collect all valid outputs - "any deny wins" for security
		let lastAllowOutput: IPreToolUseHookOutput | undefined;
		for (const result of results) {
			if (result.kind === HookResultKind.Success && typeof result.result === 'object') {
				const validationResult = preToolUseOutputValidator.validate(result.result);
				if (!validationResult.error) {
					const output = validationResult.content;
					// If any hook denies, return immediately with that denial
					if (output.permissionDecision === 'deny') {
						return output;
					}
					// Track the last allow in case we need to return it
					if (output.permissionDecision === 'allow') {
						lastAllowOutput = output;
					}
				} else {
					// If validation fails, log a warning and continue to next result
					this._logService.warn(`[HooksExecutionService] preToolUse hook output validation failed: ${validationResult.error.message}`);
				}
			}
		}

		// Return the last allow output, or undefined if no valid outputs
		return lastAllowOutput;
	}

	async executeStopHook(sessionResource: URI, input: IStopHookCallerInput, token?: CancellationToken): Promise<IStopHookOutput | undefined> {
		// Pass the caller input directly - common properties are added in _runSingleHook
		const results = await this.executeHook(HookType.Stop, sessionResource, {
			input,
			token: token ?? CancellationToken.None,
		});

		// Check all results - if any hook blocks, return that decision
		for (const result of results) {
			if (result.kind === HookResultKind.Success && typeof result.result === 'object') {
				const validationResult = stopHookOutputValidator.validate(result.result);
				if (!validationResult.error) {
					const output = validationResult.content;
					// If any hook blocks, return immediately with that block decision
					if (output.decision === 'block') {
						return output;
					}
				} else {
					// If validation fails, log a warning and continue to next result
					this._logService.warn(`[HooksExecutionService] stop hook output validation failed: ${validationResult.error.message}`);
				}
			}
		}

		// No valid block decisions, return undefined to allow stopping
		return undefined;
	}
}
