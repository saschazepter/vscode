/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, RunOnceScheduler } from '../../../../../../base/common/async.js';
import type { CancellationToken } from '../../../../../../base/common/cancellation.js';
import type { Event } from '../../../../../../base/common/event.js';
import { DisposableStore, type IDisposable } from '../../../../../../base/common/lifecycle.js';
import type { ITerminalInstance } from '../../../../terminal/browser/terminal.js';
import type { IMarker as IXtermMarker } from '@xterm/xterm';

export interface ITerminalExecuteStrategy extends IDisposable {
	readonly type: 'rich' | 'basic' | 'none';
	/**
	 * Executes a command line and gets a result designed to be passed directly to an LLM. The
	 * result will include information about the exit code.
	 * @param commandLine The command line to execute
	 * @param token Cancellation token
	 * @param commandId Optional predefined command ID to link the command
	 * @param commandLineForMetadata Optional command line to report in terminal execution metadata.
	 * This can differ from the command line that is sent to the shell, for example when the command
	 * is wrapped for sandbox execution.
	 */
	execute(commandLine: string, token: CancellationToken, commandId?: string, commandLineForMetadata?: string): Promise<ITerminalExecuteStrategyResult>;

	readonly onDidCreateStartMarker: Event<IXtermMarker | undefined>;
}

export interface ITerminalExecuteStrategyResult {
	output: string | undefined;
	additionalInformation?: string;
	exitCode?: number;
	error?: string;
	didEnterAltBuffer?: boolean;
}

export async function waitForIdle(onData: Event<unknown>, idleDurationMs: number): Promise<void> {
	// This is basically Event.debounce but with an initial event to trigger the debounce
	// immediately
	const store = new DisposableStore();
	const deferred = new DeferredPromise<void>();
	const scheduler = store.add(new RunOnceScheduler(() => deferred.complete(), idleDurationMs));
	store.add(onData(() => scheduler.schedule()));
	scheduler.schedule();
	return deferred.p.finally(() => store.dispose());
}

export interface IPromptDetectionResult {
	/**
	 * Whether a prompt was detected.
	 */
	detected: boolean;
	/**
	 * The reason for logging.
	 */
	reason?: string;
}

/**
 * Detects if the given text content appears to end with a common prompt pattern.
 */
export function detectsCommonPromptPattern(cursorLine: string): IPromptDetectionResult {
	if (cursorLine.trim().length === 0) {
		return { detected: false, reason: 'Content is empty or contains only whitespace' };
	}

	// PowerShell prompt: PS C:\> or similar patterns
	if (/PS\s+[A-Z]:\\.*>\s*$/.test(cursorLine)) {
		return { detected: true, reason: `PowerShell prompt pattern detected: "${cursorLine}"` };
	}

	// Command Prompt: C:\path>
	if (/^[A-Z]:\\.*>\s*$/.test(cursorLine)) {
		return { detected: true, reason: `Command Prompt pattern detected: "${cursorLine}"` };
	}

	// Bash-style prompts ending with $
	if (/\$\s*$/.test(cursorLine)) {
		return { detected: true, reason: `Bash-style prompt pattern detected: "${cursorLine}"` };
	}

	// Root prompts ending with #
	if (/#\s*$/.test(cursorLine)) {
		return { detected: true, reason: `Root prompt pattern detected: "${cursorLine}"` };
	}

	// Python REPL prompt
	if (/^>>>\s*$/.test(cursorLine)) {
		return { detected: true, reason: `Python REPL prompt pattern detected: "${cursorLine}"` };
	}

	// Custom prompts ending with the starship character (\u276f)
	if (/\u276f\s*$/.test(cursorLine)) {
		return { detected: true, reason: `Starship prompt pattern detected: "${cursorLine}"` };
	}

	// Generic prompts ending with common prompt characters
	if (/[>%]\s*$/.test(cursorLine)) {
		return { detected: true, reason: `Generic prompt pattern detected: "${cursorLine}"` };
	}

	return { detected: false, reason: `No common prompt pattern found in last line: "${cursorLine}"` };
}

