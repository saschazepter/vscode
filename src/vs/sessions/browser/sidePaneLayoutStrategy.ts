/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISerializableView, ISerializedNode, IViewSize, SerializableGrid } from '../../base/browser/ui/grid/grid.js';
import { Disposable, IDisposable } from '../../base/common/lifecycle.js';
import { EditorPart } from '../../workbench/browser/parts/editor/editorPart.js';
import { Part } from '../../workbench/browser/part.js';
import { Parts } from '../../workbench/services/layout/browser/layoutService.js';
import { DockedAuxiliaryBarController } from './dockedAuxiliaryBarController.js';

/** Visibility of each workbench part in the Agents window layout. */
export interface IPartVisibilityState {
	sidebar: boolean;
	auxiliaryBar: boolean;
	editor: boolean;
	panel: boolean;
	sessions: boolean;
}

/**
 * Callback surface the workbench exposes to a {@link ISidePaneLayoutStrategy} so
 * the strategy can drive the grid, part visibility, and editor layout without the
 * `Workbench` class branching on the layout mode.
 */
export interface ISidePaneLayoutHost {
	readonly workbenchGrid: SerializableGrid<ISerializableView>;
	readonly editorPartView: ISerializableView;
	readonly auxiliaryBarPartView: ISerializableView;
	readonly sessionsPartView: ISerializableView;
	readonly sideBarPartView: ISerializableView;
	readonly mainContainer: HTMLElement;
	readonly partVisibility: IPartVisibilityState;
	readonly editorPartContainer: HTMLElement | undefined;
	hasAppliedInitialEditorSplit: boolean;
	readonly isEditorPartAutoVisibilitySuppressed: boolean;
	getAuxiliaryBarPart(): Part;
	getEditorMainPart(): EditorPart;
	fireDidChangePartVisibility(partId: Parts, visible: boolean): void;
	notifyContainerDidLayout(): void;
	savePartVisibility(): void;
	applyEditorEvenSplit(mainAreaWidthBeforeReveal: number): void;
	setEditorRevealedExplicitly(value: boolean): void;
	setMainEditorAreaHiddenClass(hidden: boolean): void;
	setEditorHidden(hidden: boolean, explicit?: boolean): void;
	setAuxiliaryBarHidden(hidden: boolean): void;
	rememberAttachedEditorMaximizedState(): void;
	suppressEditorPartAutoVisibility(): IDisposable;
	isAuxViewContainerActive(containerId: string): boolean;
}

/** Opaque per-transition capture returned by {@link ISidePaneLayoutStrategy.prepareSideBarResize}. */
export interface ISideBarResizeContext { }

/**
 * Presentation strategy for the Agents window side pane (editor + auxiliary bar).
 * Encapsulates the differences between the classic grid layout and the single-pane
 * docked detail-panel layout so the workbench delegates instead of branching.
 */
export interface ISidePaneLayoutStrategy extends IDisposable {

	/** CSS marker + class the workbench applies to the main container. */
	applyContainerClass(container: HTMLElement): void;

	// --- Geometry ---

	/** Width the auxiliary bar occupies when visible (for max-editor-dimension math). */
	getAuxiliaryBarLayoutWidth(): number;
	/** Current auxiliary-bar view size. */
	getAuxiliaryBarSize(): IViewSize;
	/** Set the auxiliary-bar view size. */
	setAuxiliaryBarSize(size: IViewSize): void;
	/** Grow/shrink the auxiliary bar by a delta. */
	resizeAuxiliaryBar(deltaWidth: number, deltaHeight: number): void;
	/** Restore the persisted auxiliary-bar width during startup (before the grid exists). */
	restoreAuxiliaryBarWidth(width: number): void;
	/** Transform the grid editor width into the width persisted for the editor part. */
	getPersistedEditorWidth(editorGridWidth: number | undefined): number | undefined;
	/** The auxiliary-bar width persisted for the layout, given the grid-computed value. */
	getPersistedAuxiliaryBarWidth(gridWidth: number | undefined): number | undefined;

	// --- Grid descriptor ---

