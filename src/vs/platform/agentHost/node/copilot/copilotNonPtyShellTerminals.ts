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
	emittedLength: number;
	finalized: boolean;
}

/**
 * Streams output of SDK-runtime-executed shell tool calls into output-only
 * AHP terminal channels. The runtime reports cumulative output via
 * `tool.execution_partial_result`; this class emits only the unseen suffix as
 * `terminal/data` so subscribed clients receive live plain-text output
 * (`isPty: false` — no VT parsing needed).
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
			stream = { uri, emittedLength: 0, finalized: false };
			this._streams.set(toolCallId, stream);
			created = true;
		}
		if (stream.finalized) {
			return { uri: stream.uri, created };
		}
		if (cumulativeOutput.length < stream.emittedLength) {
			// The runtime rewrote its cumulative output (defensive); start over.
			this._terminalManager.resetOutputTerminal(stream.uri);
			stream.emittedLength = 0;
		}
		const delta = cumulativeOutput.slice(stream.emittedLength);
		if (delta.length > 0) {
			this._terminalManager.appendOutputTerminalData(stream.uri, delta);
			stream.emittedLength = cumulativeOutput.length;
		}
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
		this._terminalManager.finalizeOutputTerminal(stream.uri, exitCode);
	}
}
