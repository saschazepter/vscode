/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ICodeEditor, IViewZone } from '../../../../editor/browser/editorBrowser.js';
import { diffAddDecoration, diffDeleteDecoration, diffWholeLineAddDecoration } from '../../../../editor/browser/widget/diffEditor/registrations.contribution.js';
import { LineSource, renderLines, RenderOptions } from '../../../../editor/browser/widget/diffEditor/components/diffEditorViewZones/renderLines.js';
import { InlineDecoration, InlineDecorationType } from '../../../../editor/common/viewModel/inlineDecorations.js';
import { IEditorDecorationsCollection, ScrollType } from '../../../../editor/common/editorCommon.js';
import { ModelDecorationOptions } from '../../../../editor/common/model/textModel.js';
import { IModelDeltaDecoration, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickDiffModelService } from './quickDiffModel.js';
import { ChangeType, getChangeType, getModifiedEndLineNumber, QuickDiffChange } from '../common/quickDiff.js';
import { IChange } from '../../../../editor/common/diff/legacyLinesDiffComputer.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../editor/common/core/range.js';
import { rot } from '../../../../base/common/numbers.js';
import { URI } from '../../../../base/common/uri.js';
import { QuickDiffHunkWidget } from './quickDiffHunkWidget.js';

interface HunkWidgetData {
	widget: QuickDiffHunkWidget;
	disposables: DisposableStore;
	decorations: IEditorDecorationsCollection | null;
	viewZones: string[];
}

export class QuickDiffHunkController extends Disposable {

	private readonly hunkWidgets: Map<number, HunkWidgetData> = new Map();

	constructor(
		private readonly editor: ICodeEditor,
		@IQuickDiffModelService private readonly quickDiffModelService: IQuickDiffModelService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();

		this._register(this.editor.onDidChangeModel(() => {
			this.closeAllWidgets();
		}));
	}

	toggleWidget(lineNumber: number): void {
		const editorModel = this.editor.getModel();
		if (!editorModel) {
			return;
		}

		const modelRef = this.quickDiffModelService.createQuickDiffModelReference(editorModel.uri);
		if (!modelRef) {
			return;
		}

		try {
			const allChanges = modelRef.object.changes;
			const index = allChanges.findIndex(change =>
				lineNumber >= change.change.modifiedStartLineNumber &&
				lineNumber <= (change.change.modifiedEndLineNumber || change.change.modifiedStartLineNumber)
			);

			if (index < 0) {
				// For deleted lines, check if we're on the line before the deletion
				const deleteIndex = allChanges.findIndex(change =>
					change.change.modifiedStartLineNumber === lineNumber + 1 &&
					change.change.modifiedEndLineNumber === 0
				);
				if (deleteIndex >= 0) {
					this.toggleWidgetForIndex(allChanges, deleteIndex, editorModel.uri);
				}
				return;
			}

			this.toggleWidgetForIndex(allChanges, index, editorModel.uri);
		} finally {
			modelRef.dispose();
		}
	}

	private toggleWidgetForIndex(allChanges: QuickDiffChange[], index: number, uri: URI): void {
		// If widget for this index exists, close it
		if (this.hunkWidgets.has(index)) {
			this.closeWidget(index);
			return;
		}

		// Otherwise show the widget
		this.showWidget(allChanges, index, uri);
	}