	getDefaultSideBarSize(policySideBarSize: number): number;
	getEditorNodeSize(effectiveEditorWidth: number, effectiveAuxBarWidth: number): number;
	isEditorNodeVisible(editorVisible: boolean, auxBarVisible: boolean): boolean;
	getTopRightSectionChildren(sessionsNode: ISerializedNode, editorNode: ISerializedNode, auxiliaryBarNode: ISerializedNode): ISerializedNode[];

	// --- Lifecycle & grid events ---

	/** Create any per-strategy controllers once the editor part container exists. */
	attach(): void;
	/** Lay out any docked overlay. */
	layout(): void;
	/** React to a whole-grid change (e.g. a sash drag) after the grid rebuilds. */
	onGridDidChange(): void;
	/** React to the editor grid node being resized to `nodeWidth`. */
	onEditorNodeResized(nodeWidth: number): void;

	// --- Visibility mutators ---

	/** Run editor-node work with the reveal-sync suspended (no-op for the grid layout). */
	suspendEditorNodeResizeSync(fn: () => void): void;
	/** Apply the editor part's grid visibility for the given hidden state. */
	applyEditorVisibility(hidden: boolean): void;
	/** Hook before the auxiliary bar is hidden. */
	onWillHideAuxiliaryBar(hidden: boolean): void;
	/** Apply the auxiliary bar's grid visibility for the given hidden state. */
	applyAuxiliaryBarVisibility(hidden: boolean): void;
	/** Whether a pane composite should be force-opened when the auxiliary bar is revealed. */
	shouldOpenAuxiliaryPaneComposite(containerId: string): boolean;
	/** Close the whole side pane when the last editor in the main part closes. */
	handleAllEditorsClosed(): void;
	/** Capture the pre-change state needed to resize the docked side pane on a sidebar toggle. */
	prepareSideBarResize(hidden: boolean): ISideBarResizeContext;
	/** Apply the docked side-pane resize after a sidebar toggle. */
	applySideBarResize(hidden: boolean, context: ISideBarResizeContext): void;
}

/**
 * Classic layout: the auxiliary bar is its own trailing grid column and the
 * editor part behaves like a standard grid view.
 */
export class GridSidePaneStrategy extends Disposable implements ISidePaneLayoutStrategy {

	constructor(private readonly host: ISidePaneLayoutHost) {
		super();
	}

	applyContainerClass(container: HTMLElement): void {
		container.classList.toggle('dock-detail-panel', false);
	}

	getAuxiliaryBarLayoutWidth(): number {
		return this.host.workbenchGrid ? this.host.workbenchGrid.getViewSize(this.host.auxiliaryBarPartView).width : 0;
	}

	getAuxiliaryBarSize(): IViewSize {
		if (!this.host.workbenchGrid || !this.host.auxiliaryBarPartView) {
			return { width: 0, height: 0 };
		}
		return this.host.workbenchGrid.getViewSize(this.host.auxiliaryBarPartView);
	}

	setAuxiliaryBarSize(size: IViewSize): void {
		if (this.host.auxiliaryBarPartView) {
			this.host.workbenchGrid.resizeView(this.host.auxiliaryBarPartView, size);
		}
	}

	resizeAuxiliaryBar(deltaWidth: number, deltaHeight: number): void {
		if (!this.host.auxiliaryBarPartView) {
			return;
		}
		const currentSize = this.host.workbenchGrid.getViewSize(this.host.auxiliaryBarPartView);
		this.host.workbenchGrid.resizeView(this.host.auxiliaryBarPartView, {
			width: currentSize.width + deltaWidth,
			height: currentSize.height + deltaHeight
		});
	}

	restoreAuxiliaryBarWidth(_width: number): void { }

	getPersistedEditorWidth(editorGridWidth: number | undefined): number | undefined {
		return editorGridWidth;
	}

	getPersistedAuxiliaryBarWidth(gridWidth: number | undefined): number | undefined {
		return gridWidth;
	}

	getDefaultSideBarSize(policySideBarSize: number): number {
		return policySideBarSize;
	}

	getEditorNodeSize(effectiveEditorWidth: number, _effectiveAuxBarWidth: number): number {
		return effectiveEditorWidth;
	}

	isEditorNodeVisible(editorVisible: boolean, _auxBarVisible: boolean): boolean {
		return editorVisible;
	}

	getTopRightSectionChildren(sessionsNode: ISerializedNode, editorNode: ISerializedNode, auxiliaryBarNode: ISerializedNode): ISerializedNode[] {
		return [sessionsNode, editorNode, auxiliaryBarNode];
	}

