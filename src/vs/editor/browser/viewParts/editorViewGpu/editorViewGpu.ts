/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { EditorView, EditorViewConfig, LineInput } from '@vscode/editor-view';
import { getActiveWindow } from '../../../../base/browser/dom.js';
import { createFastDomNode, type FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { Color } from '../../../../base/common/color.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { resolveAmdNodeModulePath } from '../../../../amdX.js';
import { editorBackground, editorForeground } from '../../../../platform/theme/common/colorRegistry.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import type * as viewEvents from '../../../common/viewEvents.js';
import type { ViewContext } from '../../../common/viewModel/viewContext.js';
import type { RenderingContext, RestrictedRenderingContext } from '../../view/renderingContext.js';
import { ViewPart } from '../../view/viewPart.js';

/**
 * Experimental integration of the `@vscode/editor-view` (Rust/WASM) GPU renderer.
 *
 * This is a **read-only proof of concept**: it mounts a canvas over the editor
 * content and mirrors the current document's lines, font and theme colors onto
 * the external renderer, keeping it in sync as the document, viewport, theme or
 * configuration change. Input, selections and hit-testing are still handled by
 * the regular (DOM) editor underneath.
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
	private _linesDirty = true;

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

			this._linesDirty = true;
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
		return {
			fontFamily: fontInfo.fontFamily,
			fontSize: fontInfo.fontSize,
			lineHeight: fontInfo.lineHeight,
			fontLigatures: !!options.get(EditorOption.fontLigatures),
			background: this._packColor(this._context.theme.getColor(editorBackground), 0x1e1e1eff),
			foreground: this._packColor(this._context.theme.getColor(editorForeground), 0xd4d4d4ff),
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
		const model = this._context.viewModel;
		const lineCount = Math.min(model.getLineCount(), EditorViewGpu.MAX_LINES);
		const lines: LineInput[] = new Array(lineCount);
		for (let i = 0; i < lineCount; i++) {
			lines[i] = { text: model.getLineContent(i + 1) };
		}
		return lines;
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
		if (this._linesDirty) {
			this._editorView.setLines(this._gatherLines());
			this._linesDirty = false;
		}
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
		this._linesDirty = true;
		return true;
	}
	public override onFlushed(e: viewEvents.ViewFlushedEvent): boolean {
		this._linesDirty = true;
		return true;
	}
	public override onLinesChanged(e: viewEvents.ViewLinesChangedEvent): boolean {
		this._linesDirty = true;
		return true;
	}
	public override onLinesDeleted(e: viewEvents.ViewLinesDeletedEvent): boolean {
		this._linesDirty = true;
		return true;
	}
	public override onLinesInserted(e: viewEvents.ViewLinesInsertedEvent): boolean {
		this._linesDirty = true;
		return true;
	}
	public override onScrollChanged(e: viewEvents.ViewScrollChangedEvent): boolean {
		return true;
	}
	public override onThemeChanged(e: viewEvents.ViewThemeChangedEvent): boolean {
		return true;
	}
	public override onTokensChanged(e: viewEvents.ViewTokensChangedEvent): boolean {
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
