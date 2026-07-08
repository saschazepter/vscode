/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { EditorView, EditorViewConfig, CursorInput, CursorStyle, LineInput, ModelDeltaInput, SelectionInput, TokenInput } from '@vscode/editor-view';
import { getActiveWindow, WindowIntervalTimer } from '../../../../base/browser/dom.js';
import { createFastDomNode, type FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { Color } from '../../../../base/common/color.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { resolveAmdNodeModulePath } from '../../../../amdX.js';
import { editorBackground, editorForeground, editorSelectionBackground, editorInactiveSelection } from '../../../../platform/theme/common/colorRegistry.js';
import { isHighContrast } from '../../../../platform/theme/common/theme.js';
import { editorActiveLineNumber, editorGutter, editorLineNumbers, editorLineHighlight, editorLineHighlightBorder, editorInactiveLineHighlight, editorCursorForeground, editorCursorBackground, editorMultiCursorPrimaryForeground, editorMultiCursorPrimaryBackground, editorMultiCursorSecondaryForeground, editorMultiCursorSecondaryBackground } from '../../../common/core/editorColorRegistry.js';
import { EditorOption, TextEditorCursorBlinkingStyle, TextEditorCursorStyle } from '../../../common/config/editorOptions.js';
import { TokenizationRegistry } from '../../../common/languages.js';
import type { IViewLineTokens } from '../../../common/tokens/lineTokens.js';
import type * as viewEvents from '../../../common/viewEvents.js';
import type { ViewContext } from '../../../common/viewModel/viewContext.js';
import type { RenderingContext, RestrictedRenderingContext } from '../../view/renderingContext.js';
import { ViewPart } from '../../view/viewPart.js';
import { EditorViewModelSync } from './editorViewModelSync.js';

/**
 * Which editor surfaces the `@vscode/editor-view` (Rust/WASM) renderer draws
 * itself. Each `true` means "the GPU canvas owns this surface", so the matching
 * DOM view part is **not constructed, mounted or ticked** — see the gating in
 * `view.ts`. Flip a flag to `true` only once the renderer draws that surface
 * pixel-faithfully (guarded by the `@vscode/editor-view` `test/compare` harness),
 * so we progressively shed the parallel DOM editor's CPU/DOM cost one surface at
 * a time instead of in a risky big-bang cutover.
 */
export interface EditorViewGpuCapabilities {
	/** Text glyphs (DOM `ViewLines.renderText` is skipped). */
	readonly text: boolean;
	/** Selection highlight (`SelectionsOverlay`). */
	readonly selection: boolean;
	/** Current-line highlight, content + margin (`CurrentLine*Overlay`). */
	readonly currentLine: boolean;
	/** Text caret (`ViewCursors`). */
	readonly cursor: boolean;
	/** Gutter line numbers (`LineNumbersOverlay`). */
	readonly lineNumbers: boolean;
	/**
	 * Content/margin decorations: squiggles, inline/line decorations, indent
	 * guides, rendered whitespace (`DecorationsOverlay`, `IndentGuidesOverlay`,
	 * `WhitespaceOverlay`, `LinesDecorationsOverlay`,
	 * `MarginViewLineDecorationsOverlay`).
	 */
	readonly decorations: boolean;
	/** Vertical rulers (`Rulers`). */
	readonly rulers: boolean;
	/** Minimap (`Minimap`). */
	readonly minimap: boolean;
	/** Overview ruler marks (`DecorationsOverviewRuler`). */
	readonly overviewRuler: boolean;
	/** Scroll shadow (`ScrollDecorationViewPart`). */
	readonly scrollDecoration: boolean;
	/** Block decorations outline (`BlockDecorations`). */
	readonly blockDecorations: boolean;
}

/**
 * What the Rust renderer draws **today**. Only text is owned so far (the DOM
 * `ViewLines.renderText` is already skipped in `editorView` mode); every other
 * surface still falls to its DOM view part until the renderer grows it. This is
 * a synchronous, static descriptor (it reflects what the renderer can do, not
 * runtime state), so `view.ts` can consult it while constructing the view even
 * though the renderer itself initializes asynchronously.
 */
export const EDITOR_VIEW_GPU_CAPABILITIES: EditorViewGpuCapabilities = {
	text: true,
	selection: true,
	currentLine: true,
	cursor: true,
	lineNumbers: false,
	decorations: false,
	rulers: false,
	minimap: false,
	overviewRuler: false,
	scrollDecoration: false,
	blockDecorations: false,
};

/**
 * Experimental integration of the `@vscode/editor-view` (Rust/WASM) GPU renderer.
 *
 * This is a **read-only proof of concept**: it mounts a canvas over the editor
 * content and mirrors the current document's lines, tokens, font and theme
 * colors onto the external renderer, keeping it in sync as the document,
 * viewport, theme or configuration change. Input, selections and hit-testing
 * are still handled by the regular (DOM) editor underneath.
 *
 * It is only constructed when `editor.experimentalGpuAcceleration` is set to
 * `'editorView'`; with any other value nothing here runs.
 */
export class EditorViewGpu extends ViewPart {

	/** Guard against pathological documents while this is a proof of concept. */
	private static readonly MAX_LINES = 20_000;

	public readonly canvas: FastDomNode<HTMLCanvasElement>;

	private _editorView: EditorView | undefined;
	private _disposed = false;
	/**
	 * Turns view events into the minimal set of model deltas (or a full reload).
	 * Renderer-free and unit-tested; this ViewPart only handles renderer readiness
	 * and executes the plan it produces.
	 */
	private readonly _sync = new EditorViewModelSync(EditorViewGpu.MAX_LINES);
	/** View line (1-based) holding the primary cursor; its number is highlighted. */
	private _activeLineNumber = 1;
	/** Current selections in renderer coordinates (0-based line, 0-based UTF-16 column). */
	private _selections: SelectionInput[] = [];
	/** 0-based view lines carrying a cursor (deduped), on which the current-line highlight is painted. */
	private _cursorLines: number[] = [0];
	/** Whether every selection is empty (a bare cursor); gates the content current-line highlight. */
	private _selectionIsEmpty = true;
	/**
	 * Whether the editor is focused. Selection and current-line highlight colors
	 * differ between the focused and inactive states, mirroring the DOM editor's
	 * `.focused` CSS. Starts `false` and tracks {@link onFocusChanged}.
	 */
	private _focused = false;
	/**
	 * Caret positions (1-based `(lineNumber, column)`), one per cursor with the
	 * primary at index 0 — the GPU renderer paints a caret at each. Mirrors the
	 * DOM `ViewCursors` (primary + secondaries).
	 */
	private _cursorPositions: { lineNumber: number; column: number }[] = [{ lineNumber: 1, column: 1 }];
	/**
	 * Whether the caret is in its "on" phase this frame. VS Code's blink is
	 * host-owned; we toggle this on {@link _blinkTimer} and repaint, and the
	 * renderer draws the caret only when it (and focus) permit.
	 */
	private _caretOn = true;
	/** Drives flat caret blinking (500ms), mirroring `ViewCursors`'s JS interval. */
	private readonly _blinkTimer = new WindowIntervalTimer();

	/** Flat-blink half-period, matching `ViewCursors.BLINK_INTERVAL`. */
	private static readonly BLINK_INTERVAL = 500;

	constructor(context: ViewContext) {
		super(context);

		this.canvas = createFastDomNode(document.createElement('canvas'));
		this.canvas.setClassName('editorView-experimental-canvas');
		this.canvas.setPosition('absolute');
		this.canvas.setTop(0);
		this.canvas.setLeft(0);
		// Let pointer input fall through to the DOM editor underneath, which
		// remains the source of truth and drives our sync while this is a
		// read-only proof of concept.
		this.canvas.domNode.style.pointerEvents = 'none';

		void this._initialize();
	}

	private async _initialize(): Promise<void> {
		try {
			const url = resolveAmdNodeModulePath('@vscode/editor-view', 'dist/index.js');
			// Runtime-computed URL to keep bundlers from rewriting the import (same as @vscode/diff).
			const mod = await import(/* webpackIgnore: true */ /* @vite-ignore */ `${url}`) as typeof import('@vscode/editor-view');
			if (this._disposed) {
				return;
			}

			const { width, height, dpr } = this._measure();
			this._editorView = await mod.EditorView.create(this.canvas.domNode, {
				width: Math.max(1, Math.round(width * dpr)),
				height: Math.max(1, Math.round(height * dpr)),
				config: this._buildConfig(),
			});
			if (this._disposed) {
				this._editorView.dispose();
				this._editorView = undefined;
				return;
			}

			// The renderer is ready; the planner still holds its initial full-reload
			// state, so the first present loads the whole model.
			this._present();
		} catch (err) {
			onUnexpectedError(err);
		}
	}

	// --- data extraction -----------------------------------------------------

	private _measure(): { width: number; height: number; dpr: number } {
		const layoutInfo = this._context.configuration.options.get(EditorOption.layoutInfo);
		return {
			width: layoutInfo.width,
			height: layoutInfo.height,
			dpr: getActiveWindow().devicePixelRatio || 1,
		};
	}

	private _buildConfig(): EditorViewConfig {
		const options = this._context.configuration.options;
		const fontInfo = options.get(EditorOption.fontInfo);
		const layoutInfo = options.get(EditorOption.layoutInfo);
		return {
			fontFamily: fontInfo.fontFamily,
			fontSize: fontInfo.fontSize,
			lineHeight: fontInfo.lineHeight,
			fontLigatures: !!options.get(EditorOption.fontLigatures),
			// Match the DOM editor's geometry so text/line-numbers land at the
			// same x offset: reserve exactly the editor's content-left as the
			// gutter, and expand tabs by the model's tab size.
			gutterWidth: layoutInfo.contentLeft,
			lineNumbersRight: layoutInfo.lineNumbersLeft + layoutInfo.lineNumbersWidth,
			tabSize: this._context.viewModel.model.getOptions().tabSize,
			background: this._packColor(this._context.theme.getColor(editorBackground), 0x1e1e1eff),
			// `editorGutter.background` defaults to `editor.background`; mirror that
			// fallback so the margin matches the DOM view in every theme.
			gutterBackground: this._packColor(
				this._context.theme.getColor(editorGutter) ?? this._context.theme.getColor(editorBackground),
				0x1e1e1eff,
			),
			foreground: this._packColor(this._context.theme.getColor(editorForeground), 0xd4d4d4ff),
			lineNumberForeground: this._packColor(this._context.theme.getColor(editorLineNumbers), 0x858585ff),
			lineNumberActiveForeground: this._packColor(this._context.theme.getColor(editorActiveLineNumber), 0xc6c6c6ff),
			// 0-based view line of the primary cursor, drawn with the active color.
			activeLine: this._activeLineNumber - 1,
			selections: this._selections,
			// `roundedSelection` mirrors the DOM `SelectionsOverlay`; the CSS
			// forces the radius off in high-contrast themes, so we do the same.
			roundedSelection: options.get(EditorOption.roundedSelection) && !isHighContrast(this._context.theme.type),
			...this._highlightColors(),
			...this._cursorConfig(),
		};
	}

	/**
	 * Resolve the caret list, style and geometry, mirroring VS Code's
	 * `ViewCursor`. The caret is painted only when the editor is focused and the
	 * blink phase is "on" (both host-owned — see {@link _updateBlinking}); on
	 * those frames every cursor position gets a caret, coloured with
	 * `editorCursor.foreground` (single) or the `editorMultiCursor.*` palette
	 * (which itself defaults to `editorCursor.foreground`).
	 */
	private _cursorConfig(): Pick<EditorViewConfig, 'cursors' | 'cursorStyle' | 'cursorWidth' | 'cursorHeight'> {
		const options = this._context.configuration.options;
		const fontInfo = options.get(EditorOption.fontInfo);
		const style = this._cursorStyle(options.get(EditorOption.effectiveCursorStyle));
		// Match `ViewCursor`: cap the line-caret width at a typical character and
		// let the renderer fall back to 2px when the option is 0 (the default).
		const cursorWidth = Math.min(options.get(EditorOption.cursorWidth), fontInfo.typicalHalfwidthCharacterWidth);
		const cursorHeight = options.get(EditorOption.cursorHeight);

		const shouldShow = this._focused && this._caretOn && this._cursorPositions.length > 0;
		if (!shouldShow) {
			return { cursors: [], cursorStyle: style, cursorWidth, cursorHeight };
		}

		const theme = this._context.theme;
		const single = this._cursorPositions.length === 1;
		const fallback = 0xaeafadff; // editorCursor.foreground (dark) default.
		const cursorFg = theme.getColor(editorCursorForeground);
		// Caret foreground: single cursor uses `.cursor` (editorCursor.foreground);
		// with multiple, index 0 is primary and the rest secondary (both default
		// to editorCursor.foreground via the color registry).
		const primaryFg = single ? cursorFg : (theme.getColor(editorMultiCursorPrimaryForeground) ?? cursorFg);
		const secondaryFg = theme.getColor(editorMultiCursorSecondaryForeground) ?? cursorFg;
		// Caret background = the color a block caret repaints the covered char in
		// (VS Code's theming participant: the `*.background` token, else the
		// foreground's `opposite()`).
		const bgFor = (fg: Color | undefined, bg: Color | undefined): number =>
			this._packColor(bg ?? fg?.opposite(), 0);
		const primaryBg = single
			? bgFor(cursorFg, theme.getColor(editorCursorBackground))
			: bgFor(primaryFg, theme.getColor(editorMultiCursorPrimaryBackground) ?? theme.getColor(editorCursorBackground));
		const secondaryBg = bgFor(secondaryFg, theme.getColor(editorMultiCursorSecondaryBackground) ?? theme.getColor(editorCursorBackground));
		const primary = this._packColor(primaryFg, fallback);
		const secondary = this._packColor(secondaryFg, fallback);
		const cursors: CursorInput[] = this._cursorPositions.map((p, i) => ({
			// View positions are 1-based; the renderer is 0-based.
			line: p.lineNumber - 1,
			column: p.column - 1,
			color: i === 0 ? primary : secondary,
			background: i === 0 ? primaryBg : secondaryBg,
		}));
		return { cursors, cursorStyle: style, cursorWidth, cursorHeight };
	}

	private _cursorStyle(style: TextEditorCursorStyle): CursorStyle {
		switch (style) {
			case TextEditorCursorStyle.Block: return 'block';
			case TextEditorCursorStyle.Underline: return 'underline';
			case TextEditorCursorStyle.LineThin: return 'line-thin';
			case TextEditorCursorStyle.BlockOutline: return 'block-outline';
			case TextEditorCursorStyle.UnderlineThin: return 'underline-thin';
			case TextEditorCursorStyle.Line:
			default: return 'line';
		}
	}

	/**
	 * (Re)configure caret blinking. The DOM `ViewCursors` uses CSS animations /
	 * a JS interval; since the GPU canvas is painted imperatively we mirror the
	 * flat-blink interval here (approximating smooth/phase/expand as flat blink)
	 * and repaint each toggle. The caret shows solid on focus / cursor moves,
	 * then blinks; it is hidden entirely when unfocused (matching
	 * `_getCursorBlinking`'s `Hidden` on blur).
	 */
	private _updateBlinking(): void {
		this._blinkTimer.cancel();
		this._caretOn = true;
		if (!this._focused) {
			return;
		}
		const style = this._context.configuration.options.get(EditorOption.cursorBlinking);
		if (style === TextEditorCursorBlinkingStyle.Hidden) {
			this._caretOn = false;
			return;
		}
		if (style !== TextEditorCursorBlinkingStyle.Solid) {
			this._blinkTimer.cancelAndSet(() => {
				this._caretOn = !this._caretOn;
				this._present();
			}, EditorViewGpu.BLINK_INTERVAL, getActiveWindow());
		}
	}

	/**
	 * Resolve the selection and current-line highlight state, mirroring
	 * `currentLineHighlight.ts` and `selections.css`:
	 * - Selection uses `editor.selectionBackground` when focused,
	 *   `editor.inactiveSelectionBackground` otherwise.
	 * - The current-line highlight is drawn in the **content** area when
	 *   `renderLineHighlight` is `line`/`all`, the selection is empty, and focus
	 *   permits; in the **gutter** when `gutter`/`all` and focus permits (not
	 *   gated on the selection). Its fill uses `editor.lineHighlightBackground`
	 *   (focused) / `editor.inactiveLineHighlightBackground` (unfocused); the 2px
	 *   `editor.lineHighlightBorder` box is drawn when there is no opaque fill or
	 *   the theme explicitly defines a border. `renderLineHighlightOnlyWhenFocus`
	 *   suppresses both when unfocused.
	 */
	private _highlightColors(): Pick<EditorViewConfig, 'selectionBackground' | 'lineHighlightBackground' | 'lineHighlightBorder' | 'highlightLines' | 'highlightContent' | 'highlightMargin'> {
		const theme = this._context.theme;
		const options = this._context.configuration.options;
		const selection = this._focused
			? theme.getColor(editorSelectionBackground)
			: theme.getColor(editorInactiveSelection);

		const mode = options.get(EditorOption.renderLineHighlight);
		const focusOk = !options.get(EditorOption.renderLineHighlightOnlyWhenFocus) || this._focused;
		const highlightContent = (mode === 'line' || mode === 'all') && this._selectionIsEmpty && focusOk;
		const highlightMargin = (mode === 'gutter' || mode === 'all') && focusOk;

		const lineHighlight = theme.getColor(editorLineHighlight);
		const inactiveLineHighlight = theme.getColor(editorInactiveLineHighlight);
		// Focused prefers the active color and falls back to the inactive one
		// (the `.focused` background rule is only emitted when the active color
		// exists); unfocused always uses the inactive color.
		const fill = this._focused ? (lineHighlight ?? inactiveLineHighlight) : inactiveLineHighlight;
		const hasOpaqueFill = !!fill && !fill.isTransparent();

		let lineHighlightBorder = 0;
		if (!lineHighlight || lineHighlight.isTransparent() || theme.value.defines(editorLineHighlightBorder)) {
			lineHighlightBorder = this._packColor(theme.getColor(editorLineHighlightBorder), 0);
		}

		return {
			selectionBackground: this._packColor(selection, 0),
			lineHighlightBackground: hasOpaqueFill ? this._packColor(fill, 0) : 0,
			lineHighlightBorder,
			highlightLines: this._cursorLines,
			highlightContent,
			highlightMargin,
		};
	}

	private _packColor(color: Color | undefined, fallback: number): number {
		if (!color) {
			return fallback;
		}
		const { r, g, b, a } = color.rgba;
		return (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (Math.round(a * 255) & 0xff)) >>> 0;
	}

	private _gatherLines(): LineInput[] {
		const lineCount = Math.min(this._context.viewModel.getLineCount(), EditorViewGpu.MAX_LINES);
		const ctx = this._tokenColorContext();
		const lines: LineInput[] = new Array(lineCount);
		for (let i = 0; i < lineCount; i++) {
			lines[i] = this._buildLine(i + 1, ctx.colorMap, ctx.defaultForeground);
		}
		return lines;
	}

	/** Build one view line's `{ text, tokens }` payload from the view model. */
	private _buildLine(viewLineNumber: number, colorMap: number[], defaultForeground: number): LineInput {
		const lineData = this._context.viewModel.getViewLineData(viewLineNumber);
		return {
			text: lineData.content,
			tokens: this._buildTokens(lineData.tokens, colorMap, defaultForeground),
		};
	}

	/**
	 * The token color palette (indexed by `ColorId`, pre-packed) plus the default
	 * foreground, resolved once so a batch of line/token rebuilds shares them.
	 */
	private _tokenColorContext(): { colorMap: number[]; defaultForeground: number } {
		return {
			colorMap: this._buildTokenColorMap(),
			defaultForeground: this._packColor(this._context.theme.getColor(editorForeground), 0xd4d4d4ff),
		};
	}

	/**
	 * Convert VS Code's `IViewLineTokens` (offsets + `ColorId`/font-style
	 * metadata) into the renderer's packed-color {@link TokenInput}s. The
	 * renderer lays runs out consecutively and does not fill gaps, so the tokens
	 * must tile the whole line — which they always do, so we derive each token's
	 * start from the previous token's end offset.
	 *
	 * Offsets are UTF-16 code-unit offsets into the line content, matching the
	 * string handed to the renderer.
	 */
	private _buildTokens(tokens: IViewLineTokens, colorMap: number[], defaultForeground: number): TokenInput[] {
		const count = tokens.getCount();
		const result: TokenInput[] = new Array(count);
		let start = 0;
		for (let i = 0; i < count; i++) {
			const end = tokens.getEndOffset(i);
			const p = tokens.getPresentation(i);
			result[i] = {
				startColumn: start,
				endColumn: end,
				foreground: colorMap[p.foreground] ?? defaultForeground,
				bold: p.bold,
				italic: p.italic,
				underline: p.underline,
				strikethrough: p.strikethrough,
			};
			start = end;
		}
		return result;
	}

	/**
	 * The theme's token color palette, indexed by `ColorId` and pre-packed into
	 * the renderer's `0xRRGGBBAA` format. Rebuilt on every refresh so theme and
	 * color-map changes are reflected (see `onThemeChanged`/`onTokensColorsChanged`).
	 */
	private _buildTokenColorMap(): number[] {
		const themeColorMap = TokenizationRegistry.getColorMap();
		if (!themeColorMap) {
			return [];
		}
		const result: number[] = new Array(themeColorMap.length);
		for (let i = 0; i < themeColorMap.length; i++) {
			result[i] = this._packColor(themeColorMap[i], 0xd4d4d4ff);
		}
		return result;
	}

	// --- incremental sync ----------------------------------------------------

	/**
	 * Record an edit with the planner, unless the renderer isn't ready yet — in
	 * which case escalate to a full reload so the first present captures everything.
	 */
	private _recordEdit(record: (sync: EditorViewModelSync) => void): void {
		if (!this._editorView) {
			this._sync.scheduleFullReload();
			return;
		}
		record(this._sync);
	}

	/** Apply a delta to the mirror; on failure fall back to a full reload. */
	private _applyDelta(delta: ModelDeltaInput): void {
		try {
			this._editorView!.applyDelta(delta);
		} catch (err) {
			onUnexpectedError(err);
			this._sync.scheduleFullReload();
		}
	}

	/**
	 * Execute the planner's batch at present time, reading line content in the (now
	 * final) view-model state — mirroring how the DOM `ViewLines` reads line data
	 * lazily at render time rather than in the event handlers.
	 */
	private _syncModel(): void {
		const plan = this._sync.takePlan();
		if (plan.fullReload) {
			this._editorView!.setLines(this._gatherLines());
			return;
		}
		if (plan.structural.length === 0 && plan.contentLines.length === 0 && plan.tokenLines.length === 0) {
			return;
		}
		// Structural splices first so the mirror's line count matches the view model,
		// then fill in the (final-coordinate) dirty lines' content and tokens.
		for (const delta of plan.structural) {
			this._applyDelta(delta);
		}
		const lineCount = this._context.viewModel.getLineCount();
		const ctx = this._tokenColorContext();
		for (const line of plan.contentLines) {
			if (line >= 1 && line <= lineCount) {
				this._applyDelta({
					type: 'replaceLines',
					start: line - 1,
					deleteCount: 1,
					insert: [this._buildLine(line, ctx.colorMap, ctx.defaultForeground)],
				});
			}
		}
		for (const line of plan.tokenLines) {
			if (line >= 1 && line <= lineCount) {
				const tokens = this._buildTokens(this._context.viewModel.getViewLineData(line).tokens, ctx.colorMap, ctx.defaultForeground);
				this._applyDelta({ type: 'setTokens', line: line - 1, tokens });
			}
		}
	}

	// --- rendering -----------------------------------------------------------

	private _present(): void {
		if (!this._editorView || this._disposed) {
			return;
		}

		const { width, height, dpr } = this._measure();
		const backingWidth = Math.max(1, Math.round(width * dpr));
		const backingHeight = Math.max(1, Math.round(height * dpr));

		this.canvas.setWidth(width);
		this.canvas.setHeight(height);
		if (this.canvas.domNode.width !== backingWidth || this.canvas.domNode.height !== backingHeight) {
			this._editorView.resize(backingWidth, backingHeight);
		}

		this._editorView.setConfig(this._buildConfig());
		this._syncModel();
		this._editorView.setViewport({
			width,
			height,
			scrollTop: this._context.viewLayout.getCurrentScrollTop(),
			scrollLeft: this._context.viewLayout.getCurrentScrollLeft(),
			devicePixelRatio: dpr,
		});

		try {
			this._editorView.render();
		} catch (err) {
			onUnexpectedError(err);
		}
	}

	public prepareRender(ctx: RenderingContext): void {
		// Nothing to prepare; the external renderer owns its own scene.
	}

	public render(ctx: RestrictedRenderingContext): void {
		this._present();
	}

	// --- events --------------------------------------------------------------

	public override onConfigurationChanged(e: viewEvents.ViewConfigurationChangedEvent): boolean {
		// Font/layout/tab changes don't alter the model's text or tokens; the
		// fresh config is pushed on every present, so just request a repaint.
		// (Wrapping-column changes surface separately via `onLineMappingChanged`.)
		// The caret style/blink options may have changed, so re-arm blinking.
		this._updateBlinking();
		return true;
	}
	public override onCursorStateChanged(e: viewEvents.ViewCursorStateChangedEvent): boolean {
		// Track the primary cursor's view line so its number is highlighted with
		// `editorLineNumber.activeForeground`, mirror the full selection set so the
		// renderer can paint it, and derive the current-line highlight state
		// (cursor lines + whether the selection is empty).
		const activeLineNumber = e.selections[0].getPosition().lineNumber;
		// View selections are 1-based (line, column); the renderer is 0-based.
		const selections: SelectionInput[] = e.selections.map(s => ({
			startLine: s.startLineNumber - 1,
			startColumn: s.startColumn - 1,
			endLine: s.endLineNumber - 1,
			endColumn: s.endColumn - 1,
		}));
		// Distinct 0-based cursor (position) lines — VS Code highlights each one.
		const cursorLines = Array.from(new Set(e.selections.map(s => s.getPosition().lineNumber - 1))).sort((a, b) => a - b);
		this._activeLineNumber = activeLineNumber;
		this._selections = selections;
		this._cursorLines = cursorLines;
		this._selectionIsEmpty = e.selections.every(s => s.isEmpty());
		// Caret positions (1-based) for the renderer, primary first.
		this._cursorPositions = e.selections.map(s => {
			const p = s.getPosition();
			return { lineNumber: p.lineNumber, column: p.column };
		});
		// A cursor move re-shows the caret solid, then resumes blinking (so it
		// doesn't flicker while typing) — matching `ViewCursors`.
		this._updateBlinking();
		return true;
	}
	public override onFocusChanged(e: viewEvents.ViewFocusChangedEvent): boolean {
		if (this._focused === e.isFocused) {
			return false;
		}
		// Focus flips selection / current-line highlight to their active colors,
		// and gates the caret (hidden when unfocused).
		this._focused = e.isFocused;
		this._updateBlinking();
		return true;
	}
	public override onFlushed(e: viewEvents.ViewFlushedEvent): boolean {
		// The whole model was replaced (e.g. a different document).
		this._sync.scheduleFullReload();
		return true;
	}
	public override onLineMappingChanged(e: viewEvents.ViewLineMappingChangedEvent): boolean {
		// View↔model line mapping changed (word wrap / folding): view lines are
		// remapped wholesale, so incremental tracking no longer applies.
		this._sync.scheduleFullReload();
		return true;
	}
	public override onLinesChanged(e: viewEvents.ViewLinesChangedEvent): boolean {
		this._recordEdit(sync => sync.onLinesChanged(e.fromLineNumber, e.count, this._context.viewModel.getLineCount()));
		return true;
	}
	public override onLinesDeleted(e: viewEvents.ViewLinesDeletedEvent): boolean {
		this._recordEdit(sync => sync.onLinesDeleted(e.fromLineNumber, e.toLineNumber, this._context.viewModel.getLineCount()));
		return true;
	}
	public override onLinesInserted(e: viewEvents.ViewLinesInsertedEvent): boolean {
		this._recordEdit(sync => sync.onLinesInserted(e.fromLineNumber, e.toLineNumber, this._context.viewModel.getLineCount()));
		return true;
	}
	public override onScrollChanged(e: viewEvents.ViewScrollChangedEvent): boolean {
		return true;
	}
	public override onThemeChanged(e: viewEvents.ViewThemeChangedEvent): boolean {
		// Base colors are re-pushed via config every present, but token foreground
		// colors are baked into per-line tokens, so rebuild them all.
		this._sync.scheduleFullReload();
		return true;
	}
	public override onTokensChanged(e: viewEvents.ViewTokensChangedEvent): boolean {
		// Background tokenization (the hot path): refresh only the reported lines'
		// tokens, not the whole document.
		this._recordEdit(sync => sync.onTokensChanged(e.ranges, this._context.viewModel.getLineCount()));
		return true;
	}
	public override onTokensColorsChanged(e: viewEvents.ViewTokensColorsChangedEvent): boolean {
		// The theme's token color map changed; every line's token colors are stale.
		this._sync.scheduleFullReload();
		return true;
	}
	public override onZonesChanged(e: viewEvents.ViewZonesChangedEvent): boolean {
		return true;
	}

	public override dispose(): void {
		this._disposed = true;
		this._blinkTimer.dispose();
		this._editorView?.dispose();
		this._editorView = undefined;
		this.canvas.domNode.remove();
		super.dispose();
	}
}