	attach(): void { }
	layout(): void { }
	onGridDidChange(): void { }
	onEditorNodeResized(_nodeWidth: number): void { }

	suspendEditorNodeResizeSync(fn: () => void): void {
		fn();
	}

	applyEditorVisibility(hidden: boolean): void {
		const host = this.host;
		const shouldApplyEvenSplit = !hidden && !host.hasAppliedInitialEditorSplit;
		const mainAreaWidthBeforeReveal = shouldApplyEvenSplit
			? host.workbenchGrid.getViewSize(host.sessionsPartView).width
			: 0;

		host.workbenchGrid.setViewVisible(host.editorPartView, !hidden);

		if (shouldApplyEvenSplit) {
			host.hasAppliedInitialEditorSplit = true;
			host.applyEditorEvenSplit(mainAreaWidthBeforeReveal);
		}
	}

	onWillHideAuxiliaryBar(_hidden: boolean): void { }

	applyAuxiliaryBarVisibility(hidden: boolean): void {
		// Skipped before the grid exists: during startup the layout controller (a
		// BlockRestore contribution) runs before createWorkbenchLayout(), so the
		// visibility is recorded in partVisibility and applied when the grid is built.
		if (this.host.workbenchGrid) {
			this.host.workbenchGrid.setViewVisible(this.host.auxiliaryBarPartView, !hidden);
		}
	}

	shouldOpenAuxiliaryPaneComposite(_containerId: string): boolean {
		return true;
	}

	handleAllEditorsClosed(): void {
		const host = this.host;
		if (host.partVisibility.editor) {
			host.rememberAttachedEditorMaximizedState();
			host.setEditorHidden(true);
		}
	}

	prepareSideBarResize(_hidden: boolean): ISideBarResizeContext {
		return {};
	}

	applySideBarResize(_hidden: boolean, _context: ISideBarResizeContext): void { }
}

interface IDockedSideBarResizeContext extends ISideBarResizeContext {
	readonly freedSideBarWidth: number;
	readonly editorSizeBeforeSideBarHide: IViewSize | undefined;
	readonly detailWidthBeforeSideBarHide: number | undefined;
}

/**
 * Remembers editor/detail widths captured around visibility and sidebar-collapse
 * transitions so the docked side pane restores the user's chosen sizes.
 */
export class DockedEditorSizeMemento {
	/** Editor node size captured when "Hide Editor" is used with the detail still visible. */
	dockedEditorSizeBeforeHide: IViewSize | undefined;
	/** Editor node size grown while the sidebar is collapsed (editor content visible). */
	editorSizeGrownForSidebarHide: IViewSize | undefined;
	/** Detail-panel width grown while the sidebar is collapsed (editor content hidden). */
	detailWidthGrownForSidebarHide: number | undefined;

	/** Drop the sidebar-collapse snapshots, e.g. once the node returns to the detail width. */
	clearSidebarGrowSnapshots(): void {
		this.editorSizeGrownForSidebarHide = undefined;
		this.detailWidthGrownForSidebarHide = undefined;
	}
}

/**
 * Single-pane layout: the auxiliary bar is docked inside the editor part (below a
 * shared tab bar) rather than being its own grid column. Owns the docked width,
 * the {@link DockedAuxiliaryBarController}, the reveal-sync, and the docked size
 * bookkeeping.
 */
export class DockedSidePaneStrategy extends Disposable implements ISidePaneLayoutStrategy {

	/** Node width past the detail width at which editor content counts as visible. */
	private static readonly _EDITOR_CONTENT_VISIBLE_THRESHOLD = 4;

	protected _dockedAuxiliaryBarWidth = DockedAuxiliaryBarController.DEFAULT_WIDTH;
	protected _dockedAuxBar: DockedAuxiliaryBarController | undefined;
	protected _syncingEditorVisibility = false;
	protected readonly _memento = new DockedEditorSizeMemento();

	constructor(private readonly host: ISidePaneLayoutHost) {
		super();
	}

	protected _layoutDockedAuxBar(): void {
		this._dockedAuxBar?.layout();
	}

	applyContainerClass(container: HTMLElement): void {
		container.classList.toggle('dock-detail-panel', true);
	}