/**
 * Enhanced version of {@link waitForIdle} that uses prompt detection heuristics. After the terminal
 * idles for the specified period, checks if the terminal's cursor line looks like a common prompt.
 * If not, extends the timeout to give the command more time to complete.
 */
export async function waitForIdleWithPromptHeuristics(
	onData: Event<unknown>,
	instance: ITerminalInstance,
	idlePollIntervalMs: number,
	extendedTimeoutMs: number,
): Promise<IPromptDetectionResult> {
	await waitForIdle(onData, idlePollIntervalMs);

	const xterm = await instance.xtermReadyPromise;
	if (!xterm) {
		return { detected: false, reason: `Xterm not available, using ${idlePollIntervalMs}ms timeout` };
	}
	const startTime = Date.now();

	// Attempt to detect a prompt pattern after idle
	while (Date.now() - startTime < extendedTimeoutMs) {
		try {
			let content = '';
			const buffer = xterm.raw.buffer.active;
			const line = buffer.getLine(buffer.baseY + buffer.cursorY);
			if (line) {
				content = line.translateToString(true);
			}
			const promptResult = detectsCommonPromptPattern(content);
			if (promptResult.detected) {
				return promptResult;
			}
		} catch (error) {
			// Continue polling even if there's an error reading terminal content
		}
		await waitForIdle(onData, Math.min(idlePollIntervalMs, extendedTimeoutMs - (Date.now() - startTime)));
	}

	// Extended timeout reached without detecting a prompt
	try {
		let content = '';
		const buffer = xterm.raw.buffer.active;
		const line = buffer.getLine(buffer.baseY + buffer.cursorY);
		if (line) {
			content = line.translateToString(true) + '\n';
		}
		return { detected: false, reason: `Extended timeout reached without prompt detection. Last line: "${content.trim()}"` };
	} catch (error) {
		return { detected: false, reason: `Extended timeout reached. Error reading terminal content: ${error}` };
	}
}

/**
 * Tracks the terminal for being idle on a prompt input. This must be called before `executeCommand`
 * is called.
 */
