/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { EditorView, EditorViewConfig, LineInput, ModelDeltaInput, TokenInput } from '@vscode/editor-view';
import { getActiveWindow } from '../../../../base/browser/dom.js';
import { createFastDomNode, type FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { Color } from '../../../../base/common/color.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { resolveAmdNodeModulePath } from '../../../../amdX.js';
import { editorBackground, editorForeground } from '../../../../platform/theme/common/colorRegistry.js';
import { editorActiveLineNumber, editorGutter, editorLineNumbers } from '../../../common/core/editorColorRegistry.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { TokenizationRegistry } from '../../../common/languages.js';
import type { IViewLineTokens } from '../../../common/tokens/lineTokens.js';
import type * as viewEvents from '../../../common/viewEvents.js';
import type { ViewContext } from '../../../common/viewModel/viewContext.js';
import type { RenderingContext, RestrictedRenderingContext } from '../../view/renderingContext.js';
import { ViewPart } from '../../view/viewPart.js';
import { EditorViewModelSync } from './editorViewModelSync.js';

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
		return true;
	}
	public override onCursorStateChanged(e: viewEvents.ViewCursorStateChangedEvent): boolean {
		// Track the primary cursor's view line so its number is highlighted with
		// `editorLineNumber.activeForeground`, matching the DOM line-numbers view.
		const activeLineNumber = e.selections[0].getPosition().lineNumber;
		if (activeLineNumber !== this._activeLineNumber) {
			this._activeLineNumber = activeLineNumber;
			return true;
		}
		return false;
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
		this._editorView?.dispose();
		this._editorView = undefined;
		this.canvas.domNode.remove();
		super.dispose();
	}
}
