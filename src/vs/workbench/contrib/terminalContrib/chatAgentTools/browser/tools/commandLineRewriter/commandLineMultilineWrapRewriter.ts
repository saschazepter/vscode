/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../../../../../base/common/platform.js';
import { isFish, isPowerShell } from '../../runInTerminalHelpers.js';
import type { ICommandLineRewriter, ICommandLineRewriterOptions, ICommandLineRewriterResult } from './commandLineRewriter.js';

/**
 * Wraps multi-line POSIX commands in `<shell> -c '...'` so shell integration sees a single
 * command end marker instead of one per line.
 *
 * Without this, a command like:
 *   set -e
 *   apt-get update
 *   apt-get install -y foo
 * is pasted into the terminal as three separate commands. The execute strategy resolves on the
 * first `onCommandFinished` (after `set -e`) and returns to the agent before `apt-get` has even
 * started, leaving the remaining work running unattended and colliding with subsequent tool calls.
 *
 * Input detection via `OutputMonitor` is unaffected: interactive prompts (passwords, y/n, etc.)
 * emitted by the wrapped process still surface through the same regex-based detectors.
 */
export class CommandLineMultilineWrapRewriter extends Disposable implements ICommandLineRewriter {
	rewrite(options: ICommandLineRewriterOptions): ICommandLineRewriterResult | undefined {
		// Only applies to POSIX shells. PowerShell multi-line handling is different and
		// the background detach rewriter already wraps PowerShell separately.
		if (options.os === OperatingSystem.Windows || isPowerShell(options.shell, options.os)) {
			return undefined;
		}

		const command = options.commandLine;
		// Detect a "real" newline that separates top-level statements. We require a bare LF
		// that is NOT line-continuation (preceded by `\`). A single-line command with escaped
		// newlines continues to be a single command; we must not wrap it.
		if (!/(^|[^\\])\n\s*\S/.test(command)) {
			return undefined;
		}

		if (isFish(options.shell, options.os)) {
			// Fish does not support the POSIX `'\''` escape inside single-quoted strings.
			// Use double quotes and escape backslash and double-quote.
			const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
			return {
				rewritten: `${options.shell} -c "${escaped}"`,
				reasoning: 'Wrapped multi-line command with `fish -c` so shell integration sees a single command',
				forDisplay: command,
			};
		}

		// bash/zsh: escape single quotes using the standard `'\''` sequence so the entire
		// command can live inside a single-quoted `-c` argument without further interpretation.
		const escaped = command.replace(/'/g, `'\\''`);
		return {
			rewritten: `${options.shell} -c '${escaped}'`,
			reasoning: 'Wrapped multi-line command with `<shell> -c` so shell integration sees a single command',
			forDisplay: command,
		};
	}
}
