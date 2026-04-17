/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DocumentId } from '../../../platform/inlineEdits/common/dataTypes/documentId';
import { StatelessNextEditRequest } from '../../../platform/inlineEdits/common/statelessNextEditProvider';
import { ILogger } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { CachedOrRebasedEdit } from './nextEditCache';
import { NextEditResult } from './nextEditResult';

/**
 * Reasons why a speculative request was cancelled. Recorded on the request's
 * log context so each cancellation has an attributable cause.
 */
export const enum SpeculativeCancelReason {

	/** The originating suggestion was rejected by the user. */
	Rejected = 'rejected',

	/** The originating suggestion was dismissed without being superseded. */
	IgnoredDismissed = 'ignoredDismissed',

	/** A new fetch is starting whose `(docId, postEditContent)` doesn't match. */
	Superseded = 'superseded',

	/** A newer speculative is being installed in this slot. */
	Replaced = 'replaced',

	/** The user's edits moved off the type-through trajectory toward `postEditContent`. */
	DivergedFromTrajectoryPrefix = 'divergedFromTrajectoryPrefix',
	DivergedFromTrajectoryMiddle = 'divergedFromTrajectoryMiddle',
	DivergedFromTrajectorySuffix = 'divergedFromTrajectorySuffix',

	/** `clearCache()` was invoked. */
	CacheCleared = 'cacheCleared',

	/** The target document was removed from the workspace. */
	DocumentClosed = 'documentClosed',

	/** The provider was disposed. */
	Disposed = 'disposed',
}

export interface SpeculativePendingRequest {
	readonly request: StatelessNextEditRequest<CachedOrRebasedEdit>;
	readonly docId: DocumentId;
	readonly postEditContent: string;
	/** preEditDocument[0..editStart] — the doc text before the edit window. */
	readonly trajectoryPrefix: string;
	/** preEditDocument[editEnd..] — the doc text after the edit window. */
	readonly trajectorySuffix: string;
	/** The replacement text the user would type to reach `postEditContent`. */
	readonly trajectoryNewText: string;
	/**
	 * Length of the text replaced by the suggestion (preEdit[editStart..editEnd]).
	 * The type-through trajectory check only models pure insertions; for
	 * substitutions/removals (`trajectoryOldTextLen > 0`) the check is skipped
	 * and the speculative is kept alive until another lifecycle trigger fires.
	 */
	readonly trajectoryOldTextLen: number;
}

export interface ScheduledSpeculativeRequest {
	readonly suggestion: NextEditResult;
	readonly headerRequestId: string;
}

/**
 * Owns the lifecycle of NES speculative requests:
 *
 * - the in-flight `pending` speculative (the bet on a specific post-accept document state)
 * - the `scheduled` speculative deferred until its originating stream completes
 *
 * Centralizes cancellation with typed reasons so every triggered cancellation
 * (reject, supersede, doc-close, trajectory divergence, dispose, ...) goes through
 * one path and is logged on the request's log context.
 */
export class SpeculativeRequestManager extends Disposable {

	private _pending: SpeculativePendingRequest | null = null;
	private _scheduled: ScheduledSpeculativeRequest | null = null;

	constructor(private readonly _logger: ILogger) {
		super();
	}

	get pending(): SpeculativePendingRequest | null {
		return this._pending;
	}

	/**
	 * Replaces the current pending speculative; cancels the prior one as `Replaced`.
	 *
	 * The slot stays populated until the request is explicitly cancelled or
	 * superseded — multiple `provideNextEdit` invocations targeting the same
	 * `(docId, postEditContent)` can all join the same in-flight stream,
	 * mirroring `_pendingStatelessNextEditRequest`'s dedupe behavior.
	 * Once the speculative settles, `_nextEditCache` covers further reuse;
	 * the now-stale slot is cleared by the next `setPending` / `cancelAll`
	 * / `cancelIfMismatch` / trajectory-divergence trigger.
	 */
	setPending(req: SpeculativePendingRequest): void {
		if (this._pending && this._pending.request !== req.request) {
			this._cancelPending(SpeculativeCancelReason.Replaced);
		}
		this._pending = req;
		// Record the trajectory data on the request's own log context so any
		// subsequent cancellation diagnostic can be cross-referenced against
		// the state captured at speculative creation time.
		req.request.logContext.addLog('speculative request installed (trajectory captured)');
		req.request.logContext.addCodeblockToLog(JSON.stringify({
			docId: req.docId.toString(),
			postEditContentLen: req.postEditContent.length,
			trajectoryPrefixLen: req.trajectoryPrefix.length,
			trajectoryPrefixHead: truncate(req.trajectoryPrefix.slice(0, 80), 80),
			trajectoryPrefixTail: truncate(req.trajectoryPrefix.slice(Math.max(0, req.trajectoryPrefix.length - 80)), 80),
			trajectorySuffixLen: req.trajectorySuffix.length,
			trajectorySuffixHead: truncate(req.trajectorySuffix.slice(0, 80), 80),
			trajectorySuffixTail: truncate(req.trajectorySuffix.slice(Math.max(0, req.trajectorySuffix.length - 80)), 80),
			trajectoryNewText: truncate(req.trajectoryNewText, 200),
			trajectoryNewTextLen: req.trajectoryNewText.length,
			trajectoryOldTextLen: req.trajectoryOldTextLen,
			trajectoryTracked: req.trajectoryOldTextLen === 0,
		}, null, 2), 'json');
	}

