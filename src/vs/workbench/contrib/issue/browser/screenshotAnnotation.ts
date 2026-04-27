/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IScreenshot } from './issueReporterOverlay.js';

const enum AnnotationTool {
	Select = 'select',
	Freehand = 'freehand',
	Rectangle = 'rectangle',
	Ellipse = 'ellipse',
	Arrow = 'arrow',
	Text = 'text',
	Pan = 'pan',
	Crop = 'crop',
}

const COLORS = [
	'#ff3b30', // red
	'#007aff', // blue
	'#34c759', // green
	'#ffcc00', // yellow
	'#000000', // black
	'#ffffff', // white
];

const FONT_FAMILIES = [
	{ label: 'Sans-serif', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
	{ label: 'Monospace', value: '"Cascadia Code", "Fira Code", Consolas, monospace' },
	{ label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
];

const FONT_SIZES = [12, 16, 20, 24, 32, 48];
const DEFAULT_TEXT_BOX_WIDTH = 240;
const MIN_TEXT_BOX_WIDTH = 48;
const TEXT_DRAG_THRESHOLD = 4;

interface DrawAction {
	readonly type: AnnotationTool;
	color: string;
	lineWidth: number;
	fontSize?: number;
	fontFamily?: string;
	points?: { x: number; y: number }[];
	rect?: { x: number; y: number; width: number; height: number };
	ellipseRect?: { x: number; y: number; width: number; height: number };
	arrowStart?: { x: number; y: number };
	arrowEnd?: { x: number; y: number };
	text?: string;
	textPos?: { x: number; y: number };
	textWidth?: number;
}

export class ScreenshotAnnotationEditor {

	private readonly disposables = new DisposableStore();
	private readonly _onDidSave = new Emitter<string>();
	readonly onDidSave: Event<string> = this._onDidSave.event;
	private readonly _onDidCancel = new Emitter<void>();
	readonly onDidCancel: Event<void> = this._onDidCancel.event;

	private container!: HTMLElement;
	private canvas!: HTMLCanvasElement;
	private ctx!: CanvasRenderingContext2D;

	private activeTool: AnnotationTool = AnnotationTool.Freehand;
	private activeColor: string = COLORS[0];
	private readonly actions: DrawAction[] = [];
	private readonly undoneActions: DrawAction[] = [];
	private currentAction: DrawAction | null = null;
	private isDrawing = false;

	private imageElement: HTMLImageElement | null = null;
	private imageWidth = 0;
	private imageHeight = 0;
	private scale = 1;

	// Pan & zoom
	private panX = 0;
	private panY = 0;
	private isPanning = false;
	private lastPanPoint = { x: 0, y: 0 };

	// Crop with handles
	private cropMode = false;
	private cropRegion: { x: number; y: number; width: number; height: number } | null = null;
	private cropDragHandle: 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move' | null = null;
	private cropDragStart = { x: 0, y: 0 };
	private cropRegionStart: { x: number; y: number; width: number; height: number } | null = null;
	private hasUserZoomed = false;

	// Original image preserved so crops can be expanded back
	private originalImage: { element: HTMLImageElement; width: number; height: number } | null = null;
	// Current crop region in original-image coords (null = no crop applied)
	private currentCrop: { x: number; y: number; width: number; height: number } | null = null;
	// Pre-crop state restored on Cancel
	private preCropState: { element: HTMLImageElement; width: number; height: number; currentCrop: { x: number; y: number; width: number; height: number } | null } | null = null;
	private mainToolbar: HTMLElement | null = null;
	private cropToolbar: HTMLElement | null = null;

	/** Annotations are stored in original-image coords. While in crop mode the canvas already shows the original image, so the offset is 0. */
	private get cropOffsetX(): number { return this.cropMode ? 0 : (this.currentCrop?.x ?? 0); }
	private get cropOffsetY(): number { return this.cropMode ? 0 : (this.currentCrop?.y ?? 0); }

	// Selection (Select tool)
	private selectedActionIndex = -1;
	private isDraggingSelected = false;
	private isResizingSelectedText = false;
	private dragStart = { x: 0, y: 0 };
	private selectedTextResizeStartWidth = DEFAULT_TEXT_BOX_WIDTH;

	// Text configuration
	private activeFontSize = 16;
	private activeFontFamily = FONT_FAMILIES[0].value;
	private textPlacementState: {
		start: { x: number; y: number };
		current: { x: number; y: number };
		pointerId: number;
	} | null = null;
	private textEditState: {
		pos: { x: number; y: number };
		text: string;
		caretIndex: number;
		color: string;
		fontSize: number;
		fontFamily: string;
		width: number;
		showBoxOutline: boolean;
	} | null = null;
	private textEditor: HTMLTextAreaElement | null = null;
	private textCaretVisible = true;
	private textCaretInterval: number | null = null;

	// Crop undo history
	private readonly imageHistory: { element: HTMLImageElement; width: number; height: number; currentCrop: { x: number; y: number; width: number; height: number } | null }[] = [];

	// Tool buttons (for active state management)
	private readonly toolButtons: { element: HTMLElement; tool: AnnotationTool }[] = [];


	constructor(
		private readonly screenshot: IScreenshot,
		private readonly parentElement: HTMLElement,
	) {
		this.createUI();
		this.loadImage();
	}

	private createUI(): void {
		this.container = append(this.parentElement, $('div.issue-reporter-annotation-overlay'));
		this.container.tabIndex = 0;

		// Main toolbar (hidden during crop mode)
		const toolbar = append(this.container, $('div.annotation-toolbar'));
		this.mainToolbar = toolbar;

		// 1. Drawing tools: Select, Pan, Crop, Draw, Rectangle, Ellipse, Arrow
		const drawingTools: { tool: AnnotationTool; label: string; icon: HTMLSpanElement }[] = [
			{ tool: AnnotationTool.Select, label: localize('select', "Select / Move"), icon: renderIcon(Codicon.inspect) },
			{ tool: AnnotationTool.Pan, label: localize('pan', "Pan"), icon: renderIcon(Codicon.move) },
		];
		for (const { tool, label, icon } of drawingTools) {
			this.addToolButton(toolbar, tool, label, icon);
		}

		// 2. Crop tool (uses scissors unicode character since no scissors codicon)
		const cropBtn = append(toolbar, $('button.tool-btn.crop-btn'));
		cropBtn.textContent = '\u2702';
		cropBtn.title = localize('crop', "Crop");
		cropBtn.setAttribute('aria-label', localize('crop', "Crop"));
		this.toolButtons.push({ element: cropBtn, tool: AnnotationTool.Crop });
		this.disposables.add(addDisposableListener(cropBtn, EventType.CLICK, () => {
			this.setActiveTool(AnnotationTool.Crop);
		}));

		// 3. More drawing tools
		const moreDrawingTools: { tool: AnnotationTool; label: string; icon: HTMLSpanElement }[] = [
			{ tool: AnnotationTool.Freehand, label: localize('freehand', "Draw"), icon: renderIcon(Codicon.edit) },
			{ tool: AnnotationTool.Rectangle, label: localize('rectangle', "Rectangle"), icon: renderIcon(Codicon.primitiveSquare) },
			{ tool: AnnotationTool.Ellipse, label: localize('ellipse', "Ellipse"), icon: renderIcon(Codicon.circle) },
			{ tool: AnnotationTool.Arrow, label: localize('arrow', "Arrow"), icon: renderIcon(Codicon.arrowRight) },
		];
		for (const { tool, label, icon } of moreDrawingTools) {
			this.addToolButton(toolbar, tool, label, icon);
		}

		// 4. Text tool
		this.addToolButton(toolbar, AnnotationTool.Text, localize('text', "Text"), renderIcon(Codicon.symbolString));

		// 5. Color button + popover
		const colorBtn = append(toolbar, $('button.tool-btn.color-btn'));
		colorBtn.title = localize('color', "Color");
		colorBtn.setAttribute('aria-label', localize('color', "Color"));
		const colorIndicator = append(colorBtn, $('div.color-indicator'));
		colorIndicator.style.backgroundColor = this.activeColor;

		const colorPopover = append(toolbar, $('div.color-popover'));
		colorPopover.style.display = 'none';

		const swatchElements: HTMLElement[] = [];
		for (const color of COLORS) {
			const swatch = append(colorPopover, $('div.color-swatch'));
			swatch.style.backgroundColor = color;
			if (color === this.activeColor) {
				swatch.classList.add('active');
			}
			swatchElements.push(swatch);
			this.disposables.add(addDisposableListener(swatch, EventType.CLICK, e => {
				e.stopPropagation();
				this.activeColor = color;
				if (this.textEditState) {
					this.textEditState.color = color;
					this.redraw();
				}
				colorIndicator.style.backgroundColor = color;
				for (const s of swatchElements) {
					s.classList.remove('active');
				}
				swatch.classList.add('active');
				colorPopover.style.display = 'none';
			}));
		}

		this.disposables.add(addDisposableListener(colorBtn, EventType.CLICK, e => {
			e.stopPropagation();
			colorPopover.style.display = colorPopover.style.display === 'none' ? 'flex' : 'none';
		}));

		this.disposables.add(addDisposableListener(this.container, EventType.CLICK, () => {
			colorPopover.style.display = 'none';
		}));

		// 6. Font family selector
		const fontFamilySelect = append(toolbar, $('select.toolbar-select')) as HTMLSelectElement;
		fontFamilySelect.title = localize('fontFamily', "Font Family");
		for (const ff of FONT_FAMILIES) {
			const opt = $('option') as HTMLOptionElement;
			opt.value = ff.value;
			opt.textContent = ff.label;
			fontFamilySelect.appendChild(opt);
		}
		fontFamilySelect.value = this.activeFontFamily;
		this.disposables.add(addDisposableListener(fontFamilySelect, EventType.CHANGE, () => {
			this.activeFontFamily = fontFamilySelect.value;
			if (this.textEditState) {
				this.textEditState.fontFamily = this.activeFontFamily;
				this.redraw();
			}
		}));

		// 7. Font size selector
		const fontSizeSelect = append(toolbar, $('select.toolbar-select')) as HTMLSelectElement;
		fontSizeSelect.title = localize('fontSize', "Font Size");
		for (const size of FONT_SIZES) {
			const opt = $('option') as HTMLOptionElement;
			opt.value = String(size);
			opt.textContent = `${size}px`;
			fontSizeSelect.appendChild(opt);
		}
		fontSizeSelect.value = String(this.activeFontSize);
		this.disposables.add(addDisposableListener(fontSizeSelect, EventType.CHANGE, () => {
			this.activeFontSize = parseInt(fontSizeSelect.value);
			if (this.textEditState) {
				this.textEditState.fontSize = this.activeFontSize;
				this.redraw();
			}
		}));

		// 8. Separator
		append(toolbar, $('div.toolbar-separator'));

		// 9. Undo button
		const undoBtn = append(toolbar, $('button.tool-btn'));
		undoBtn.appendChild(renderIcon(Codicon.discard));
		undoBtn.title = localize('undo', "Undo");
		undoBtn.setAttribute('aria-label', localize('undo', "Undo"));
		this.disposables.add(addDisposableListener(undoBtn, EventType.CLICK, () => this.undo()));

		// 10. Redo button
		const redoBtn = append(toolbar, $('button.tool-btn'));
		redoBtn.appendChild(renderIcon(Codicon.redo));
		redoBtn.title = localize('redo', "Redo");
		redoBtn.setAttribute('aria-label', localize('redo', "Redo"));
		this.disposables.add(addDisposableListener(redoBtn, EventType.CLICK, () => this.redo()));

		// 11. Separator
		append(toolbar, $('div.toolbar-separator'));

		// 12. Discard button
		const discardBtn = this.disposables.add(new Button(toolbar, { ...defaultButtonStyles, secondary: true }));
		discardBtn.label = localize('discard', "Discard");
		this.disposables.add(discardBtn.onDidClick(() => {
			this.cancelTextEdit();
			this._onDidCancel.fire();
			this.dispose();
		}));

		// 13. Save button
		const saveBtn = this.disposables.add(new Button(toolbar, defaultButtonStyles));
		saveBtn.label = localize('save', "Save");
		this.disposables.add(saveBtn.onDidClick(() => {
			this.commitTextEdit();
			const dataUrl = this.compositeToDataUrl();
			this._onDidSave.fire(dataUrl);
			this.dispose();
		}));

		// Crop toolbar (shown only during crop mode, hidden by default)
		const cropToolbar = append(this.container, $('div.annotation-toolbar.annotation-crop-toolbar'));
		cropToolbar.style.display = 'none';
		this.cropToolbar = cropToolbar;

		const cropCancelBtn = this.disposables.add(new Button(cropToolbar, { ...defaultButtonStyles, secondary: true }));
		cropCancelBtn.label = localize('cancel', "Cancel");
		this.disposables.add(cropCancelBtn.onDidClick(() => {
			this.cancelCrop();
		}));

		const cropApplyBtn = this.disposables.add(new Button(cropToolbar, defaultButtonStyles));
		cropApplyBtn.label = localize('apply', "Apply");
		this.disposables.add(cropApplyBtn.onDidClick(() => {
			this.commitCrop();
		}));

		// Hint label
		const hint = append(this.container, $('div.annotation-hint'));
		hint.textContent = localize('annotationHint', "Edit screenshot to highlight the problem");

		// Canvas container
		const canvasContainer = append(this.container, $('div.annotation-canvas-container'));
		this.canvas = append(canvasContainer, $('canvas')) as HTMLCanvasElement;
		const ctx = this.canvas.getContext('2d');
		if (!ctx) {
			throw new Error('Failed to get 2D canvas context');
		}
		this.ctx = ctx;

		// Canvas pointer events
		this.disposables.add(addDisposableListener(this.canvas, EventType.POINTER_DOWN, e => this.onPointerDown(e)));
		this.disposables.add(addDisposableListener(this.canvas, EventType.POINTER_MOVE, e => this.onPointerMove(e)));
		this.disposables.add(addDisposableListener(this.canvas, EventType.POINTER_UP, e => this.onPointerUp(e)));

		// Double-click to apply crop
		this.disposables.add(addDisposableListener(this.canvas, EventType.DBLCLICK, () => {
			this.commitCrop();
		}));

		// Wheel: touchpad two-finger scroll → pan; Ctrl+wheel or pinch → zoom around cursor
		this.disposables.add(addDisposableListener(canvasContainer, EventType.WHEEL, (e: WheelEvent) => {
			e.preventDefault();
			if (e.ctrlKey) {
				// Pinch-to-zoom on touchpad (browser synthesises ctrlKey) or Ctrl+scroll
				const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
				const zoomFactor = delta < 0 ? 1.1 : 0.9;
				const newScale = Math.max(0.1, Math.min(8, this.scale * zoomFactor));
				// Zoom around the cursor: pan is relative to the flex-centered container,
				// so offset from the container center determines the pan adjustment.
				const containerRect = canvasContainer.getBoundingClientRect();
				const ax = e.clientX - (containerRect.left + containerRect.width / 2);
				const ay = e.clientY - (containerRect.top + containerRect.height / 2);
				const r = newScale / this.scale;
				this.panX = ax * (1 - r) + this.panX * r;
				this.panY = ay * (1 - r) + this.panY * r;
				this.scale = newScale;
				this.hasUserZoomed = true;
				this.sizeCanvas();
				this.clampPan();
				this.canvas.style.transform = `translate(${this.panX}px, ${this.panY}px)`;
				this.redraw();
			} else {
				// Two-finger scroll on touchpad (or plain scroll wheel) → pan
				this.panX -= e.deltaX;
				this.panY -= e.deltaY;
				this.clampPan();
				this.canvas.style.transform = `translate(${this.panX}px, ${this.panY}px)`;
			}
		}, { passive: false }));

		// Keyboard shortcuts
		this.disposables.add(addDisposableListener(this.container, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (this.textEditState) {
				return;
			}
			if (this.textPlacementState && e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this.cancelTextPlacement();
				return;
			}
			if (e.key === 'Escape') {
				if (this.cropMode) {
					e.preventDefault();
					e.stopPropagation();
					this.cancelCrop();
					return;
				}
				if (this.selectedActionIndex >= 0) {
					this.selectedActionIndex = -1;
					this.redraw();
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				this._onDidCancel.fire();
				this.dispose();
			} else if (e.key === 'Enter' && this.cropMode) {
				e.preventDefault();
				this.commitCrop();
			} else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedActionIndex >= 0) {
				e.preventDefault();
				this.actions.splice(this.selectedActionIndex, 1);
				this.selectedActionIndex = -1;
				this.undoneActions.length = 0;
				this.redraw();
			}
		}));

		// Re-fit canvas when container resizes
		const resizeObserver = new ResizeObserver(() => {
			if (this.imageElement) {
				this.sizeCanvas();
				this.clampPan();
				this.canvas.style.transform = `translate(${this.panX}px, ${this.panY}px)`;
				this.redraw();
			}
		});
		resizeObserver.observe(canvasContainer);
		this.disposables.add({ dispose: () => resizeObserver.disconnect() });
	}

	private addToolButton(toolbar: HTMLElement, tool: AnnotationTool, label: string, icon: HTMLSpanElement): void {
		const btn = append(toolbar, $('button.tool-btn'));
		btn.appendChild(icon);
		btn.title = label;
		btn.setAttribute('aria-label', label);
		if (tool === this.activeTool) {
			btn.classList.add('active');
		}
		this.toolButtons.push({ element: btn, tool });
		this.disposables.add(addDisposableListener(btn, EventType.CLICK, () => {
			this.setActiveTool(tool);
		}));
	}

	private setActiveTool(tool: AnnotationTool): void {
		if (this.textEditState && tool !== AnnotationTool.Text) {
			this.commitTextEdit();
		}
		if (this.textPlacementState && tool !== AnnotationTool.Text) {
			this.cancelTextPlacement();
		}

		// Special handling for Crop: enter crop mode (don't change activeTool to Crop persistently)
		if (tool === AnnotationTool.Crop) {
			this.enterCropMode();
			return;
		}

		this.activeTool = tool;
		this.selectedActionIndex = -1;
		for (const tb of this.toolButtons) {
			tb.element.classList.toggle('active', tb.tool === tool);
		}
		this.canvas.style.cursor = tool === AnnotationTool.Select ? 'default' :
			tool === AnnotationTool.Pan ? 'grab' : 'crosshair';
		this.redraw();
	}

	private enterCropMode(): void {
		if (this.cropMode || !this.originalImage) {
			return;
		}
		// Save current state for cancel
		this.preCropState = {
			element: this.imageElement!,
			width: this.imageWidth,
			height: this.imageHeight,
			currentCrop: this.currentCrop,
		};
		// Switch to original image so user can expand crop region
		this.imageElement = this.originalImage.element;
		this.imageWidth = this.originalImage.width;
		this.imageHeight = this.originalImage.height;
		// Initial crop region = current crop (or full original)
		this.cropRegion = this.currentCrop
			? { ...this.currentCrop }
			: { x: 0, y: 0, width: this.originalImage.width, height: this.originalImage.height };
		this.cropMode = true;
		// Mark crop tool button active
		for (const tb of this.toolButtons) {
			tb.element.classList.toggle('active', tb.tool === AnnotationTool.Crop);
		}
		// Toggle toolbars
		if (this.mainToolbar) { this.mainToolbar.style.display = 'none'; }
		if (this.cropToolbar) { this.cropToolbar.style.display = ''; }
		// Reset zoom/pan to fit original
		this.hasUserZoomed = false;
		this.panX = 0;
		this.panY = 0;
		this.canvas.style.transform = '';
		this.canvas.style.cursor = 'default';
		this.sizeCanvas();
		this.redraw();
	}

	private exitCropMode(): void {
		this.cropMode = false;
		this.cropRegion = null;
		this.cropDragHandle = null;
		this.cropRegionStart = null;
		this.preCropState = null;
		// Restore main toolbar
		if (this.mainToolbar) { this.mainToolbar.style.display = ''; }
		if (this.cropToolbar) { this.cropToolbar.style.display = 'none'; }
		// Reactivate previous tool
		this.setActiveTool(this.activeTool);
	}

	private commitCrop(): void {
		if (!this.cropMode || !this.cropRegion || !this.originalImage) {
			return;
		}
		const cr = this.normalizeCropRect(this.cropRegion);
		if (cr.width < 10 || cr.height < 10) {
			return;
		}
		// Save pre-crop state for undo (the state that was active before entering crop mode)
		if (this.preCropState) {
			this.imageHistory.push({
				element: this.preCropState.element,
				width: this.preCropState.width,
				height: this.preCropState.height,
				currentCrop: this.preCropState.currentCrop,
			});
		}
		// Crop the original image to the new region
		const cropCanvas = mainWindow.document.createElement('canvas');
		cropCanvas.width = cr.width;
		cropCanvas.height = cr.height;
		const cropCtx = cropCanvas.getContext('2d')!;
		cropCtx.drawImage(this.originalImage.element, cr.x, cr.y, cr.width, cr.height, 0, 0, cr.width, cr.height);

		const croppedImg = mainWindow.document.createElement('img');
		croppedImg.onload = () => {
			this.imageElement = croppedImg;
			this.imageWidth = croppedImg.naturalWidth;
			this.imageHeight = croppedImg.naturalHeight;
			// Annotations live in original-image coords; just update currentCrop and they
			// stay anchored to the right pixels. No coordinate translation needed.
			this.currentCrop = cr;
			this.undoneActions.length = 0;
			this.hasUserZoomed = false;
			this.panX = 0;
			this.panY = 0;
			this.canvas.style.transform = '';
			this.exitCropMode();
			this.sizeCanvas();
			this.redraw();
		};
		croppedImg.src = cropCanvas.toDataURL('image/png');
	}

	private cancelCrop(): void {
		if (!this.cropMode || !this.preCropState) {
			this.exitCropMode();
			return;
		}
		// Restore the pre-crop displayed state. Annotations live in original coords
		// and don't need to be touched.
		this.imageElement = this.preCropState.element;
		this.imageWidth = this.preCropState.width;
		this.imageHeight = this.preCropState.height;
		this.currentCrop = this.preCropState.currentCrop;
		this.hasUserZoomed = false;
		this.panX = 0;
		this.panY = 0;
		this.canvas.style.transform = '';
		this.exitCropMode();
		this.sizeCanvas();
		this.redraw();
	}

	private loadImage(): void {
		const img = mainWindow.document.createElement('img');
		img.onload = () => {
			this.imageElement = img;
			this.imageWidth = img.naturalWidth;
			this.imageHeight = img.naturalHeight;
			// Preserve the original image so crops can be re-expanded
			this.originalImage = { element: img, width: img.naturalWidth, height: img.naturalHeight };
			this.currentCrop = null;
			this.sizeCanvas();
			this.redraw();
		};
		// Use original screenshot (not annotated) so we can re-crop from full original
		img.src = this.screenshot.dataUrl;
	}

	private sizeCanvas(): void {
		const container = this.canvas.parentElement;
		if (!container) {
			return;
		}

		const targetWindow = getWindow(this.canvas);
		const dpr = targetWindow.devicePixelRatio || 1;
		const maxWidth = container.clientWidth - 32;
		const maxHeight = container.clientHeight - 32;

		// Only auto-fit on initial load; respect user zoom after that
		if (!this.hasUserZoomed) {
			const scaleX = maxWidth / this.imageWidth;
			const scaleY = maxHeight / this.imageHeight;
			this.scale = Math.min(scaleX, scaleY, 1);
		}

		const displayWidth = Math.floor(this.imageWidth * this.scale);
		const displayHeight = Math.floor(this.imageHeight * this.scale);

		this.canvas.style.width = `${displayWidth}px`;
		this.canvas.style.height = `${displayHeight}px`;
		this.canvas.width = displayWidth * dpr;
		this.canvas.height = displayHeight * dpr;

		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	private canvasCoords(e: PointerEvent): { x: number; y: number } {
		const rect = this.canvas.getBoundingClientRect();
		return {
			x: (e.clientX - rect.left) / this.scale + this.cropOffsetX,
			y: (e.clientY - rect.top) / this.scale + this.cropOffsetY,
		};
	}

	private onPointerDown(e: PointerEvent): void {
		const pos = this.canvasCoords(e);

		// Crop mode: hit test handles or interior
		if (this.cropMode && this.cropRegion) {
			const handle = this.cropHandleHitTest(pos);
			if (handle) {
				this.cropDragHandle = handle;
				this.cropDragStart = pos;
				this.cropRegionStart = { ...this.cropRegion };
				this.canvas.setPointerCapture(e.pointerId);
			}
			return;
		}

		// Select tool: hit test and start drag
		if (this.activeTool === AnnotationTool.Select) {
			const hitIndex = this.hitTest(pos);
			this.selectedActionIndex = hitIndex;
			if (hitIndex >= 0) {
				const hitAction = this.actions[hitIndex];
				if (hitAction.type === AnnotationTool.Text && this.isNearTextResizeHandle(pos, hitAction)) {
					this.isResizingSelectedText = true;
					this.dragStart = { x: pos.x, y: pos.y };
					this.selectedTextResizeStartWidth = hitAction.textWidth ?? DEFAULT_TEXT_BOX_WIDTH;
					this.canvas.setPointerCapture(e.pointerId);
					this.canvas.style.cursor = 'ew-resize';
				} else {
					this.isDraggingSelected = true;
					this.dragStart = { x: pos.x, y: pos.y };
					this.canvas.setPointerCapture(e.pointerId);
					this.canvas.style.cursor = 'move';
				}
			}
			this.redraw();
			return;
		}

		// Deselect when using other tools
		this.selectedActionIndex = -1;

		// Text tool: drag to define width, then enter text editing.
		if (this.activeTool === AnnotationTool.Text) {
			this.commitTextEdit();
			this.textPlacementState = {
				start: pos,
				current: pos,
				pointerId: e.pointerId,
			};
			this.canvas.setPointerCapture(e.pointerId);
			this.redraw();
			return;
		}

		// Pan tool
		if (this.activeTool === AnnotationTool.Pan) {
			this.isPanning = true;
			this.lastPanPoint = { x: e.clientX, y: e.clientY };
			this.canvas.setPointerCapture(e.pointerId);
			this.canvas.style.cursor = 'grabbing';
			return;
		}

		this.isDrawing = true;
		this.canvas.setPointerCapture(e.pointerId);

		switch (this.activeTool) {
			case AnnotationTool.Freehand:
				this.currentAction = {
					type: AnnotationTool.Freehand,
					color: this.activeColor,
					lineWidth: 3,
					points: [pos],
				};
				break;
			case AnnotationTool.Rectangle:
				this.currentAction = {
					type: AnnotationTool.Rectangle,
					color: this.activeColor,
					lineWidth: 2,
					rect: { x: pos.x, y: pos.y, width: 0, height: 0 },
				};
				break;
			case AnnotationTool.Ellipse:
				this.currentAction = {
					type: AnnotationTool.Ellipse,
					color: this.activeColor,
					lineWidth: 2,
					ellipseRect: { x: pos.x, y: pos.y, width: 0, height: 0 },
				};
				break;
			case AnnotationTool.Arrow:
				this.currentAction = {
					type: AnnotationTool.Arrow,
					color: this.activeColor,
					lineWidth: 2,
					arrowStart: pos,
					arrowEnd: pos,
				};
				break;
		}
	}

	private onPointerMove(e: PointerEvent): void {
		// Crop mode: drag handle or move region; also update cursor
		if (this.cropMode) {
			const pos = this.canvasCoords(e);
			if (this.cropDragHandle && this.cropRegionStart) {
				this.updateCropRegion(pos);
				this.redraw();
				return;
			}
			// Update cursor based on hover
			const handle = this.cropHandleHitTest(pos);
			this.canvas.style.cursor = this.cropCursorFor(handle);
			return;
		}

		// Select tool: resize selected text
		if (this.isResizingSelectedText && this.selectedActionIndex >= 0) {
			const pos = this.canvasCoords(e);
			const action = this.actions[this.selectedActionIndex];
			if (action.type === AnnotationTool.Text) {
				action.textWidth = Math.max(MIN_TEXT_BOX_WIDTH, this.selectedTextResizeStartWidth + (pos.x - this.dragStart.x));
				this.redraw();
			}
			return;
		}

		// Select tool: move selected element
		if (this.isDraggingSelected && this.selectedActionIndex >= 0) {
			const pos = this.canvasCoords(e);
			const dx = pos.x - this.dragStart.x;
			const dy = pos.y - this.dragStart.y;
			this.moveAction(this.actions[this.selectedActionIndex], dx, dy);
			this.dragStart = { x: pos.x, y: pos.y };
			this.redraw();
			return;
		}

		// Pan
		if (this.isPanning) {
			const dx = e.clientX - this.lastPanPoint.x;
			const dy = e.clientY - this.lastPanPoint.y;
			this.panX += dx;
			this.panY += dy;
			this.lastPanPoint = { x: e.clientX, y: e.clientY };
			this.clampPan();
			this.canvas.style.transform = `translate(${this.panX}px, ${this.panY}px)`;
			return;
		}

		if (this.textPlacementState) {
			const pos = this.canvasCoords(e);
			this.textPlacementState.current = pos;
			this.redraw();
			return;
		}

		if (this.activeTool === AnnotationTool.Select && this.selectedActionIndex >= 0) {
			const pos = this.canvasCoords(e);
			const action = this.actions[this.selectedActionIndex];
			if (action.type === AnnotationTool.Text && this.isNearTextResizeHandle(pos, action)) {
				this.canvas.style.cursor = 'ew-resize';
			} else if (this.selectedActionIndex >= 0) {
				this.canvas.style.cursor = 'default';
			}
		}

		if (!this.isDrawing) {
			return;
		}

		const pos = this.canvasCoords(e);

		if (!this.currentAction) {
			return;
		}

		switch (this.currentAction.type) {
			case AnnotationTool.Freehand:
				this.currentAction.points!.push(pos);
				break;
			case AnnotationTool.Rectangle: {
				const rect = this.currentAction.rect!;
				// Mutate the rect on the current action (this is the in-progress drawing)
				(this.currentAction as { rect: { x: number; y: number; width: number; height: number } }).rect = {
					...rect,
					width: pos.x - rect.x,
					height: pos.y - rect.y,
				};
				break;
			}
			case AnnotationTool.Ellipse: {
				const er = this.currentAction.ellipseRect!;
				let w = pos.x - er.x;
				let h = pos.y - er.y;
				if (e.shiftKey) {
					const size = Math.max(Math.abs(w), Math.abs(h));
					w = Math.sign(w) * size;
					h = Math.sign(h) * size;
				}
				(this.currentAction as { ellipseRect: { x: number; y: number; width: number; height: number } }).ellipseRect = { ...er, width: w, height: h };
				break;
			}
			case AnnotationTool.Arrow:
				(this.currentAction as { arrowEnd: { x: number; y: number } }).arrowEnd = pos;
				break;
		}

		this.redraw();
	}

	private onPointerUp(e: PointerEvent): void {
		// Crop mode: end handle drag
		if (this.cropMode && this.cropDragHandle) {
			this.cropDragHandle = null;
			this.cropRegionStart = null;
			this.canvas.releasePointerCapture(e.pointerId);
			return;
		}

		// Select tool: end drag
		if (this.isResizingSelectedText) {
			this.isResizingSelectedText = false;
			this.canvas.releasePointerCapture(e.pointerId);
			this.canvas.style.cursor = 'default';
			return;
		}

		// Select tool: end drag
		if (this.isDraggingSelected) {
			this.isDraggingSelected = false;
			this.canvas.releasePointerCapture(e.pointerId);
			this.canvas.style.cursor = 'default';
			return;
		}

		// Pan
		if (this.isPanning) {
			this.isPanning = false;
			this.canvas.releasePointerCapture(e.pointerId);
			this.canvas.style.cursor = this.activeTool === AnnotationTool.Pan ? 'grab' : 'crosshair';
			return;
		}

		if (this.textPlacementState) {
			const { start, current, pointerId } = this.textPlacementState;
			if (pointerId === e.pointerId) {
				this.canvas.releasePointerCapture(e.pointerId);
			}
			const dx = current.x - start.x;
			const didDrag = Math.abs(dx) >= TEXT_DRAG_THRESHOLD;
			const x = didDrag ? Math.min(start.x, current.x) : start.x;
			const rawWidth = didDrag ? Math.abs(dx) : this.getMaxTextWidthFrom(start.x);
			const width = didDrag
				? Math.max(1, Math.min(rawWidth, this.getTextImageRight() - x))
				: rawWidth;
			const y = start.y;
			this.textPlacementState = null;
			this.startTextEdit({ x, y }, width, didDrag);
			return;
		}

		if (!this.isDrawing) {
			return;
		}
		this.canvas.releasePointerCapture(e.pointerId);
		this.isDrawing = false;

		if (this.currentAction) {
			this.actions.push(this.currentAction);
			this.undoneActions.length = 0;
			this.currentAction = null;
		}

		this.redraw();
	}

	private undo(): void {
		if (this.textPlacementState) {
			this.cancelTextPlacement();
			return;
		}
		if (this.textEditState) {
			this.cancelTextEdit();
			return;
		}
		const action = this.actions.pop();
		if (action) {
			this.undoneActions.push(action);
			this.redraw();
		} else if (this.imageHistory.length > 0) {
			// Undo crop
			const prev = this.imageHistory.pop()!;
			this.imageElement = prev.element;
			this.imageWidth = prev.width;
			this.imageHeight = prev.height;
			this.currentCrop = prev.currentCrop;
			this.hasUserZoomed = false;
			this.panX = 0;
			this.panY = 0;
			this.canvas.style.transform = '';
			this.sizeCanvas();
			this.redraw();
		}
	}

	private redo(): void {
		if (this.textPlacementState) {
			return;
		}
		if (this.textEditState) {
			return;
		}
		const action = this.undoneActions.pop();
		if (action) {
			this.actions.push(action);
			this.redraw();
		}
	}

	private cropHandleHitTest(pos: { x: number; y: number }): 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move' | null {
		if (!this.cropRegion) {
			return null;
		}
		const r = this.normalizeCropRect(this.cropRegion);
		// Convert handle pixel size to image coords
		const handlePx = 12;
		const tol = handlePx / this.scale;
		const cx = r.x + r.width / 2;
		const cy = r.y + r.height / 2;
		const handles: { name: 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'; x: number; y: number }[] = [
			{ name: 'nw', x: r.x, y: r.y },
			{ name: 'n', x: cx, y: r.y },
			{ name: 'ne', x: r.x + r.width, y: r.y },
			{ name: 'e', x: r.x + r.width, y: cy },
			{ name: 'se', x: r.x + r.width, y: r.y + r.height },
			{ name: 's', x: cx, y: r.y + r.height },
			{ name: 'sw', x: r.x, y: r.y + r.height },
			{ name: 'w', x: r.x, y: cy },
		];
		for (const h of handles) {
			if (Math.abs(pos.x - h.x) <= tol && Math.abs(pos.y - h.y) <= tol) {
				return h.name;
			}
		}
		// Inside region → move
		if (pos.x >= r.x && pos.x <= r.x + r.width && pos.y >= r.y && pos.y <= r.y + r.height) {
			return 'move';
		}
		return null;
	}

	private cropCursorFor(handle: 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move' | null): string {
		switch (handle) {
			case 'nw':
			case 'se': return 'nwse-resize';
			case 'ne':
			case 'sw': return 'nesw-resize';
			case 'n':
			case 's': return 'ns-resize';
			case 'e':
			case 'w': return 'ew-resize';
			case 'move': return 'move';
			default: return 'default';
		}
	}

	private updateCropRegion(pos: { x: number; y: number }): void {
		if (!this.cropRegionStart || !this.cropDragHandle) {
			return;
		}
		const dx = pos.x - this.cropDragStart.x;
		const dy = pos.y - this.cropDragStart.y;
		const start = this.cropRegionStart;
		let { x, y, width, height } = start;
		switch (this.cropDragHandle) {
			case 'move':
				x += dx;
				y += dy;
				break;
			case 'nw':
				x += dx; y += dy; width -= dx; height -= dy;
				break;
			case 'n':
				y += dy; height -= dy;
				break;
			case 'ne':
				y += dy; width += dx; height -= dy;
				break;
			case 'e':
				width += dx;
				break;
			case 'se':
				width += dx; height += dy;
				break;
			case 's':
				height += dy;
				break;
			case 'sw':
				x += dx; width -= dx; height += dy;
				break;
			case 'w':
				x += dx; width -= dx;
				break;
		}
		// Clamp to image bounds
		x = Math.max(0, Math.min(this.imageWidth, x));
		y = Math.max(0, Math.min(this.imageHeight, y));
		width = Math.max(10, Math.min(this.imageWidth - x, width));
		height = Math.max(10, Math.min(this.imageHeight - y, height));
		this.cropRegion = { x, y, width, height };
	}

	private normalizeCropRect(r: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
		return {
			x: r.width < 0 ? r.x + r.width : r.x,
			y: r.height < 0 ? r.y + r.height : r.y,
			width: Math.abs(r.width),
			height: Math.abs(r.height),
		};
	}

	private startTextEdit(pos: { x: number; y: number }, width: number, showBoxOutline: boolean): void {
		this.commitTextEdit();

		const editor = mainWindow.document.createElement('textarea');
		editor.setAttribute('aria-label', localize('typeText', "Type text"));
		editor.setAttribute('wrap', 'off');
		editor.style.position = 'fixed';
		editor.style.left = '-10000px';
		editor.style.top = '0';
		editor.style.width = '1px';
		editor.style.height = '1px';
		editor.style.opacity = '0';
		editor.style.pointerEvents = 'none';
		editor.style.padding = '0';
		editor.style.border = '0';
		editor.style.margin = '0';
		editor.style.resize = 'none';
		editor.style.overflow = 'hidden';
		this.container.appendChild(editor);

		this.textEditState = {
			pos,
			text: '',
			caretIndex: 0,
			color: this.activeColor,
			fontSize: this.activeFontSize,
			fontFamily: this.activeFontFamily,
			width,
			showBoxOutline,
		};
		this.textEditor = editor;
		this.startTextCaretBlink();

		const sync = () => {
			if (!this.textEditState || this.textEditor !== editor) {
				return;
			}
			this.textEditState.text = editor.value;
			this.textEditState.caretIndex = editor.selectionStart ?? editor.value.length;
			this.textCaretVisible = true;
			this.redraw();
		};

		editor.addEventListener('input', sync);
		editor.addEventListener('keyup', sync);
		editor.addEventListener('click', sync);
		editor.addEventListener('select', sync);
		editor.addEventListener('keydown', e => {
			e.stopPropagation();
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				this.commitTextEdit();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this.cancelTextEdit();
			}
		});
		editor.addEventListener('blur', () => {
			if (this.textEditor === editor) {
				this.commitTextEdit();
			}
		});

		setTimeout(() => {
			if (this.textEditor === editor) {
				editor.focus();
				editor.setSelectionRange(editor.value.length, editor.value.length);
			}
		}, 0);

		this.redraw();
	}

	private startTextCaretBlink(): void {
		if (this.textCaretInterval !== null) {
			getWindow(this.container).clearInterval(this.textCaretInterval);
		}
		this.textCaretVisible = true;
		this.textCaretInterval = getWindow(this.container).setInterval(() => {
			if (!this.textEditState) {
				return;
			}
			this.textCaretVisible = !this.textCaretVisible;
			this.redraw();
		}, 500);
	}

	private stopTextCaretBlink(): void {
		if (this.textCaretInterval !== null) {
			getWindow(this.container).clearInterval(this.textCaretInterval);
			this.textCaretInterval = null;
		}
		this.textCaretVisible = true;
	}

	private commitTextEdit(): void {
		if (!this.textEditState) {
			return;
		}

		const { text, pos, color, fontFamily, fontSize, width } = this.textEditState;
		this.cleanupTextEditor();
		if (text.trim()) {
			this.actions.push({
				type: AnnotationTool.Text,
				color,
				lineWidth: 1,
				fontSize,
				fontFamily,
				text,
				textPos: pos,
				textWidth: width,
			});
			this.undoneActions.length = 0;
		}
		this.redraw();
	}

	private cancelTextEdit(): void {
		if (!this.textEditState) {
			return;
		}
		this.cleanupTextEditor();
		this.redraw();
	}

	private cancelTextPlacement(): void {
		if (!this.textPlacementState) {
			return;
		}
		if (this.canvas.hasPointerCapture(this.textPlacementState.pointerId)) {
			this.canvas.releasePointerCapture(this.textPlacementState.pointerId);
		}
		this.textPlacementState = null;
		this.redraw();
	}

	private getTextImageRight(): number {
		return this.cropOffsetX + this.imageWidth;
	}

	private getMaxTextWidthFrom(startX: number): number {
		return Math.max(1, this.getTextImageRight() - startX);
	}

	private cleanupTextEditor(): void {
		this.stopTextCaretBlink();
		this.textEditor?.remove();
		this.textEditor = null;
		this.textEditState = null;
		this.container.focus();
	}

	private redraw(): void {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

		// Draw background image
		if (this.imageElement) {
			this.ctx.drawImage(this.imageElement, 0, 0, this.imageWidth * this.scale, this.imageHeight * this.scale);
		}

		// Annotations are stored in original-image coords; translate so they appear correctly
		// over the (possibly cropped) displayed image.
		this.ctx.save();
		this.ctx.translate(-this.cropOffsetX * this.scale, -this.cropOffsetY * this.scale);

		// Draw all completed annotations
		for (const action of this.actions) {
			this.drawAction(action);
		}

		// Draw selection highlight
		if (this.selectedActionIndex >= 0 && this.selectedActionIndex < this.actions.length) {
			this.drawSelectionHighlight(this.actions[this.selectedActionIndex]);
		}

		// Draw current in-progress annotation
		if (this.currentAction) {
			this.drawAction(this.currentAction);
		}

		if (this.textEditState) {
			this.drawTextEditState();
		}

		if (this.textPlacementState) {
			this.drawTextPlacementState();
		}

		this.ctx.restore();

		// Draw crop overlay with handles
		if (this.cropMode && this.cropRegion) {
			const r = this.normalizeCropRect(this.cropRegion);
			const dpr = getWindow(this.canvas).devicePixelRatio || 1;
			const cw = this.canvas.width / dpr;
			const ch = this.canvas.height / dpr;
			const rx = r.x * this.scale;
			const ry = r.y * this.scale;
			const rw = r.width * this.scale;
			const rh = r.height * this.scale;

			this.ctx.save();
			// Dim area outside crop
			this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
			this.ctx.fillRect(0, 0, cw, ry);                            // top
			this.ctx.fillRect(0, ry + rh, cw, ch - (ry + rh));          // bottom
			this.ctx.fillRect(0, ry, rx, rh);                           // left
			this.ctx.fillRect(rx + rw, ry, cw - (rx + rw), rh);         // right

			// Draw crop border
			this.ctx.strokeStyle = '#ffffff';
			this.ctx.lineWidth = 1;
			this.ctx.strokeRect(rx, ry, rw, rh);

			// Draw 8 handles (corner squares)
			const handleSize = 10;
			const half = handleSize / 2;
			const handles: { x: number; y: number }[] = [
				{ x: rx, y: ry },                 // nw
				{ x: rx + rw / 2, y: ry },        // n
				{ x: rx + rw, y: ry },            // ne
				{ x: rx + rw, y: ry + rh / 2 },   // e
				{ x: rx + rw, y: ry + rh },       // se
				{ x: rx + rw / 2, y: ry + rh },   // s
				{ x: rx, y: ry + rh },            // sw
				{ x: rx, y: ry + rh / 2 },        // w
			];
			this.ctx.fillStyle = '#ffffff';
			this.ctx.strokeStyle = '#000000';
			this.ctx.lineWidth = 1;
			for (const h of handles) {
				this.ctx.fillRect(h.x - half, h.y - half, handleSize, handleSize);
				this.ctx.strokeRect(h.x - half, h.y - half, handleSize, handleSize);
			}
			this.ctx.restore();
		}
	}

	private drawAction(action: DrawAction): void {
		this.ctx.save();
		this.ctx.strokeStyle = action.color;
		this.ctx.fillStyle = action.color;
		this.ctx.lineWidth = action.lineWidth * this.scale;
		this.ctx.lineCap = 'round';
		this.ctx.lineJoin = 'round';

		switch (action.type) {
			case AnnotationTool.Freehand:
				if (action.points && action.points.length > 0) {
					this.ctx.beginPath();
					this.ctx.moveTo(action.points[0].x * this.scale, action.points[0].y * this.scale);
					for (let i = 1; i < action.points.length; i++) {
						this.ctx.lineTo(action.points[i].x * this.scale, action.points[i].y * this.scale);
					}
					this.ctx.stroke();
				}
				break;

			case AnnotationTool.Rectangle:
				if (action.rect) {
					this.ctx.strokeRect(
						action.rect.x * this.scale,
						action.rect.y * this.scale,
						action.rect.width * this.scale,
						action.rect.height * this.scale,
					);
				}
				break;

			case AnnotationTool.Ellipse:
				if (action.ellipseRect) {
					const r = action.ellipseRect;
					const cx = (r.x + r.width / 2) * this.scale;
					const cy = (r.y + r.height / 2) * this.scale;
					const rx = Math.abs(r.width / 2) * this.scale;
					const ry = Math.abs(r.height / 2) * this.scale;
					this.ctx.beginPath();
					this.ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
					this.ctx.stroke();
				}
				break;

			case AnnotationTool.Arrow:
				if (action.arrowStart && action.arrowEnd) {
					this.drawArrow(
						action.arrowStart.x * this.scale,
						action.arrowStart.y * this.scale,
						action.arrowEnd.x * this.scale,
						action.arrowEnd.y * this.scale,
					);
				}
				break;

			case AnnotationTool.Text:
				if (action.text && action.textPos) {
					const fontSize = (action.fontSize || 16) * this.scale;
					const fontFamily = action.fontFamily || 'sans-serif';
					const width = (action.textWidth ?? DEFAULT_TEXT_BOX_WIDTH) * this.scale;
					this.ctx.font = `${fontSize}px ${fontFamily}`;
					this.ctx.textBaseline = 'alphabetic';
					this.drawWrappedText(action.text, action.textPos.x * this.scale, action.textPos.y * this.scale, width, fontSize, fontFamily);
				}
				break;
		}

		this.ctx.restore();
	}

	private drawTextEditState(): void {
		if (!this.textEditState) {
			return;
		}

		const { pos, text, color, fontFamily, fontSize, caretIndex, width, showBoxOutline } = this.textEditState;
		const scaledFontSize = fontSize * this.scale;
		const scaledWidth = width * this.scale;
		this.ctx.save();
		this.ctx.fillStyle = color;
		this.ctx.strokeStyle = color;
		this.ctx.lineWidth = Math.max(1, this.scale);
		this.ctx.font = `${scaledFontSize}px ${fontFamily}`;
		this.ctx.textBaseline = 'alphabetic';
		const layout = this.drawWrappedText(text, pos.x * this.scale, pos.y * this.scale, scaledWidth, scaledFontSize, fontFamily);

		if (showBoxOutline) {
			this.ctx.setLineDash([4, 4]);
			this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
			this.ctx.strokeRect(
				pos.x * this.scale,
				pos.y * this.scale - scaledFontSize,
				scaledWidth,
				Math.max(layout.height, scaledFontSize * 1.2),
			);
			this.ctx.setLineDash([]);
		}

		if (this.textCaretVisible) {
			const caret = this.getTextCaretMetrics(text, caretIndex, scaledWidth, scaledFontSize, fontFamily);
			const caretX = pos.x * this.scale + caret.x;
			const baselineY = pos.y * this.scale + caret.baselineOffsetY;
			this.ctx.beginPath();
			this.ctx.moveTo(caretX, baselineY - scaledFontSize);
			this.ctx.lineTo(caretX, baselineY + Math.max(2, this.scale));
			this.ctx.stroke();
		}
		this.ctx.restore();
	}

	private drawTextPlacementState(): void {
		if (!this.textPlacementState) {
			return;
		}
		const { start, current } = this.textPlacementState;
		const dx = current.x - start.x;
		const didDrag = Math.abs(dx) >= TEXT_DRAG_THRESHOLD;
		if (!didDrag) {
			return;
		}
		const x = Math.min(start.x, current.x);
		const width = Math.max(1, Math.min(Math.abs(dx), this.getTextImageRight() - x));
		const y = (start.y - this.activeFontSize) * this.scale;
		const height = this.activeFontSize * this.scale * 1.2;
		this.ctx.save();
		this.ctx.setLineDash([4, 4]);
		this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
		this.ctx.lineWidth = Math.max(1, this.scale);
		this.ctx.strokeRect(x * this.scale, y, width * this.scale, height);
		this.ctx.setLineDash([]);
		this.ctx.restore();
	}

	private drawWrappedText(text: string, x: number, baselineY: number, maxWidth: number, fontSize: number, fontFamily: string): { width: number; height: number; lineHeight: number } {
		const layout = this.measureWrappedText(text, maxWidth, fontSize, fontFamily);
		const lineHeight = layout.lineHeight;
		for (let i = 0; i < layout.lines.length; i++) {
			const line = layout.lines[i];
			this.ctx.fillText(line.text, x, baselineY + i * lineHeight);
		}
		return {
			width: layout.width,
			height: layout.height,
			lineHeight,
		};
	}

	private getTextCaretMetrics(text: string, caretIndex: number, maxWidth: number, fontSize: number, fontFamily: string): { x: number; baselineOffsetY: number } {
		const layout = this.measureWrappedText(text, maxWidth, fontSize, fontFamily);
		const line = [...layout.lines].reverse().find(candidate => candidate.startIndex <= caretIndex) ?? layout.lines[0];
		const safeCaretIndex = Math.min(Math.max(caretIndex, line.startIndex), line.endIndex);
		const beforeCaret = line.text.slice(0, safeCaretIndex - line.startIndex);
		this.ctx.save();
		this.ctx.font = `${fontSize}px ${fontFamily}`;
		const x = this.ctx.measureText(beforeCaret).width;
		this.ctx.restore();
		return {
			x,
			baselineOffsetY: line.lineIndex * layout.lineHeight,
		};
	}

	private measureWrappedText(text: string, maxWidth: number, fontSize: number, fontFamily: string): { lines: { text: string; startIndex: number; endIndex: number; lineIndex: number }[]; width: number; height: number; lineHeight: number } {
		this.ctx.save();
		this.ctx.font = `${fontSize}px ${fontFamily}`;
		const lineHeight = fontSize * 1.2;
		const lines: { text: string; startIndex: number; endIndex: number; lineIndex: number }[] = [];
		const paragraphs = text.split('\n');
		let globalIndex = 0;
		let lineIndex = 0;
		let maxLineWidth = 0;

		for (let p = 0; p < paragraphs.length; p++) {
			const paragraph = paragraphs[p];
			const paragraphStart = globalIndex;
			const paragraphEnd = paragraphStart + paragraph.length;

			if (paragraph.length === 0) {
				lines.push({ text: '', startIndex: paragraphStart, endIndex: paragraphStart, lineIndex });
				lineIndex++;
			} else {
				let lineStart = paragraphStart;
				while (lineStart < paragraphEnd) {
					let bestEnd = lineStart + 1;
					let lastWhitespaceBreak = -1;
					for (let i = lineStart + 1; i <= paragraphEnd; i++) {
						const candidate = text.slice(lineStart, i);
						if (this.ctx.measureText(candidate).width <= maxWidth) {
							bestEnd = i;
							if (/\s/.test(text[i - 1])) {
								lastWhitespaceBreak = i;
							}
						} else {
							break;
						}
					}

					let lineEnd = bestEnd;
					if (bestEnd < paragraphEnd && lastWhitespaceBreak > lineStart) {
						lineEnd = lastWhitespaceBreak;
					}
					if (lineEnd <= lineStart) {
						lineEnd = lineStart + 1;
					}

					const rawLineText = text.slice(lineStart, lineEnd);
					const lineText = rawLineText.replace(/\s+$/u, '');
					lines.push({ text: lineText, startIndex: lineStart, endIndex: lineEnd, lineIndex });
					maxLineWidth = Math.max(maxLineWidth, this.ctx.measureText(lineText).width);
					lineIndex++;

					lineStart = lineEnd;
					while (lineStart < paragraphEnd && /\s/u.test(text[lineStart])) {
						lineStart++;
					}
				}
			}

			globalIndex = paragraphEnd + 1;
		}

		if (lines.length === 0) {
			lines.push({ text: '', startIndex: 0, endIndex: 0, lineIndex: 0 });
		}

		if (maxLineWidth === 0) {
			for (const line of lines) {
				maxLineWidth = Math.max(maxLineWidth, this.ctx.measureText(line.text).width);
			}
		}
		this.ctx.restore();
		return {
			lines,
			width: Math.max(maxLineWidth, maxWidth),
			height: lines.length * lineHeight,
			lineHeight,
		};
	}

	private hitTest(pos: { x: number; y: number }): number {
		for (let i = this.actions.length - 1; i >= 0; i--) {
			if (this.isPointOnAction(pos, this.actions[i])) {
				return i;
			}
		}
		return -1;
	}

	private isPointOnAction(pos: { x: number; y: number }, action: DrawAction): boolean {
		const threshold = 8;
		switch (action.type) {
			case AnnotationTool.Freehand:
				if (action.points) {
					for (let i = 1; i < action.points.length; i++) {
						if (this.pointToSegmentDist(pos, action.points[i - 1], action.points[i]) < threshold) {
							return true;
						}
					}
				}
				return false;
			case AnnotationTool.Rectangle:
				if (action.rect) {
					const r = action.rect;
					const nx = Math.min(r.x, r.x + r.width);
					const ny = Math.min(r.y, r.y + r.height);
					const nw = Math.abs(r.width);
					const nh = Math.abs(r.height);
					return pos.x >= nx - threshold && pos.x <= nx + nw + threshold &&
						pos.y >= ny - threshold && pos.y <= ny + nh + threshold;
				}
				return false;
			case AnnotationTool.Ellipse:
				if (action.ellipseRect) {
					const er = action.ellipseRect;
					const cx = er.x + er.width / 2;
					const cy = er.y + er.height / 2;
					const rx = Math.abs(er.width / 2);
					const ry = Math.abs(er.height / 2);
					if (rx < 1 || ry < 1) {
						return false;
					}
					// Normalized distance from center
					const dx = (pos.x - cx) / rx;
					const dy = (pos.y - cy) / ry;
					const dist = Math.sqrt(dx * dx + dy * dy);
					// Check if point is near the ellipse border (dist ≈ 1)
					const normalizedThreshold = threshold / Math.min(rx, ry);
					return Math.abs(dist - 1) < normalizedThreshold;
				}
				return false;
			case AnnotationTool.Arrow:
				if (action.arrowStart && action.arrowEnd) {
					return this.pointToSegmentDist(pos, action.arrowStart, action.arrowEnd) < threshold;
				}
				return false;
			case AnnotationTool.Text:
				if (action.text && action.textPos) {
					const bounds = this.getActionBounds(action);
					if (!bounds) {
						return false;
					}
					return pos.x >= action.textPos.x - threshold &&
						pos.x <= bounds.x + bounds.width + threshold &&
						pos.y >= bounds.y - threshold &&
						pos.y <= bounds.y + bounds.height + threshold;
				}
				return false;
		}
		return false;
	}

	private pointToSegmentDist(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const lengthSq = dx * dx + dy * dy;
		if (lengthSq === 0) {
			return Math.hypot(p.x - a.x, p.y - a.y);
		}
		let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
		t = Math.max(0, Math.min(1, t));
		const projX = a.x + t * dx;
		const projY = a.y + t * dy;
		return Math.hypot(p.x - projX, p.y - projY);
	}

	private moveAction(action: DrawAction, dx: number, dy: number): void {
		switch (action.type) {
			case AnnotationTool.Freehand:
				if (action.points) {
					for (const pt of action.points) {
						pt.x += dx;
						pt.y += dy;
					}
				}
				break;
			case AnnotationTool.Rectangle:
				if (action.rect) {
					action.rect.x += dx;
					action.rect.y += dy;
				}
				break;
			case AnnotationTool.Ellipse:
				if (action.ellipseRect) {
					action.ellipseRect.x += dx;
					action.ellipseRect.y += dy;
				}
				break;
			case AnnotationTool.Arrow:
				if (action.arrowStart) {
					action.arrowStart.x += dx;
					action.arrowStart.y += dy;
				}
				if (action.arrowEnd) {
					action.arrowEnd.x += dx;
					action.arrowEnd.y += dy;
				}
				break;
			case AnnotationTool.Text:
				if (action.textPos) {
					action.textPos.x += dx;
					action.textPos.y += dy;
				}
				break;
		}
	}

	private drawSelectionHighlight(action: DrawAction): void {
		this.ctx.save();
		this.ctx.strokeStyle = '#007acc';
		this.ctx.lineWidth = 1;
		this.ctx.setLineDash([4, 4]);
		const pad = 6;
		const bounds = this.getActionBounds(action);
		if (bounds) {
			this.ctx.strokeRect(
				(bounds.x - pad) * this.scale,
				(bounds.y - pad) * this.scale,
				(bounds.width + pad * 2) * this.scale,
				(bounds.height + pad * 2) * this.scale,
			);
			if (action.type === AnnotationTool.Text) {
				const handleSize = 8;
				const handleX = (bounds.x + bounds.width + pad) * this.scale;
				const handleY = (bounds.y + bounds.height / 2) * this.scale;
				this.ctx.fillStyle = '#007acc';
				this.ctx.fillRect(handleX - handleSize / 2, handleY - handleSize / 2, handleSize, handleSize);
			}
		}
		this.ctx.setLineDash([]);
		this.ctx.restore();
	}

	private isNearTextResizeHandle(pos: { x: number; y: number }, action: DrawAction): boolean {
		if (action.type !== AnnotationTool.Text) {
			return false;
		}
		const bounds = this.getActionBounds(action);
		if (!bounds) {
			return false;
		}
		const threshold = 8;
		const handleX = bounds.x + bounds.width;
		const handleY = bounds.y + bounds.height / 2;
		return Math.abs(pos.x - handleX) <= threshold && Math.abs(pos.y - handleY) <= threshold * 2;
	}

	private getActionBounds(action: DrawAction): { x: number; y: number; width: number; height: number } | null {
		switch (action.type) {
			case AnnotationTool.Freehand:
				if (action.points && action.points.length > 0) {
					let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
					for (const pt of action.points) {
						minX = Math.min(minX, pt.x);
						minY = Math.min(minY, pt.y);
						maxX = Math.max(maxX, pt.x);
						maxY = Math.max(maxY, pt.y);
					}
					return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
				}
				return null;
			case AnnotationTool.Rectangle:
				if (action.rect) {
					const r = action.rect;
					return {
						x: Math.min(r.x, r.x + r.width),
						y: Math.min(r.y, r.y + r.height),
						width: Math.abs(r.width),
						height: Math.abs(r.height),
					};
				}
				return null;
			case AnnotationTool.Ellipse:
				if (action.ellipseRect) {
					const er = action.ellipseRect;
					return {
						x: Math.min(er.x, er.x + er.width),
						y: Math.min(er.y, er.y + er.height),
						width: Math.abs(er.width),
						height: Math.abs(er.height),
					};
				}
				return null;
			case AnnotationTool.Arrow:
				if (action.arrowStart && action.arrowEnd) {
					const minX = Math.min(action.arrowStart.x, action.arrowEnd.x);
					const minY = Math.min(action.arrowStart.y, action.arrowEnd.y);
					const maxX = Math.max(action.arrowStart.x, action.arrowEnd.x);
					const maxY = Math.max(action.arrowStart.y, action.arrowEnd.y);
					return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
				}
				return null;
			case AnnotationTool.Text:
				if (action.text && action.textPos) {
					const fontSize = action.fontSize || 16;
					const fontFamily = action.fontFamily || 'sans-serif';
					const textWidth = action.textWidth ?? DEFAULT_TEXT_BOX_WIDTH;
					const layout = this.measureWrappedText(action.text, textWidth, fontSize, fontFamily);
					return {
						x: action.textPos.x,
						y: action.textPos.y - fontSize,
						width: textWidth,
						height: layout.height,
					};
				}
				return null;
		}
		return null;
	}

	private drawArrow(fromX: number, fromY: number, toX: number, toY: number): void {
		const headLength = 12 * this.scale;
		const angle = Math.atan2(toY - fromY, toX - fromX);

		this.ctx.beginPath();
		this.ctx.moveTo(fromX, fromY);
		this.ctx.lineTo(toX, toY);
		this.ctx.stroke();

		// Arrowhead
		this.ctx.beginPath();
		this.ctx.moveTo(toX, toY);
		this.ctx.lineTo(
			toX - headLength * Math.cos(angle - Math.PI / 6),
			toY - headLength * Math.sin(angle - Math.PI / 6),
		);
		this.ctx.lineTo(
			toX - headLength * Math.cos(angle + Math.PI / 6),
			toY - headLength * Math.sin(angle + Math.PI / 6),
		);
		this.ctx.closePath();
		this.ctx.fill();
	}

	private clampPan(): void {
		const container = this.canvas.parentElement;
		if (!container) {
			return;
		}
		const imgW = this.imageWidth * this.scale;
		const imgH = this.imageHeight * this.scale;
		const cW = container.clientWidth;
		const cH = container.clientHeight;
		// Allow panning freely but reset if less than 10% of image is visible
		const minVisiblePx = 50;
		const maxPanX = Math.max(imgW - minVisiblePx, cW - minVisiblePx);
		const maxPanY = Math.max(imgH - minVisiblePx, cH - minVisiblePx);
		this.panX = Math.max(-maxPanX, Math.min(maxPanX, this.panX));
		this.panY = Math.max(-maxPanY, Math.min(maxPanY, this.panY));
	}

	private compositeToDataUrl(): string {
		// Create a final canvas at full resolution
		const finalCanvas = mainWindow.document.createElement('canvas');
		finalCanvas.width = this.imageWidth;
		finalCanvas.height = this.imageHeight;
		const ctx = finalCanvas.getContext('2d')!;

		// Draw background image
		if (this.imageElement) {
			ctx.drawImage(this.imageElement, 0, 0, this.imageWidth, this.imageHeight);
		}

		// Replay annotations at full resolution. Actions are in original-image coords;
		// translate by -currentCrop offset so they land correctly on the cropped output.
		const savedScale = this.scale;
		this.scale = 1;
		const savedCtx = this.ctx;
		this.ctx = ctx;

		const offX = this.currentCrop?.x ?? 0;
		const offY = this.currentCrop?.y ?? 0;
		ctx.save();
		ctx.translate(-offX, -offY);
		for (const action of this.actions) {
			this.drawAction(action);
		}
		ctx.restore();

		this.ctx = savedCtx;
		this.scale = savedScale;

		return finalCanvas.toDataURL('image/png');
	}

	dispose(): void {
		this.cancelTextPlacement();
		this.cleanupTextEditor();
		this.container.remove();
		this.disposables.dispose();
		this._onDidSave.dispose();
		this._onDidCancel.dispose();
	}
}
