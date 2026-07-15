/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from './chatSpeechToTextService.js';

/**
 * Renders the cumulative transcript into a code editor, replacing its own
 * inserted region on each update so dictation appears live as the user speaks.
 */
class LiveTranscriptInserter {
	private _anchor: Position | undefined;
	private _end: Position | undefined;
	private _needsLeadingSpace = false;

	constructor(private readonly _editor: ICodeEditor) { }

	update(fullText: string): void {
		const model = this._editor.getModel();
		if (!model) {
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
	}
}

interface IActiveDictation {
	readonly service: IChatSpeechToTextService;
	readonly editor: ICodeEditor;
	readonly inserter: LiveTranscriptInserter;
	readonly listener: IDisposable;
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
export async function startDictation(service: IChatSpeechToTextService, editor: ICodeEditor, window: Window & typeof globalThis): Promise<void> {
	if (_active || service.state !== ChatSpeechToTextState.Idle) {
		return;
	}
	const inserter = new LiveTranscriptInserter(editor);
	const listener = service.onDidUpdateTranscript(text => inserter.update(text));
	_active = { service, editor, inserter, listener };
	try {
		await service.start(window);
	} catch {
		// Acquisition/connection failure is surfaced by the service.
		listener.dispose();
		_active = undefined;
	}
}

/** Stop the active dictation and apply the final transcript. */
export async function stopDictation(): Promise<void> {
	const active = _active;
	if (!active) {
		return;
	}
	_active = undefined;
	try {
		const text = await active.service.stopAndTranscribe();
		if (text !== undefined) {
			active.inserter.update(text);
		}
	} finally {
		active.listener.dispose();
	}
}

/** Abort the active dictation, discarding whatever was recorded. */
export function cancelDictation(): void {
	const active = _active;
	if (!active) {
		return;
	}
	_active = undefined;
	active.listener.dispose();
	active.service.cancel();
}