	schedule(s: ScheduledSpeculativeRequest): void {
		this._scheduled = s;
	}

	clearScheduled(): void {
		this._scheduled = null;
	}

	/**
	 * Removes and returns the scheduled entry iff its `headerRequestId` matches.
	 * Used by the streaming path so that each stream only ever consumes its own
	 * schedule, never another stream's.
	 */
	consumeScheduled(headerRequestId: string): ScheduledSpeculativeRequest | null {
		if (this._scheduled?.headerRequestId !== headerRequestId) {
			return null;
		}
		const s = this._scheduled;
		this._scheduled = null;
		return s;
	}

	cancelAll(reason: SpeculativeCancelReason): void {
		this._scheduled = null;
		this._cancelPending(reason);
	}

	/** Cancels the pending speculative iff `(docId, postEditContent)` doesn't match. */
	cancelIfMismatch(docId: DocumentId, postEditContent: string, reason: SpeculativeCancelReason): void {
		if (!this._pending) { return; }
		if (this._pending.docId === docId && this._pending.postEditContent === postEditContent) { return; }
		this._cancelPending(reason, {
			pendingDocId: this._pending.docId.toString(),
			incomingDocId: docId.toString(),
			pendingPostEditContentLen: this._pending.postEditContent.length,
			incomingPostEditContentLen: postEditContent.length,
			docIdMatches: this._pending.docId === docId,
			postEditContentMatches: this._pending.postEditContent === postEditContent,
			...(this._pending.postEditContent !== postEditContent
				? { mismatch: describeStringMismatch(this._pending.postEditContent, postEditContent) }
				: {}),
		});
	}

	/** Cancels the pending and clears any scheduled targeting this document. */
	onDocumentClosed(docId: DocumentId): void {
		if (this._scheduled?.suggestion.result?.targetDocumentId === docId) {
			this._scheduled = null;
		}
		if (this._pending?.docId === docId) {
			this._cancelPending(SpeculativeCancelReason.DocumentClosed);
		}
	}

	/**
	 * Trajectory check. The pending speculative is alive iff the current document
	 * value is a *type-through prefix* toward the speculative's `postEditContent`:
	 *
	 *     cur === trajectoryPrefix + middle + trajectorySuffix
	 *     where middle is some prefix of trajectoryNewText
	 *
	 * If not, the user's edits cannot reach `postEditContent` via continued typing
	 * and the speculative will never be consumed — cancel now.
	 */
	onActiveDocumentChanged(docId: DocumentId, currentDocValue: string): void {
		const p = this._pending;
		if (!p || p.docId !== docId) {
			return;
		}
		const check = checkTrajectory(p, currentDocValue);
		if (check.ok) {
			return;
		}
		this._cancelPending(check.reason, check.details);
	}

	private _cancelPending(reason: SpeculativeCancelReason, diagnostic?: Record<string, unknown>): void {
		const p = this._pending;
		if (!p) {
			return;
		}
		this._pending = null;
		const headerRequestId = p.request.headerRequestId;
		this._logger.trace(`cancelling speculative request: ${reason} (headerRequestId=${headerRequestId})`);
		p.request.logContext.addLog(`speculative request cancelled: \`${reason}\``);
		// Always include the request's own trajectory metadata so the log entry
		// is self-contained — the reader doesn't need to cross-reference the
		// originating `setPending` call.
		const payload: Record<string, unknown> = {
			reason,
			docId: p.docId.toString(),
			postEditContentLen: p.postEditContent.length,
			trajectoryPrefixLen: p.trajectoryPrefix.length,
			trajectorySuffixLen: p.trajectorySuffix.length,
			trajectoryNewText: truncate(p.trajectoryNewText, 200),
			trajectoryNewTextLen: p.trajectoryNewText.length,
			...(diagnostic ?? {}),
		};
		p.request.logContext.addCodeblockToLog(JSON.stringify(payload, null, 2), 'json');
		const cts = p.request.cancellationTokenSource;
		cts.cancel();
		// Dispose to release the cancel-event listeners that the in-flight
		// provider call hooked onto the token. Safe even though the runner may
		// observe cancellation asynchronously — `cancel()` already fired the event.
		cts.dispose();
	}