	getAuxiliaryBarLayoutWidth(): number {
		return this._dockedAuxiliaryBarWidth;
	}

	getAuxiliaryBarSize(): IViewSize {
		return { width: this._dockedAuxiliaryBarWidth, height: this.host.editorPartContainer?.clientHeight ?? 0 };
	}

	setAuxiliaryBarSize(size: IViewSize): void {
		this._dockedAuxiliaryBarWidth = Math.max(DockedAuxiliaryBarController.MIN_WIDTH, size.width);
		this._layoutDockedAuxBar();
	}

	resizeAuxiliaryBar(deltaWidth: number, _deltaHeight: number): void {
		this._dockedAuxiliaryBarWidth = Math.max(DockedAuxiliaryBarController.MIN_WIDTH, this._dockedAuxiliaryBarWidth + deltaWidth);
		this._layoutDockedAuxBar();
	}

	restoreAuxiliaryBarWidth(width: number): void {
		this._dockedAuxiliaryBarWidth = width;
	}

	getPersistedEditorWidth(editorGridWidth: number | undefined): number | undefined {
		// The docked panel lives inside the editor grid node; exclude it to avoid reload drift.
		return typeof editorGridWidth === 'number'
			? Math.max(0, editorGridWidth - this._dockedAuxiliaryBarWidth)
			: editorGridWidth;
	}

	getPersistedAuxiliaryBarWidth(_gridWidth: number | undefined): number | undefined {
		return this._dockedAuxiliaryBarWidth;
	}

	getDefaultSideBarSize(policySideBarSize: number): number {
		return Math.min(policySideBarSize, 280);
	}

	getEditorNodeSize(effectiveEditorWidth: number, effectiveAuxBarWidth: number): number {
		// The editor part spans the editor + auxiliary bar width (the aux bar is
		// docked inside it, not a grid column) so the editor tab bar spans the full width.
		return effectiveEditorWidth + effectiveAuxBarWidth;
	}

	isEditorNodeVisible(editorVisible: boolean, auxBarVisible: boolean): boolean {
		return editorVisible || auxBarVisible;
	}

	getTopRightSectionChildren(sessionsNode: ISerializedNode, editorNode: ISerializedNode, _auxiliaryBarNode: ISerializedNode): ISerializedNode[] {
		// The auxiliary bar is inside the editor part and omitted from the grid.
		return [sessionsNode, editorNode];
	}

	attach(): void {
		if (this._dockedAuxBar || !this.host.editorPartContainer) {
			return;
		}

		this._dockedAuxBar = this._register(new DockedAuxiliaryBarController(
			this.host.editorPartContainer,
			this.host.getAuxiliaryBarPart(),
			{
				getWidth: () => this._dockedAuxiliaryBarWidth,
				setWidth: (width: number) => { this._dockedAuxiliaryBarWidth = width; },
				isEditorAreaVisible: () => this.host.partVisibility.editor || this.host.partVisibility.auxiliaryBar,
				isEditorVisible: () => this.host.partVisibility.editor,
				isAuxiliaryBarVisible: () => this.host.partVisibility.auxiliaryBar,
				setEditorContentRightInset: (px: number) => this.host.getEditorMainPart().setContentRightInset(px),
			},
		));
	}

	layout(): void {
		this._layoutDockedAuxBar();
	}

	onGridDidChange(): void {
		this._syncEditorVisibility(this.host.workbenchGrid.getViewSize(this.host.editorPartView).width);
	}

	onEditorNodeResized(nodeWidth: number): void {
		this._syncEditorVisibility(nodeWidth);
	}