	private showWidget(allChanges: QuickDiffChange[], index: number, uri: URI): void {
		const change = allChanges[index];
		const changeData = change.change;

		// Get provider-specific changes for the context
		const providerChanges: IChange[] = [];
		let contextIndex = index;
		for (let i = 0; i < allChanges.length; i++) {
			if (allChanges[i].providerId === change.providerId) {
				providerChanges.push(allChanges[i].change);
				if (i === index) {
					contextIndex = providerChanges.length - 1;
				}
			}
		}

		// Get the diff editor model to access original content
		const modelRef = this.quickDiffModelService.createQuickDiffModelReference(uri);
		if (!modelRef) {
			return;
		}

		const diffEditorModel = modelRef.object.getDiffEditorModel(change.original);
		if (!diffEditorModel) {
			modelRef.dispose();
			return;
		}

		const originalModel = diffEditorModel.original;
		const modifiedModel = diffEditorModel.modified;

		const disposables = new DisposableStore();
		const viewZones: string[] = [];
		let viewZoneHeightInLines = 0;

		// Create decorations for the diff
		const decorations: IModelDeltaDecoration[] = [];

		const chatDiffAddDecoration = ModelDecorationOptions.createDynamic({
			...diffAddDecoration,
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
		});
		const chatDiffWholeLineAddDecoration = ModelDecorationOptions.createDynamic({
			...diffWholeLineAddDecoration,
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		});

		const changeType = getChangeType(changeData);

		// For modifications and additions, show green decorations on modified lines
		if (changeType === ChangeType.Add || changeType === ChangeType.Modify) {
			const modifiedRange = new Range(
				changeData.modifiedStartLineNumber,
				1,
				changeData.modifiedEndLineNumber,
				modifiedModel.getLineMaxColumn(changeData.modifiedEndLineNumber)
			);
			decorations.push({
				range: modifiedRange,
				options: chatDiffWholeLineAddDecoration
			});

			// Character-level additions for modifications
			if (changeType === ChangeType.Modify) {
				decorations.push({
					range: modifiedRange,
					options: chatDiffAddDecoration
				});
			}
		}

		const hunkDecorations = this.editor.createDecorationsCollection(decorations);
		disposables.add(toDisposable(() => {
			hunkDecorations.clear();
		}));

		// For deletions and modifications, show deleted content as a view zone
		if (changeType === ChangeType.Delete || changeType === ChangeType.Modify) {
			const originalStartLine = changeData.originalStartLineNumber;
			const originalEndLine = changeData.originalEndLineNumber;

			if (originalStartLine <= originalEndLine) {
				// Force tokenization for the original lines
				originalModel.tokenization.forceTokenization(Math.max(1, originalEndLine));

				const mightContainNonBasicASCII = originalModel.mightContainNonBasicASCII();
				const mightContainRTL = originalModel.mightContainRTL();
				const renderOptions = RenderOptions.fromEditor(this.editor);

				const tokens: ReturnType<typeof originalModel.tokenization.getLineTokens>[] = [];
				for (let line = originalStartLine; line <= originalEndLine; line++) {
					tokens.push(originalModel.tokenization.getLineTokens(line));
				}

				const source = new LineSource(
					tokens,
					[],
					mightContainNonBasicASCII,
					mightContainRTL,
				);

				// Add inline decorations for deleted content
				const inlineDecorations: InlineDecoration[] = [];
				for (let line = originalStartLine; line <= originalEndLine; line++) {
					const lineLength = originalModel.getLineLength(line);
					inlineDecorations.push(new InlineDecoration(
						new Range(line - originalStartLine + 1, 1, line - originalStartLine + 1, lineLength + 1),
						diffDeleteDecoration.className!,
						InlineDecorationType.Regular
					));
				}

				const domNode = document.createElement('div');
				domNode.className = 'quick-diff-original-zone view-lines line-delete monaco-mouse-cursor-text';
				const result = renderLines(source, renderOptions, inlineDecorations, domNode);

				viewZoneHeightInLines = result.heightInLines;

				const afterLineNumber = changeType === ChangeType.Delete
					? changeData.modifiedStartLineNumber - 1
					: changeData.modifiedStartLineNumber - 1;

				this.editor.changeViewZones((accessor) => {
					const viewZoneData: IViewZone = {
						afterLineNumber,
						heightInLines: result.heightInLines,
						domNode,
						ordinal: 50000 + 2
					};
					viewZones.push(accessor.addZone(viewZoneData));
				});
			}
		}

		disposables.add(toDisposable(() => {
			this.editor.changeViewZones((accessor) => {
				for (const id of viewZones) {
					accessor.removeZone(id);
				}
			});
		}));

		disposables.add(modelRef);

		const hunkWidget = this.instantiationService.createInstance(
			QuickDiffHunkWidget,
			this.editor,
			modifiedModel.uri,
			change.original,
			providerChanges,
			contextIndex,
			() => this.closeWidget(index),
			() => this.navigateWidget(allChanges, index, uri, -1),
			() => this.navigateWidget(allChanges, index, uri, 1)
		);

		// For deleted hunks, position at the line before the view zone
		// For other types, position at the start of the modified range
		const startLineNumber = changeType === ChangeType.Delete
			? changeData.modifiedStartLineNumber - 1
			: changeData.modifiedStartLineNumber;
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		const viewZoneHeight = viewZoneHeightInLines * lineHeight;
		hunkWidget.layout(startLineNumber, viewZoneHeight);
		hunkWidget.toggle(true);

		// Store the widget data
		this.hunkWidgets.set(index, {
			widget: hunkWidget,
			disposables,
			decorations: hunkDecorations,
			viewZones
		});

		// Handle scroll and layout changes
		disposables.add(Event.any(this.editor.onDidScrollChange, this.editor.onDidLayoutChange)(() => {
			const data = this.hunkWidgets.get(index);
			if (data?.widget) {
				const lineNumber = data.widget.getStartLineNumber();
				if (lineNumber) {
					data.widget.layout(lineNumber, data.widget.getViewZoneHeight());
				}
			}
		}));
	}

	private closeWidget(index: number): void {
		const data = this.hunkWidgets.get(index);
		if (data) {
			data.disposables.dispose();
			data.widget.dispose();
			this.hunkWidgets.delete(index);
		}
	}

	private navigateWidget(allChanges: QuickDiffChange[], currentIndex: number, uri: URI, direction: number): void {
		// Close the current widget
		this.closeWidget(currentIndex);

		// Calculate the new index with wrapping
		const newIndex = rot(currentIndex + direction, allChanges.length);

		// Reveal the new change position
		const newChange = allChanges[newIndex];
		const lineNumber = getModifiedEndLineNumber(newChange.change);
		this.editor.revealLineInCenter(lineNumber, ScrollType.Smooth);

		// Show the widget for the new index
		this.showWidget(allChanges, newIndex, uri);
	}

	closeAllWidgets(): void {
		for (const [index] of this.hunkWidgets) {
			this.closeWidget(index);
		}
	}

	override dispose(): void {
		this.closeAllWidgets();
		super.dispose();
	}
}
