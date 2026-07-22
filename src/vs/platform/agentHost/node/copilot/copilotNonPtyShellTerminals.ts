/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { TerminalClaimKind, type TerminalSessionClaim } from '../../common/state/protocol/state.js';
import { IAgentHostTerminalManager } from '../agentHostTerminalManager.js';

/**
 * Builds the terminal channel URI for a runtime-executed (non-pty) shell tool
 * call. Keyed by tool call id so the URI is stable across live streaming and
 * history replay of the same command.
 */
export function buildNonPtyShellTerminalUri(toolCallId: string): string {
	return `agenthost-terminal://shell/copilotNonPtyShells/${toolCallId}`;
}

interface INonPtyShellStream {
	readonly uri: string;
	/** The last cumulative snapshot written to the channel (cleared on finalize). */
	lastEmitted: string;
	finalized: boolean;
}

/**
 * Streams output of SDK-runtime-executed shell tool calls into output-only
 * AHP terminal channels. The runtime reports ANSI-stripped plain-text output
 * via `tool.execution_partial_result` as cumulative snapshots (throttled and
 * capped to the leading ~10KB with a trailing truncation marker); this class
 * emits only the unseen suffix as `terminal/data` while the snapshot grows
 * in place, and resets the channel when the snapshot was rewritten (e.g. the
 * truncation marker changed), so subscribed clients receive live plain-text
 * output (`isPty: false` — no VT parsing needed).
 *
 * Created once per session and disposed with it, matching the pty-backed
 * `ShellManager` lifecycle.
 */
export class NonPtyShellTerminalStreams extends Disposable {

	private readonly _streams = new Map<string, INonPtyShellStream>();

	constructor(
		private readonly _sessionUri: URI,
		@IAgentHostTerminalManager private readonly _terminalManager: IAgentHostTerminalManager,
	) {
		super();

		this._register(toDisposable(() => {
			for (const stream of this._streams.values()) {
				this._terminalManager.disposeTerminal(stream.uri);
			}
			this._streams.clear();
		}));
	}

	/**
	 * Appends the unseen suffix of `cumulativeOutput` to the tool call's
	 * output terminal, creating the channel on first call. Returns the channel
	 * URI and whether this call created it (so the caller can attach the
	 * terminal content block exactly once).
	 */
	append(toolCallId: string, cumulativeOutput: string, title: string): { uri: string; created: boolean } {
		let stream = this._streams.get(toolCallId);
		let created = false;
		if (!stream) {
			const uri = buildNonPtyShellTerminalUri(toolCallId);
			const claim: TerminalSessionClaim = {
				kind: TerminalClaimKind.Session,
				session: this._sessionUri.toString(),
				toolCallId,
			};
			this._terminalManager.createOutputTerminal(uri, { title, claim });
			stream = { uri, lastEmitted: '', finalized: false };
			this._streams.set(toolCallId, stream);
			created = true;
		}
		if (stream.finalized || cumulativeOutput === stream.lastEmitted) {
			return { uri: stream.uri, created };
		}
		if (cumulativeOutput.startsWith(stream.lastEmitted)) {
			this._terminalManager.appendOutputTerminalData(stream.uri, cumulativeOutput.slice(stream.lastEmitted.length));
		} else {
			// The snapshot no longer extends what we emitted — the runtime
			// rewrote it (its ~10KB cap keeps leading lines and splices in a
			// growing truncation marker). Start the channel over.
			this._terminalManager.resetOutputTerminal(stream.uri);
			this._terminalManager.appendOutputTerminalData(stream.uri, cumulativeOutput);
		}
		stream.lastEmitted = cumulativeOutput;
		return { uri: stream.uri, created };
	}

	/**
	 * Records the command's exit on the tool call's output terminal, if one
	 * was created. Later partial results for the tool call are ignored.
	 */
	finalize(toolCallId: string, exitCode: number | undefined): void {
		const stream = this._streams.get(toolCallId);
		if (!stream || stream.finalized) {
			return;
		}
		stream.finalized = true;
		stream.lastEmitted = '';
		this._terminalManager.finalizeOutputTerminal(stream.uri, exitCode);
	}
}