export async function trackIdleOnPrompt(
	instance: ITerminalInstance,
	idleDurationMs: number,
	store: DisposableStore,
	promptFallbackMs?: number,
): Promise<void> {
	const idleOnPrompt = new DeferredPromise<void>();
	const onData = instance.onData;
	const scheduler = store.add(new RunOnceScheduler(() => {
		idleOnPrompt.complete();
	}, idleDurationMs));
	let state: TerminalState = TerminalState.Initial;

	// Fallback in case prompt sequences are not seen but the terminal goes idle.
	const promptFallbackScheduler = store.add(new RunOnceScheduler(() => {
		if (state === TerminalState.Executing || state === TerminalState.PromptAfterExecuting) {
			promptFallbackScheduler.cancel();
			return;
		}
		state = TerminalState.PromptAfterExecuting;
		scheduler.schedule();
	}, promptFallbackMs ?? 1000));
	// Schedule an initial fallback with a longer timeout so we can detect idle
	// even when no terminal data events arrive at all (e.g. shell integration
	// is broken and the command finishes silently or hangs waiting for input).
	// Without this, if no data events fire, neither scheduler is ever triggered
	// and trackIdleOnPrompt blocks forever. We use a longer initial delay (10s)
	// to avoid falsely reporting completion for commands that are slow to start
	// producing output. Once any data arrives, the onData handler takes over
	// with the shorter promptFallbackMs interval.
	const initialFallbackScheduler = store.add(new RunOnceScheduler(() => {
		if (state === TerminalState.Executing || state === TerminalState.PromptAfterExecuting) {
			return;
		}
		state = TerminalState.PromptAfterExecuting;
		scheduler.schedule();
	}, 10_000));
	initialFallbackScheduler.schedule();
	// Fallback for when shell integration breaks mid-command: data arrives and
	// C/D sequences transition us to Executing, but no A (prompt) sequence ever
	// follows. Both initialFallbackScheduler and promptFallbackScheduler get
	// cancelled in that state, causing a permanent hang.
	//
	// Two complementary fallbacks handle this:
	// 1. executingIdleFallback: fires after 10s of data-idle in the Executing
	//    state. If the cursor line looks like a prompt, complete immediately.
	//    This handles the common case where the command finished but the prompt
	//    sequence was lost.
	// 2. executingHardCap: fires 30s after entering the Executing state,
	//    regardless of data activity. This is the ultimate safety net — if shell
	//    integration is broken, the terminal won't look like a prompt either,
	//    so the idle check alone would never complete.
	const executingIdleFallback = store.add(new RunOnceScheduler(async () => {
		if (state !== TerminalState.Executing) {
			return;
		}
		const xterm = await instance.xtermReadyPromise;
		if (xterm) {
			const buffer = xterm.raw.buffer.active;
			const line = buffer.getLine(buffer.baseY + buffer.cursorY);
			if (line) {
				const content = line.translateToString(true);
				if (detectsCommonPromptPattern(content).detected) {
					state = TerminalState.PromptAfterExecuting;
					scheduler.schedule();
					return;
				}
			}
		}
		// Doesn't look like a prompt — let the hard cap handle it
	}, 10_000));
	const executingHardCap = store.add(new RunOnceScheduler(() => {
		if (state === TerminalState.Executing) {
			state = TerminalState.PromptAfterExecuting;
			scheduler.schedule();
		}
	}, 30_000));
	// Only schedule when a prompt sequence (A) is seen after an execute sequence (C). This prevents
	// cases where the command is executed before the prompt is written. While not perfect, sitting
	// on an A without a C following shortly after is a very good indicator that the command is done
	// and the terminal is idle. Note that D is treated as a signal for executed since shell
	// integration sometimes lacks the C sequence either due to limitations in the integation or the
	// required hooks aren't available.
	const enum TerminalState {
		Initial,
		Prompt,
		Executing,
		PromptAfterExecuting,
	}
	store.add(onData(e => {
		// Once any data arrives, cancel the initial fallback — the data-driven
		// promptFallbackScheduler handles rescheduling from here.
		initialFallbackScheduler.cancel();
		// Update state
		// p10k fires C as `133;C;`
		const matches = e.matchAll(/(?:\x1b\]|\x9d)[16]33;(?<type>[ACD])(?:;.*)?(?:\x1b\\|\x07|\x9c)/g);
		for (const match of matches) {
			if (match.groups?.type === 'A') {
				if (state === TerminalState.Initial) {
					state = TerminalState.Prompt;
				} else if (state === TerminalState.Executing) {
					state = TerminalState.PromptAfterExecuting;
					executingIdleFallback.cancel();
					executingHardCap.cancel();
				}
			} else if (match.groups?.type === 'C' || match.groups?.type === 'D') {
				state = TerminalState.Executing;
				// Start both executing fallbacks — the idle fallback checks for
				// a prompt after 10s of no data, and the hard cap ensures we
				// never hang longer than 30s even if no prompt is detected.
				executingIdleFallback.schedule();
				executingHardCap.schedule();
			}
		}
		// Re-schedule on every data event as we're tracking data idle
		if (state === TerminalState.PromptAfterExecuting) {
			promptFallbackScheduler.cancel();
			executingIdleFallback.cancel();
			executingHardCap.cancel();
			scheduler.schedule();
		} else {
			scheduler.cancel();
			if (state === TerminalState.Initial || state === TerminalState.Prompt) {
				promptFallbackScheduler.schedule();
			} else {
				promptFallbackScheduler.cancel();
				// Re-schedule the idle fallback on every data event so it only
				// fires after 10s of data-idle. The hard cap is NOT rescheduled
				// — it's an absolute 30s limit from the first C/D sequence.
				executingIdleFallback.schedule();
			}
		}
	}));
	return idleOnPrompt.p;
}