	override dispose(): void {
		this.cancelAll(SpeculativeCancelReason.Disposed);
		super.dispose();
	}
}

type TrajectoryCheckResult =
	| { ok: true }
	| {
		ok: false;
		reason: SpeculativeCancelReason;
		details: Record<string, unknown>;
	};

/**
 * Checks whether `currentDocValue` is on the type-through trajectory toward
 * `p.postEditContent`. Returns a structured result so the cancellation site
 * can record exactly what mismatched.
 */
function checkTrajectory(p: SpeculativePendingRequest, currentDocValue: string): TrajectoryCheckResult {
	// The type-through trajectory model only fits pure insertions: starting from
	// preEdit (`prefix + "" + suffix`), the user types characters of `newText`
	// into the gap. For substitutions/removals (oldText non-empty), the initial
	// state already has `oldText` in the gap, which is generally not a prefix of
	// `newText`, so the check would over-cancel on the first keystroke. Skip it.
	if (p.trajectoryOldTextLen > 0) {
		return { ok: true };
	}

	const minLen = p.trajectoryPrefix.length + p.trajectorySuffix.length;

	// Cheap structural failure: doc shorter than the unedited frame.
	if (currentDocValue.length < minLen) {
		return {
			ok: false,
			reason: SpeculativeCancelReason.DivergedFromTrajectoryPrefix,
			details: {
				explanation: 'currentDocValue is shorter than trajectoryPrefix + trajectorySuffix',
				currentDocLen: currentDocValue.length,
				minRequiredLen: minLen,
				docHead: truncate(currentDocValue, 200),
			},
		};
	}

	if (!currentDocValue.startsWith(p.trajectoryPrefix)) {
		return {
			ok: false,
			reason: SpeculativeCancelReason.DivergedFromTrajectoryMiddle,
			details: {
				explanation: 'currentDocValue does not start with trajectoryPrefix',
				currentDocLen: currentDocValue.length,
				...describeStringMismatch(p.trajectoryPrefix, currentDocValue.slice(0, p.trajectoryPrefix.length)),
			},
		};
	}

	if (!currentDocValue.endsWith(p.trajectorySuffix)) {
		return {
			ok: false,
			reason: SpeculativeCancelReason.DivergedFromTrajectoryMiddle,
			details: {
				explanation: 'currentDocValue does not end with trajectorySuffix',
				currentDocLen: currentDocValue.length,
				...describeStringMismatch(
					p.trajectorySuffix,
					currentDocValue.slice(currentDocValue.length - p.trajectorySuffix.length),
				),
			},
		};
	}

	const middle = currentDocValue.slice(p.trajectoryPrefix.length, currentDocValue.length - p.trajectorySuffix.length);
	if (!p.trajectoryNewText.startsWith(middle)) {
		return {
			ok: false,
			reason: SpeculativeCancelReason.DivergedFromTrajectorySuffix,
			details: {
				explanation: 'middle is not a prefix of trajectoryNewText',
				middle: truncate(middle, 200),
				middleLen: middle.length,
				...describeStringMismatch(p.trajectoryNewText.slice(0, middle.length), middle),
			},
		};
	}

	return { ok: true };
}

/**
 * Compares two strings character-by-character and returns the first index at
 * which they differ, plus a small window of context around it.
 */
function describeStringMismatch(expected: string, actual: string): Record<string, unknown> {
	const minLen = Math.min(expected.length, actual.length);
	let i = 0;
	while (i < minLen && expected.charCodeAt(i) === actual.charCodeAt(i)) {
		i++;
	}
	const ctxStart = Math.max(0, i - 20);
	const ctxEnd = i + 20;
	return {
		firstMismatchAt: i,
		expectedLen: expected.length,
		actualLen: actual.length,
		expectedAround: visualize(expected.slice(ctxStart, ctxEnd)),
		actualAround: visualize(actual.slice(ctxStart, ctxEnd)),
		expectedCharAtMismatch: i < expected.length ? toCharRepr(expected.charCodeAt(i)) : '<EOF>',
		actualCharAtMismatch: i < actual.length ? toCharRepr(actual.charCodeAt(i)) : '<EOF>',
	};
}

function toCharRepr(code: number): string {
	return `U+${code.toString(16).toUpperCase().padStart(4, '0')} (${JSON.stringify(String.fromCharCode(code))})`;
}

function visualize(s: string): string {
	return s.replace(/\r/g, '␍').replace(/\n/g, '␊').replace(/\t/g, '␉');
}

function truncate(s: string, max: number): string {
	if (s.length <= max) {
		return visualize(s);
	}
	return visualize(s.slice(0, max)) + `…(+${s.length - max} chars)`;
}
