/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/dictationSession.css';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { IEditorDecorationsCollection } from '../../../../../editor/common/editorCommon.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from './chatSpeechToTextService.js';

/** Inline decoration class that shimmers not-yet-finalized dictation text. */
const INTERIM_SHIMMER_CLASS = 'dictation-interim-shimmer';

const LOG_PREFIX = '[chat-stt-dictation]';

/**
 * Renders the cumulative transcript into a code editor, replacing its own
 * inserted region on each update so dictation appears live as the user speaks.
 */
class LiveTranscriptInserter {
	private _anchor: Position | undefined;
	private _end: Position | undefined;
	private _needsLeadingSpace = false;
	private _shimmerDecorations: IEditorDecorationsCollection | undefined;
	private _finalized = false;

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _logService: ILogService,
	) { }

	/**
	 * Render the cumulative transcript. While `interim` is true the text is not
	 * yet finalized, so it is decorated with a shimmer animation; the final
	 * update (`interim === false`) clears the shimmer, leaving solid text.
	 *
	 * Once a final update has been applied, later interim updates are ignored:
	 * the transcription service can emit a trailing interim transcript as it
	 * shuts down (after `stopAndTranscribe` resolves), which would otherwise
	 * overwrite the final text and re-apply the shimmer.
	 */
	update(fullText: string, interim: boolean = true): void {
		this._logService.trace(`${LOG_PREFIX} inserter.update interim=${interim} finalized=${this._finalized} len=${fullText.length}`);
		if (this._finalized && interim) {
			this._logService.trace(`${LOG_PREFIX} inserter.update ignored (already finalized)`);
			return;
		}
		if (!interim) {
			this._finalized = true;
		}
		const model = this._editor.getModel();
		if (!model) {
			this._logService.trace(`${LOG_PREFIX} inserter.update no model`);
			return;
		}

		if (!this._anchor) {
			const selection = this._editor.getSelection() ?? model.getFullModelRange().collapseToEnd();
			const start = selection.getStartPosition();
			this._anchor = start;
			this._end = start;
			this._needsLeadingSpace = start.column > 1 && !/\s$/.test(model.getValueInRange(new Range(
				start.lineNumber, Math.max(1, start.column - 1), start.lineNumber, start.column,
			)));
		}

		const text = (this._needsLeadingSpace ? ' ' : '') + fullText;
		this._editor.executeEdits('chatSpeechToText', [{
			range: Range.fromPositions(this._anchor, this._end!),
			text,
			forceMoveMarkers: true,
		}]);

		const lines = text.split('\n');
		const endLine = this._anchor.lineNumber + lines.length - 1;
		const endColumn = lines.length === 1 ? this._anchor.column + lines[0].length : lines[lines.length - 1].length + 1;
		this._end = new Position(endLine, endColumn);
		this._editor.setPosition(this._end);
		this._updateShimmer(interim);
	}

	/** Shimmer the inserted (interim) region, or clear it once finalized. */
	private _updateShimmer(interim: boolean): void {
		if (!interim || !this._anchor || !this._end || Position.equals(this._anchor, this._end)) {
			this._logService.trace(`${LOG_PREFIX} shimmer clear (interim=${interim})`);
			this._shimmerDecorations?.clear();
			return;
		}
		if (!this._shimmerDecorations) {
			this._shimmerDecorations = this._editor.createDecorationsCollection();
		}
		this._logService.trace(`${LOG_PREFIX} shimmer set range=${this._anchor.lineNumber}:${this._anchor.column}-${this._end.lineNumber}:${this._end.column}`);
		this._shimmerDecorations.set([{
			range: Range.fromPositions(this._anchor, this._end),
			options: {
				description: 'chatSpeechToText-interim',
				inlineClassName: INTERIM_SHIMMER_CLASS,
			},
		}]);
	}

	/** Stop shimmering, leaving whatever text is currently inserted as solid. */
	clearShimmer(): void {
		this._logService.trace(`${LOG_PREFIX} clearShimmer`);
		this._shimmerDecorations?.clear();
	}

	/**
	 * Lock out further interim updates and stop shimmering immediately. Called
	 * when the user stops talking, before the (async) final transcription
	 * resolves, so a trailing interim transcript can neither overwrite the text
	 * nor re-apply the shimmer. The subsequent final `update(text, false)` still
	 * applies because it is not an interim update.
	 */
	beginFinalize(): void {
		this._logService.trace(`${LOG_PREFIX} beginFinalize`);
		this._finalized = true;
		this._shimmerDecorations?.clear();
	}

	/**
	 * Remove everything this inserter has written (including any leading space it
	 * added) and restore the caret to where dictation began. Used when dictation
	 * is cancelled so no dictated text is left behind.
	 */
	revert(): void {
		this._shimmerDecorations?.clear();
		const model = this._editor.getModel();
		if (!model || !this._anchor || !this._end) {
			return;
		}
		this._editor.executeEdits('chatSpeechToText', [{
			range: Range.fromPositions(this._anchor, this._end),
			text: '',
			forceMoveMarkers: true,
		}]);
		this._editor.setPosition(this._anchor);
		this._anchor = undefined;
		this._end = undefined;
	}
}