	private _syncEditorVisibility(nodeWidth: number): void {
		if (this._syncingEditorVisibility) {
			return;
		}

		this._syncingEditorVisibility = true;
		try {
			const host = this.host;
			const editorContentVisible = nodeWidth > this._dockedAuxiliaryBarWidth + DockedSidePaneStrategy._EDITOR_CONTENT_VISIBLE_THRESHOLD;

			// Reveal: if editor content is hidden and the node is wide enough
			if (!host.partVisibility.editor && editorContentVisible) {
				host.partVisibility.editor = true;
				host.setMainEditorAreaHiddenClass(false);
				this._memento.dockedEditorSizeBeforeHide = undefined;
				this._layoutDockedAuxBar();
				host.fireDidChangePartVisibility(Parts.EDITOR_PART, true);
				host.savePartVisibility();
			}

			// Hide: if editor content is visible and the node is squeezed down to the detail width.
			// Only hide when the detail is visible, so we don't hide when both parts are closed.
			if (host.partVisibility.editor && !editorContentVisible && host.partVisibility.auxiliaryBar) {
				host.partVisibility.editor = false;
				host.setMainEditorAreaHiddenClass(true);
				host.setEditorRevealedExplicitly(false);
				this._memento.clearSidebarGrowSnapshots();
				this._layoutDockedAuxBar();
				host.fireDidChangePartVisibility(Parts.EDITOR_PART, false);
				host.savePartVisibility();
			}
		} finally {
			this._syncingEditorVisibility = false;
		}
	}

	suspendEditorNodeResizeSync(fn: () => void): void {
		this._syncingEditorVisibility = true;
		try {
			fn();
		} finally {
			this._syncingEditorVisibility = false;
		}
	}

	applyEditorVisibility(hidden: boolean): void {
		const host = this.host;
		// Give the editor a comfortable even split when revealed without a user-chosen
		// width to restore. Hiding collapses the node to the detail width and the grid
		// caches it, so a later cross-session reveal would otherwise come back narrow.
		// A captured size in the memento always wins.
		const dockedEditorSizeBeforeHide = this._memento.dockedEditorSizeBeforeHide;
		const shouldRestoreDockedEditorSize = !hidden && !!dockedEditorSizeBeforeHide;
		const shouldApplyEvenSplit = !hidden && !shouldRestoreDockedEditorSize;

		const mainAreaWidthBeforeReveal = shouldApplyEvenSplit
			? host.workbenchGrid.getViewSize(host.sessionsPartView).width
			: 0;

		host.workbenchGrid.setViewVisible(host.editorPartView, host.partVisibility.editor || host.partVisibility.auxiliaryBar);

		if (hidden) {
			// Only "Hide Editor" (detail still visible) keeps the editor grid node
			// visible, so its width is a real user-chosen width to restore later.
			// Closing the whole side pane collapses the node to 0px, so reset instead.
			if (host.partVisibility.auxiliaryBar) {
				this._memento.dockedEditorSizeBeforeHide = host.workbenchGrid.getViewSize(host.editorPartView);
				host.workbenchGrid.resizeView(host.editorPartView, {
					width: this._dockedAuxiliaryBarWidth,
					height: this._memento.dockedEditorSizeBeforeHide.height
				});
				this._memento.clearSidebarGrowSnapshots();
			} else {
				this._memento.dockedEditorSizeBeforeHide = undefined;
				this._memento.clearSidebarGrowSnapshots();
			}
		} else if (dockedEditorSizeBeforeHide) {
			host.workbenchGrid.resizeView(host.editorPartView, dockedEditorSizeBeforeHide);
			this._memento.dockedEditorSizeBeforeHide = undefined;
		}

		if (shouldApplyEvenSplit) {
			host.hasAppliedInitialEditorSplit = true;
			host.applyEditorEvenSplit(mainAreaWidthBeforeReveal);
		}

		this._layoutDockedAuxBar();
		host.fireDidChangePartVisibility(Parts.EDITOR_PART, !hidden);
		host.notifyContainerDidLayout();
	}

	onWillHideAuxiliaryBar(hidden: boolean): void {
		const host = this.host;
		if (hidden && !host.partVisibility.editor && !host.isEditorPartAutoVisibilitySuppressed) {
			host.setEditorHidden(false, /* explicit */ true);
		}
	}

	applyAuxiliaryBarVisibility(hidden: boolean): void {
		const host = this.host;
		// The auxiliary bar is docked inside the editor part (not a grid view), so
		// drive its visibility through the docked layout and fire the visibility
		// event the grid path would otherwise raise (the layout controller listens
		// for it to capture per-session state).
		if (host.workbenchGrid) {
			host.workbenchGrid.setViewVisible(
				host.editorPartView,
				host.partVisibility.editor || host.partVisibility.auxiliaryBar
			);
		}
		this._layoutDockedAuxBar();
		host.fireDidChangePartVisibility(Parts.AUXILIARYBAR_PART, !hidden);
		host.notifyContainerDidLayout();
	}

