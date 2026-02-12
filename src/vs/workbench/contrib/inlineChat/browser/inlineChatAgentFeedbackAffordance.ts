/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable, IReader, ISettableObservable } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { DetailedLineRangeMapping } from '../../../../editor/common/diff/rangeMapping.js';
import { IRange, Range } from '../../../../editor/common/core/range.js';
import { Selection, SelectionDirection } from '../../../../editor/common/core/selection.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import { IAgentFeedbackService } from '../../chat/browser/agentFeedback/agentFeedbackService.js';
import { IInlineChatInputHandler, InlineChatInputWidget } from './inlineChatOverlayWidget.js';
import { URI } from '../../../../base/common/uri.js';

type AgentSessionResourceContext = {
	readonly sessionResource: URI;
	readonly resourceUri: URI;
};

type MenuData = { rect: DOMRect; above: boolean; lineNumber: number };

export class AgentFeedbackAffordance extends Disposable {

	private readonly _feedbackDisposables = this._store.add(new DisposableStore());

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _inputWidget: InlineChatInputWidget,
		private readonly _selectionData: IObservable<Selection | undefined>,
		private readonly _agentSessionResourceContextObs: IObservable<AgentSessionResourceContext | undefined>,
		private readonly _diffMappings: IObservable<readonly DetailedLineRangeMapping[] | undefined>,
		private readonly _isDiffModifiedEditorObs: IObservable<boolean>,
		private readonly _menuData: ISettableObservable<MenuData | undefined>,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();

		this._store.add(autorun(r => {
			const context = this._agentSessionResourceContextObs.read(r);
			this._feedbackDisposables.clear();
			this._inputWidget.setCustomHandler(undefined);

			if (!context) {
				this._menuData.set(undefined, undefined);
				return;
			}

			this._setupSubmitHandler();
			this._setupKeyboardInterception();
		}));

		this._store.add(autorun(r => {
			if (!this._agentSessionResourceContextObs.read(r)) {
				this._menuData.set(undefined, undefined);
				return;
			}

			const sel = this._selectionData.read(r);
			if (!sel) {
				this._menuData.set(undefined, undefined);
				return;
			}

			this._showInputForSelection(sel, r);
		}));
	}

	private _setupSubmitHandler(): void {
		this._inputWidget.setCustomHandler(this._instantiationService.createInstance(
			AgentFeedbackInputHandler,
			this._editor,
			this._selectionData,
			this._agentSessionResourceContextObs,
			this._isDiffModifiedEditorObs,
			this._diffMappings,
		));
	}

	private _setupKeyboardInterception(): void {
		this._feedbackDisposables.add(this._editor.onKeyDown(e => {
			if (this._inputWidget.position.read(undefined) === null || this._inputWidget.isFocused) {
				return;
			}

			if (e.keyCode === KeyCode.Tab && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				this._inputWidget.focusInput();
				return;
			}

			if (!e.ctrlKey && !e.altKey && !e.metaKey && e.browserEvent.key.length === 1) {
				e.preventDefault();
				e.stopPropagation();
				this._inputWidget.focusInput(e.browserEvent.key);
				return;
			}
		}));
	}

	private _showInputForSelection(sel: Selection, r: IReader): void {
		let lineNumber: number;
		let above: boolean;

		if (!sel.isEmpty()) {
			above = sel.getDirection() === SelectionDirection.RTL;
			lineNumber = sel.getPosition().lineNumber;
		} else {
			const cursorLine = sel.getPosition().lineNumber;
			const mappings = this._diffMappings.read(r);
			const mapping = mappings?.find(m => m.modified.contains(cursorLine));
			if (!mapping) {
				return;
			}
			({ lineNumber, above } = computeDiffHunkPosition(mapping, cursorLine, this._editor));
		}

		const scrolledPos = this._editor.getScrolledVisiblePosition(sel.getPosition());
		if (!scrolledPos) {
			return;
		}
		const editorDomNode = this._editor.getDomNode()!;
		const editorRect = editorDomNode.getBoundingClientRect();

		this._menuData.set({
			rect: new DOMRect(editorRect.left + scrolledPos.left, editorRect.top + scrolledPos.top, 0, scrolledPos.height),
			above,
			lineNumber,
		}, undefined);
	}
}

class AgentFeedbackInputHandler implements IInlineChatInputHandler {

	readonly menuId = undefined;
	readonly dismissOnEscape = true;

	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _selectionData: IObservable<Selection | undefined>,
		private readonly _agentSessionResourceContextObs: IObservable<AgentSessionResourceContext | undefined>,
		private readonly _isDiffModifiedEditorObs: IObservable<boolean>,
		private readonly _diffMappings: IObservable<readonly DetailedLineRangeMapping[] | undefined>,
		@IAgentFeedbackService private readonly _agentFeedbackService: IAgentFeedbackService,
	) { }

	getPlaceholder(_hasSelection: boolean): string {
		return localize('placeholderAgentFeedback', "Add feedback");
	}

	submit(text: string): void {
		const model = this._editor.getModel();
		if (!model) {
			return;
		}

		const sessionContext = this._agentSessionResourceContextObs.read(undefined);
		if (!sessionContext || !isEqual(sessionContext.resourceUri, model.uri)) {
			return;
		}

		let range: IRange | undefined;
		const sel = this._selectionData.read(undefined);
		if (sel && !sel.isEmpty()) {
			range = Range.lift(sel);
		} else if (sel && this._isDiffModifiedEditorObs.read(undefined)) {
			const cursorLine = sel.getPosition().lineNumber;
			const mappings = this._diffMappings.read(undefined);
			const mapping = mappings?.find(m => m.modified.contains(cursorLine));
			if (mapping) {
				range = mapping.modified.toInclusiveRange() ?? undefined;
			}
		}

		if (!range) {
			return;
		}

		this._agentFeedbackService.addFeedback(sessionContext.sessionResource, model.uri, range, text);
	}
}

function computeDiffHunkPosition(
	mapping: DetailedLineRangeMapping,
	cursorLine: number,
	editor: ICodeEditor
): { lineNumber: number; above: boolean } {
	const diffLength = mapping.modified.length;

	let candidateAboveLine: number;
	let candidateBelowLine: number;

	if (diffLength <= 6) {
		candidateAboveLine = mapping.modified.startLineNumber - 1;
		candidateBelowLine = mapping.modified.endLineNumberExclusive;
	} else {
		candidateAboveLine = cursorLine - 2;
		candidateBelowLine = cursorLine + 2;
	}

	const visibleRanges = editor.getVisibleRanges();
	const isLineVisible = (line: number) =>
		line >= 1 && visibleRanges.some(range =>
			line >= range.startLineNumber && line <= range.endLineNumber
		);

	const aboveVisible = isLineVisible(candidateAboveLine);
	const belowVisible = isLineVisible(candidateBelowLine);

	if (aboveVisible && !belowVisible) {
		return { lineNumber: candidateAboveLine, above: true };
	}
	if (!aboveVisible && belowVisible) {
		return { lineNumber: candidateBelowLine, above: false };
	}
	return { lineNumber: candidateAboveLine, above: true };
}