interface IActiveDictation {
	readonly service: IChatSpeechToTextService;
	readonly editor: ICodeEditor;
	readonly inserter: LiveTranscriptInserter;
	readonly disposables: DisposableStore;
	readonly logService: ILogService;
}

/**
 * Only one dictation can run at a time (the service is a singleton), so the
 * active session is tracked at module scope and shared by every entry point
 * (toggle action, hold-to-talk, and the sessions composer button).
 */
let _active: IActiveDictation | undefined;

/** True while a dictation is in progress. */
export function isDictating(): boolean {
	return !!_active;
}

/** The editor currently being dictated into, if any (used to scope the glow). */
export function activeDictationEditor(): ICodeEditor | undefined {
	return _active?.editor;
}

/** Start dictating into `editor`, rendering the transcript live. */
export async function startDictation(service: IChatSpeechToTextService, editor: ICodeEditor, window: Window & typeof globalThis, logService: ILogService): Promise<void> {
	if (_active || service.state !== ChatSpeechToTextState.Idle) {
		return;
	}
	const inserter = new LiveTranscriptInserter(editor, logService);
	const disposables = new DisposableStore();
	// Show a "Listening…" placeholder only once the session is actually
	// connected and recording, i.e. the service is in the Recording state and
	// the on-device model has finished preparing (downloading/loading). It must
	// not appear during microphone acquisition or while the model is still being
	// prepared, since transcription cannot happen yet. The placeholder remains
	// visible until transcript text is inserted, and is restored to its previous
	// value when the session ends.
	const previousPlaceholder = editor.getOption(EditorOption.placeholder);
	const listeningPlaceholder = localize('chatStt.listening', "Listening…");
	const applyPlaceholder = () => {
		if (!editor.getModel()) {
			return;
		}
		const shouldListen = service.state === ChatSpeechToTextState.Recording && !service.isPreparingModel;
		const current = editor.getOption(EditorOption.placeholder);
		if (shouldListen) {
			if (current !== listeningPlaceholder) {
				editor.updateOptions({ placeholder: listeningPlaceholder });
			}
		} else if (current === listeningPlaceholder) {
			editor.updateOptions({ placeholder: previousPlaceholder });
		}
	};
	disposables.add(toDisposable(() => {
		// Ensure the interim shimmer never lingers, regardless of how the session
		// ends (final transcript, cancel, editor disposal, or a service-side error).
		inserter.clearShimmer();
		if (!editor.getModel() || editor.getOption(EditorOption.placeholder) !== listeningPlaceholder) {
			return;
		}
		editor.updateOptions({ placeholder: previousPlaceholder });
	}));
	disposables.add(service.onDidUpdateTranscript(text => {
		logService.trace(`${LOG_PREFIX} onDidUpdateTranscript len=${text.length} state=${service.state}`);
		inserter.update(text);
	}));
	disposables.add(service.onDidChangePreparingModel(() => applyPlaceholder()));
	disposables.add(service.onDidChangeState(state => {
		logService.trace(`${LOG_PREFIX} onDidChangeState ${state}`);
		if (state === ChatSpeechToTextState.Idle && _active?.service === service) {
			// If the service ends the session on its own (e.g. the model failed
			// to load and it surfaced an error), drop the stale active reference
			// so the toolbar and glow reflect that dictation is no longer running.
			_active = undefined;
			disposables.dispose();
			return;
		}
		applyPlaceholder();
	}));
	// The target editor can be disposed out from under us (e.g. the Agents
	// composer is closed); cancel dictation instead of leaving the microphone
	// and local transcription running against a dead editor.
	disposables.add(editor.onDidDispose(() => cancelDictation()));
	_active = { service, editor, inserter, disposables, logService };
	try {
		await service.start(window);
	} catch {
		// Acquisition/connection failure is surfaced by the service.
		if (_active?.service === service) {
			_active = undefined;
		}
		disposables.dispose();
	}
}

/** Stop the active dictation and apply the final transcript. */
export async function stopDictation(): Promise<void> {
	const active = _active;
	if (!active) {
		return;
	}
	_active = undefined;
	active.logService.trace(`${LOG_PREFIX} stopDictation begin, state=${active.service.state}`);
	// Stop shimmering and lock out interim updates right away so a trailing
	// interim transcript emitted while transcription finalizes cannot re-apply
	// the shimmer or overwrite the final text.
	active.inserter.beginFinalize();
	try {
		const text = await active.service.stopAndTranscribe();
		active.logService.trace(`${LOG_PREFIX} stopAndTranscribe resolved text=${text === undefined ? 'undefined' : `len=${text.length}`}`);
		if (text !== undefined) {
			// Final transcript: render it solid (no shimmer).
			active.inserter.update(text, false);
		} else {
			// No final transcript to apply; make sure the shimmer does not linger
			// over the last interim text.
			active.inserter.clearShimmer();
		}
	} finally {
		active.logService.trace(`${LOG_PREFIX} stopDictation dispose`);
		active.disposables.dispose();
	}
}

/** Abort the active dictation, discarding whatever was recorded. */
export function cancelDictation(): void {
	const active = _active;
	if (!active) {
		return;
	}
	_active = undefined;
	// Remove any live transcript already written to the editor so Escape leaves
	// the input exactly as it was before dictation started.
	active.inserter.revert();
	active.disposables.dispose();
	active.service.cancel();
}