	shouldOpenAuxiliaryPaneComposite(containerId: string): boolean {
		// Never force-open a container that has no active views: doing so would leave
		// the detail panel rendered but blank while the toggle/context key reads "on".
		return this.host.isAuxViewContainerActive(containerId);
	}

	handleAllEditorsClosed(): void {
		const host = this.host;
		if (!host.partVisibility.editor && !host.partVisibility.auxiliaryBar) {
			return;
		}
		if (host.partVisibility.editor) {
			host.rememberAttachedEditorMaximizedState();
		}
		const suppress = host.suppressEditorPartAutoVisibility();
		try {
			if (host.partVisibility.editor) {
				host.setEditorHidden(true);
			}
			if (host.partVisibility.auxiliaryBar) {
				host.setAuxiliaryBarHidden(true);
			}
		} finally {
			suppress.dispose();
		}
	}

	prepareSideBarResize(hidden: boolean): ISideBarResizeContext {
		const host = this.host;
		const shouldResize = host.partVisibility.editor || host.partVisibility.auxiliaryBar;
		// Grow the editor node when the editor is visible, else the detail (keeps node == detail width so reveal-sync can't misfire).
		const growEditorNode = shouldResize && host.partVisibility.editor;
		const growDetailPanel = shouldResize && !host.partVisibility.editor;
		return {
			freedSideBarWidth: hidden && shouldResize ? host.workbenchGrid.getViewSize(host.sideBarPartView).width : 0,
			editorSizeBeforeSideBarHide: hidden && growEditorNode ? host.workbenchGrid.getViewSize(host.editorPartView) : undefined,
			detailWidthBeforeSideBarHide: hidden && growDetailPanel ? this._dockedAuxiliaryBarWidth : undefined,
		} satisfies IDockedSideBarResizeContext;
	}

	applySideBarResize(hidden: boolean, context: ISideBarResizeContext): void {
		const { freedSideBarWidth, editorSizeBeforeSideBarHide, detailWidthBeforeSideBarHide } = context as IDockedSideBarResizeContext;

		if (editorSizeBeforeSideBarHide) {
			this._memento.editorSizeGrownForSidebarHide = editorSizeBeforeSideBarHide;
			this._resizeEditorAfterSidebarChange({
				width: editorSizeBeforeSideBarHide.width + freedSideBarWidth,
				height: editorSizeBeforeSideBarHide.height
			});
		} else if (detailWidthBeforeSideBarHide !== undefined) {
			this._memento.detailWidthGrownForSidebarHide = detailWidthBeforeSideBarHide;
			this._growDetailAfterSidebarChange(detailWidthBeforeSideBarHide + freedSideBarWidth);
		} else if (!hidden && this._memento.editorSizeGrownForSidebarHide) {
			this._resizeEditorAfterSidebarChange(this._memento.editorSizeGrownForSidebarHide);
			this._memento.editorSizeGrownForSidebarHide = undefined;
		} else if (!hidden && this._memento.detailWidthGrownForSidebarHide !== undefined) {
			this._growDetailAfterSidebarChange(this._memento.detailWidthGrownForSidebarHide);
			this._memento.detailWidthGrownForSidebarHide = undefined;
		} else if (!hidden) {
			this._memento.clearSidebarGrowSnapshots();
		}
	}

	private _resizeEditorAfterSidebarChange(size: IViewSize): void {
		this._syncingEditorVisibility = true;
		try {
			this.host.workbenchGrid.resizeView(this.host.editorPartView, size);
		} finally {
			this._syncingEditorVisibility = false;
		}
		this._layoutDockedAuxBar();
	}

	private _growDetailAfterSidebarChange(width: number): void {
		this._dockedAuxiliaryBarWidth = Math.max(DockedAuxiliaryBarController.MIN_WIDTH, width);
		this._syncingEditorVisibility = true;
		try {
			this.host.workbenchGrid.resizeView(this.host.editorPartView, {
				width: this._dockedAuxiliaryBarWidth,
				height: this.host.workbenchGrid.getViewSize(this.host.editorPartView).height
			});
		} finally {
			this._syncingEditorVisibility = false;
		}
		this._layoutDockedAuxBar();
	}
}
