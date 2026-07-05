/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { SashState } from '../../../base/browser/ui/sash/sash.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { Part } from '../../../workbench/browser/part.js';
import { EditorPart } from '../../../workbench/browser/parts/editor/editorPart.js';
import { IPartVisibilityChangeEvent, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { DockedAuxiliaryBarController, IDockedAuxiliaryBarHost } from '../../browser/dockedAuxiliaryBarController.js';
import { Workbench } from '../../browser/workbench.js';
import { DockedEditorSizeMemento, DockedSidePaneStrategy, GridSidePaneStrategy, IPartVisibilityState, ISidePaneLayoutHost, ISidePaneLayoutStrategy } from '../../browser/sidePaneLayoutStrategy.js';

interface IViewSize { width: number; height: number }

/** Test subclass exposing the docked strategy's private bookkeeping for assertions. */
class TestDockedSidePaneStrategy extends DockedSidePaneStrategy {
	layoutCount = 0;
	protected override _layoutDockedAuxBar(): void { this.layoutCount++; }
	get memento(): DockedEditorSizeMemento { return this._memento; }
	get dockedWidth(): number { return this._dockedAuxiliaryBarWidth; }
	set dockedWidth(value: number) { this._dockedAuxiliaryBarWidth = value; }
	get syncing(): boolean { return this._syncingEditorVisibility; }
}

suite('Sessions - Workbench', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	// Real workbench methods invoked against a fake host harness.
	const setEditorHidden = Reflect.get(Workbench.prototype, 'setEditorHidden') as (this: IHostHarness, hidden: boolean, explicit?: boolean) => void;
	const setAuxiliaryBarHidden = Reflect.get(Workbench.prototype, 'setAuxiliaryBarHidden') as (this: IHostHarness, hidden: boolean) => void;
	const setSideBarHidden = Reflect.get(Workbench.prototype, 'setSideBarHidden') as (this: IHostHarness, hidden: boolean) => void;
	const handleDidCloseEditor = Reflect.get(Workbench.prototype, 'handleDidCloseEditor') as (this: IHostHarness) => void;
	const setEditorMaximized = Reflect.get(Workbench.prototype, 'setEditorMaximized') as (this: IMaximizeTestHarness, maximized: boolean) => void;
	const applyEditorSplitSize = Reflect.get(Workbench.prototype, '_applyEditorSplitSize') as (this: IHostHarness, mainAreaWidth: number) => void;
	const isAuxViewContainerActive = Reflect.get(Workbench.prototype, '_isAuxViewContainerActive') as (this: { viewDescriptorService: unknown }, containerId: string) => boolean;
	const suppressEditorPartAutoVisibility = Workbench.prototype.suppressEditorPartAutoVisibility as (this: IHostHarness) => { dispose(): void };
	const rememberAttachedEditorMaximizedState = Reflect.get(Workbench.prototype, 'rememberAttachedEditorMaximizedState') as (this: IWorkbenchTestHarness) => void;
	const restoreAttachedEditorMaximizedState = Reflect.get(Workbench.prototype, 'restoreAttachedEditorMaximizedState') as (this: IWorkbenchTestHarness) => void;
	const areAllGroupsInMainPartEmpty = Reflect.get(Workbench.prototype, 'areAllGroupsInMainPartEmpty') as (this: IWorkbenchTestHarness) => boolean;
	const loadPartVisibility = Reflect.get(Workbench.prototype, '_loadPartVisibility') as (this: IWorkbenchTestHarness, storageService: { get(): string | undefined; remove(): void }) => { editor?: boolean; auxiliaryBar?: boolean; sidebar?: boolean };
	const savePartVisibility = Reflect.get(Workbench.prototype, '_savePartVisibility') as (this: IWorkbenchTestHarness) => void;
	const handleWillOpenEditor = Reflect.get(Workbench.prototype, '_handleWillOpenEditor') as (this: IWillOpenTestHarness, e: { groupId: number; editor: { typeId: string } }) => void;

	// --- Host harness -------------------------------------------------------

	interface IHostHarness extends ISidePaneLayoutHost {
		_sidePane: ISidePaneLayoutStrategy;
		_editorMaximized: boolean;
		_editorRevealedExplicitly: boolean;
		_editorPartAutoVisibilitySuppressionCount: number;
		_restoreAttachedEditorMaximizedOnShow: boolean;
		setEditorMaximized(maximized: boolean): void;
		layoutMobileSidebar(): void;
		_savePartVisibility(): void;
		editorGroupService?: { mainPart: { groups: readonly { isEmpty: boolean }[] } };
		paneCompositeService: {
			getActivePaneComposite(...args: unknown[]): undefined;
			hideActivePaneComposite(...args: unknown[]): void;
			getLastActivePaneCompositeId(...args: unknown[]): string | undefined;
			openPaneComposite(id: string, ...args: unknown[]): void;
		};
		viewDescriptorService: {
			getDefaultViewContainer(...args: unknown[]): { id: string } | undefined;
			getViewContainerById?(id: string): { hideIfEmpty: boolean } | null;
			getViewContainerModel?(container: object): { activeViewDescriptors: readonly object[] };
		};
		readonly _onDidChangePartVisibility: { fire(e: IPartVisibilityChangeEvent): void };
		readonly resizes: IViewSize[];
		readonly visibilityChanges: boolean[];
		readonly events: IPartVisibilityChangeEvent[];
		readonly classToggles: { name: string; force: boolean }[];
		saveCount: number;
	}

	interface IHostOptions {
		dockDetailPanel?: boolean;
		partVisibility?: Partial<IPartVisibilityState>;
		sessionsWidth?: number;
		editorWidth?: number;
		sideBarWidth?: number;
		dockedWidth?: number;
		hasAppliedInitialEditorSplit?: boolean;
		suppressionCount?: number;
		viewDescriptorService?: IHostHarness['viewDescriptorService'];
		onSetEditorVisible?: (visible: boolean) => void;
	}

	function createHost(options: IHostOptions = {}): IHostHarness {
		const editorPartView = {};
		const sessionsPartView = {};
		const sideBarPartView = {};
		const auxiliaryBarPartView = {};
		const resizes: IViewSize[] = [];
		const visibilityChanges: boolean[] = [];
		const events: IPartVisibilityChangeEvent[] = [];
		const classToggles: { name: string; force: boolean }[] = [];
		const viewSizes = new Map<object, IViewSize>([
			[editorPartView, { width: options.editorWidth ?? 0, height: 800 }],
			[sessionsPartView, { width: options.sessionsWidth ?? 1000, height: 800 }],
			[sideBarPartView, { width: options.sideBarWidth ?? 280, height: 800 }],
			[auxiliaryBarPartView, { width: 300, height: 800 }],
		]);

		const host = {
			editorPartView,
			sessionsPartView,
			sideBarPartView,
			auxiliaryBarPartView,
			editorPartContainer: undefined,
			mainContainer: { classList: { toggle: (name: string, force: boolean) => { classToggles.push({ name, force }); } } } as unknown as HTMLElement,
			partVisibility: { sidebar: true, auxiliaryBar: true, editor: false, panel: false, sessions: true, ...options.partVisibility },
			workbenchGrid: {
				getViewSize: (view: object) => viewSizes.get(view) ?? { width: 0, height: 0 },
				setViewVisible: (_view: object, visible: boolean) => {
					visibilityChanges.push(visible);
					options.onSetEditorVisible?.(visible);
				},
				resizeView: (view: object, size: IViewSize) => { resizes.push(size); viewSizes.set(view, size); },
			},
			hasAppliedInitialEditorSplit: options.hasAppliedInitialEditorSplit ?? false,
			getAuxiliaryBarPart: () => ({} as Part),
			getEditorMainPart: () => ({} as EditorPart),
			fireDidChangePartVisibility: (partId: Parts, visible: boolean) => { events.push({ partId, visible }); },
			notifyContainerDidLayout: () => { },
			savePartVisibility: () => { host.saveCount++; },
			applyEditorEvenSplit: (mainAreaWidth: number) => applyEditorSplitSize.call(host, mainAreaWidth),
			setEditorRevealedExplicitly: (value: boolean) => { host._editorRevealedExplicitly = value; },
			setMainEditorAreaHiddenClass: (hidden: boolean) => host.mainContainer.classList.toggle('nomaineditorarea', hidden),
			setEditorHidden: (hidden: boolean, explicit?: boolean) => setEditorHidden.call(host, hidden, explicit),
			setAuxiliaryBarHidden: (hidden: boolean) => setAuxiliaryBarHidden.call(host, hidden),
			rememberAttachedEditorMaximizedState: () => rememberAttachedEditorMaximizedState.call(host as unknown as IWorkbenchTestHarness),
			suppressEditorPartAutoVisibility: () => suppressEditorPartAutoVisibility.call(host),
			isAuxViewContainerActive: (id: string) => isAuxViewContainerActive.call(host, id),
			areAllGroupsInMainPartEmpty: () => areAllGroupsInMainPartEmpty.call(host as unknown as IWorkbenchTestHarness),
			get isEditorPartAutoVisibilitySuppressed() { return host._editorPartAutoVisibilitySuppressionCount > 0; },

			// workbench glue
			_editorMaximized: false,
			_editorRevealedExplicitly: false,
			_editorPartAutoVisibilitySuppressionCount: options.suppressionCount ?? 0,
			_restoreAttachedEditorMaximizedOnShow: false,
			setEditorMaximized: () => { },
			layoutMobileSidebar: () => { },
			_savePartVisibility: () => { host.saveCount++; },
			paneCompositeService: {
				getActivePaneComposite: () => undefined,
				hideActivePaneComposite: () => { },
				getLastActivePaneCompositeId: () => undefined,
				openPaneComposite: () => { },
			},
			viewDescriptorService: options.viewDescriptorService ?? { getDefaultViewContainer: () => undefined },
			_onDidChangePartVisibility: { fire: (e: IPartVisibilityChangeEvent) => { events.push(e); } },
			resizes,
			visibilityChanges,
			events,
			classToggles,
			saveCount: 0,
		} as unknown as IHostHarness;

		host._sidePane = disposables.add(options.dockDetailPanel
			? new TestDockedSidePaneStrategy(host)
			: new GridSidePaneStrategy(host));
		if (options.dockedWidth !== undefined && host._sidePane instanceof TestDockedSidePaneStrategy) {
			host._sidePane.dockedWidth = options.dockedWidth;
		}
		return host;
	}

	function dockedStrategy(host: IHostHarness): TestDockedSidePaneStrategy {
		return host._sidePane as TestDockedSidePaneStrategy;
	}

	// --- Editor split / reveal ---------------------------------------------

	test('applies an even editor split the first time the editor is revealed', () => {
		const host = createHost({ sessionsWidth: 1000 });

		setEditorHidden.call(host, false);

		assert.deepStrictEqual({
			editorVisible: host.partVisibility.editor,
			appliedSplit: host.hasAppliedInitialEditorSplit,
			visibilityChanges: host.visibilityChanges,
			resizes: host.resizes,
		}, {
			editorVisible: true,
			appliedSplit: true,
			visibilityChanges: [true],
			resizes: [{ width: 500, height: 800 }],
		});
	});

	test('docked sidebar hide grows the editor by the freed sidebar width and show restores it', () => {
		const host = createHost({ dockDetailPanel: true, sideBarWidth: 280, editorWidth: 620, partVisibility: { sidebar: true, editor: true, auxiliaryBar: true } });
		const strat = dockedStrategy(host);

		setSideBarHidden.call(host, true);
		setSideBarHidden.call(host, false);

		assert.deepStrictEqual({
			sidebarVisible: host.partVisibility.sidebar,
			visibilityChanges: host.visibilityChanges,
			resizes: host.resizes,
			layoutCount: strat.layoutCount,
			snapshot: strat.memento.editorSizeGrownForSidebarHide,
		}, {
			sidebarVisible: true,
			visibilityChanges: [false, true],
			resizes: [
				{ width: 900, height: 800 },
				{ width: 620, height: 800 },
			],
			layoutCount: 2,
			snapshot: undefined,
		});
	});

	test('standard layout sidebar hide does not grow the editor', () => {
		const host = createHost({ sideBarWidth: 280, editorWidth: 620, partVisibility: { sidebar: true, editor: true, auxiliaryBar: true } });

		setSideBarHidden.call(host, true);

		assert.deepStrictEqual({
			sidebarVisible: host.partVisibility.sidebar,
			visibilityChanges: host.visibilityChanges,
			resizes: host.resizes,
		}, {
			sidebarVisible: false,
			visibilityChanges: [false],
			resizes: [],
		});
	});

	test('docked sidebar hide grows the detail panel (not the editor node) when the editor is hidden and show restores it', () => {
		const host = createHost({ dockDetailPanel: true, sideBarWidth: 280, editorWidth: 620, dockedWidth: 300, partVisibility: { sidebar: true, editor: false, auxiliaryBar: true } });
		const strat = dockedStrategy(host);

		setSideBarHidden.call(host, true);
		const afterHide = {
			editorVisible: host.partVisibility.editor,
			detailWidth: strat.dockedWidth,
			resizes: [...host.resizes],
			detailSnapshot: strat.memento.detailWidthGrownForSidebarHide,
			editorSnapshot: strat.memento.editorSizeGrownForSidebarHide,
		};

		setSideBarHidden.call(host, false);

		assert.deepStrictEqual({
			afterHide,
			editorVisible: host.partVisibility.editor,
			detailWidth: strat.dockedWidth,
			resizes: host.resizes,
			detailSnapshot: strat.memento.detailWidthGrownForSidebarHide,
			layoutCount: strat.layoutCount,
		}, {
			afterHide: {
				editorVisible: false,
				detailWidth: 580,
				resizes: [{ width: 580, height: 800 }],
				detailSnapshot: 300,
				editorSnapshot: undefined,
			},
			editorVisible: false,
			detailWidth: 300,
			resizes: [
				{ width: 580, height: 800 },
				{ width: 300, height: 800 },
			],
			detailSnapshot: undefined,
			layoutCount: 2,
		});
	});

	test('does not re-apply the even split on later editor reveals', () => {
		const host = createHost({ sessionsWidth: 1000, hasAppliedInitialEditorSplit: true });

		setEditorHidden.call(host, false);

		assert.deepStrictEqual({
			editorVisible: host.partVisibility.editor,
			visibilityChanges: host.visibilityChanges,
			resizes: host.resizes,
		}, {
			editorVisible: true,
			visibilityChanges: [true],
			resizes: [],
		});
	});

	test('clamps the even editor split to a minimum width', () => {
		const host = createHost({ sessionsWidth: 400 });

		setEditorHidden.call(host, false);

		assert.deepStrictEqual(host.resizes, [{ width: 300, height: 800 }]);
	});

	test('relayouts the docked detail panel when the editor visibility changes', () => {
		const host = createHost({ dockDetailPanel: true, sessionsWidth: 1000, hasAppliedInitialEditorSplit: true });
		const strat = dockedStrategy(host);

		setEditorHidden.call(host, false);
		setEditorHidden.call(host, true);

		assert.deepStrictEqual({
			layoutCount: strat.layoutCount,
			visibilityChanges: host.visibilityChanges,
		}, {
			layoutCount: 2,
			visibilityChanges: [true, true],
		});
	});

	test('fires editor visibility changes when docked editor content is hidden or shown', () => {
		const host = createHost({ dockDetailPanel: true, sessionsWidth: 1000, hasAppliedInitialEditorSplit: true, partVisibility: { editor: true, auxiliaryBar: true } });

		setEditorHidden.call(host, true);
		setEditorHidden.call(host, false);

		assert.deepStrictEqual(host.events, [
			{ partId: Parts.EDITOR_PART, visible: false },
			{ partId: Parts.EDITOR_PART, visible: true },
		]);
	});

	test('shrinks the docked editor node to the detail width when hiding the editor', () => {
		const host = createHost({ dockDetailPanel: true, sessionsWidth: 1000, hasAppliedInitialEditorSplit: true, dockedWidth: 320, editorWidth: 900, partVisibility: { editor: true, auxiliaryBar: true } });

		setEditorHidden.call(host, true);

		assert.deepStrictEqual({
			editorVisible: host.partVisibility.editor,
			visibilityChanges: host.visibilityChanges,
			resizes: host.resizes,
		}, {
			editorVisible: false,
			visibilityChanges: [true],
			resizes: [{ width: 320, height: 800 }],
		});
	});

	test('clears stale sidebar-grow snapshots when hiding the editor with the detail visible', () => {
		const host = createHost({ dockDetailPanel: true, sessionsWidth: 1000, hasAppliedInitialEditorSplit: true, dockedWidth: 320, editorWidth: 900, partVisibility: { editor: true, auxiliaryBar: true } });
		const strat = dockedStrategy(host);
		// Captured while the editor was visible and the sessions list was hidden.
		strat.memento.editorSizeGrownForSidebarHide = { width: 900, height: 800 };
		strat.memento.detailWidthGrownForSidebarHide = 500;

		setEditorHidden.call(host, true);

		assert.deepStrictEqual({
			editorVisible: host.partVisibility.editor,
			resizes: host.resizes,
			editorSizeGrownForSidebarHide: strat.memento.editorSizeGrownForSidebarHide,
			detailWidthGrownForSidebarHide: strat.memento.detailWidthGrownForSidebarHide,
		}, {
			editorVisible: false,
			resizes: [{ width: 320, height: 800 }],
			editorSizeGrownForSidebarHide: undefined,
			detailWidthGrownForSidebarHide: undefined,
		});
	});

	// --- [Scenario 5] editor auto-reveal on open ---------------------------

	interface IWillOpenTestHarness {
		_editorPartAutoVisibilitySuppressionCount: number;
		partVisibility: { editor: boolean };
		editorGroupService: { mainPart: { groups: { id: number }[] } };
		setEditorHidden(hidden: boolean, explicit?: boolean): void;
		restoreAttachedEditorMaximizedState(): void;
	}

	function createWillOpenHarness(overrides?: Partial<IWillOpenTestHarness>): { harness: IWillOpenTestHarness; setEditorHiddenCalls: { hidden: boolean; explicit?: boolean }[] } {
		const setEditorHiddenCalls: { hidden: boolean; explicit?: boolean }[] = [];
		const harness: IWillOpenTestHarness = {
			_editorPartAutoVisibilitySuppressionCount: 0,
			partVisibility: { editor: false },
			editorGroupService: { mainPart: { groups: [{ id: 1 }] } },
			setEditorHidden: (hidden, explicit) => setEditorHiddenCalls.push({ hidden, explicit }),
			restoreAttachedEditorMaximizedState: () => { },
			...overrides,
		};
		return { harness, setEditorHiddenCalls };
	}

	test('[Scenario 5] does not reveal a hidden editor when the managed empty Files tab is activated', () => {
		const { harness, setEditorHiddenCalls } = createWillOpenHarness({ partVisibility: { editor: false } });

		// Closing the Changes tab activates the managed empty Files placeholder.
		handleWillOpenEditor.call(harness, { groupId: 1, editor: { typeId: 'workbench.editors.agentSessions.emptyFile' } });

		assert.deepStrictEqual(setEditorHiddenCalls, []);
	});

	test('[Scenario 5] reveals a hidden editor when a real editor is opened', () => {
		const { harness, setEditorHiddenCalls } = createWillOpenHarness({ partVisibility: { editor: false } });

		handleWillOpenEditor.call(harness, { groupId: 1, editor: { typeId: 'workbench.editors.files.fileEditorInput' } });

		assert.deepStrictEqual(setEditorHiddenCalls, [{ hidden: false, explicit: true }]);
	});

	test('[Scenario 5] does not reveal when the open targets a non-main-part group', () => {
		const { harness, setEditorHiddenCalls } = createWillOpenHarness({ partVisibility: { editor: false } });

		handleWillOpenEditor.call(harness, { groupId: 99, editor: { typeId: 'workbench.editors.files.fileEditorInput' } });

		assert.deepStrictEqual(setEditorHiddenCalls, []);
	});

	test('suppresses docked editor reveal sync while hiding the editor', () => {
		const host = createHost({
			dockDetailPanel: true, sessionsWidth: 1000, hasAppliedInitialEditorSplit: true, dockedWidth: 320, editorWidth: 900,
			partVisibility: { editor: true, auxiliaryBar: true },
			// Any grid mutation re-enters reveal-sync; it must be a no-op while suspended.
			onSetEditorVisible: () => dockedStrategy(host).onEditorNodeResized(900),
		});
		const host2 = host;
		const strat = dockedStrategy(host2);

		setEditorHidden.call(host, true);

		assert.deepStrictEqual({
			editorVisible: host.partVisibility.editor,
			syncing: strat.syncing,
			events: host.events,
			resizes: host.resizes,
			snapshot: strat.memento.dockedEditorSizeBeforeHide,
		}, {
			editorVisible: false,
			syncing: false,
			events: [{ partId: Parts.EDITOR_PART, visible: false }],
			resizes: [{ width: 320, height: 800 }],
			snapshot: { width: 900, height: 800 },
		});
	});

	test('restores the docked editor node size when showing after hide', () => {
		const host = createHost({ dockDetailPanel: true, sessionsWidth: 1000, hasAppliedInitialEditorSplit: true, dockedWidth: 320, editorWidth: 900, partVisibility: { editor: true, auxiliaryBar: true } });
		const strat = dockedStrategy(host);

		setEditorHidden.call(host, true);
		setEditorHidden.call(host, false);

		assert.deepStrictEqual({
			editorVisible: host.partVisibility.editor,
			visibilityChanges: host.visibilityChanges,
			resizes: host.resizes,
			snapshot: strat.memento.dockedEditorSizeBeforeHide,
		}, {
			editorVisible: true,
			visibilityChanges: [true, true],
			resizes: [
				{ width: 320, height: 800 },
				{ width: 900, height: 800 },
			],
			snapshot: undefined,
		});
	});

	test('applies an even split when revealing the docked editor with no captured width even after the initial split', () => {
		const host = createHost({ dockDetailPanel: true, sessionsWidth: 1000, hasAppliedInitialEditorSplit: true, dockedWidth: 300, partVisibility: { editor: false, auxiliaryBar: true } });

		setEditorHidden.call(host, false);

		assert.deepStrictEqual({
			editorVisible: host.partVisibility.editor,
			visibilityChanges: host.visibilityChanges,
			resizes: host.resizes,
		}, {
			editorVisible: true,
			visibilityChanges: [true],
			resizes: [{ width: 500, height: 800 }],
		});
	});

	test('restores a captured docked editor width instead of applying an even split', () => {
		const host = createHost({ dockDetailPanel: true, sessionsWidth: 1000, hasAppliedInitialEditorSplit: true, dockedWidth: 300, partVisibility: { editor: false, auxiliaryBar: true } });
		const strat = dockedStrategy(host);
		strat.memento.dockedEditorSizeBeforeHide = { width: 720, height: 800 };

		setEditorHidden.call(host, false);

		assert.deepStrictEqual({
			editorVisible: host.partVisibility.editor,
			visibilityChanges: host.visibilityChanges,
			resizes: host.resizes,
			snapshot: strat.memento.dockedEditorSizeBeforeHide,
		}, {
			editorVisible: true,
			visibilityChanges: [true],
			resizes: [{ width: 720, height: 800 }],
			snapshot: undefined,
		});
	});

	test('reopening the whole side pane while the sidebar is collapsed even-splits instead of restoring a cramped width', () => {
		// Simulates toggle-close order (auxiliary bar already hidden, editor about
		// to hide) while the sidebar is collapsed: the editor grid node collapses to
		// a tiny width and a stale sidebar-grow snapshot is present. Closing must not
		// capture the collapsed width, and must clear the stale snapshots so the
		// reopen applies a comfortable even split of the wide main area.
		const host = createHost({ dockDetailPanel: true, sessionsWidth: 1360, hasAppliedInitialEditorSplit: true, dockedWidth: 300, editorWidth: 40, partVisibility: { editor: true, auxiliaryBar: false } });
		const strat = dockedStrategy(host);
		strat.memento.editorSizeGrownForSidebarHide = { width: 620, height: 800 };
		strat.memento.detailWidthGrownForSidebarHide = 300;

		setEditorHidden.call(host, true);
		const afterClose = {
			snapshot: strat.memento.dockedEditorSizeBeforeHide,
			grownEditor: strat.memento.editorSizeGrownForSidebarHide,
			grownDetail: strat.memento.detailWidthGrownForSidebarHide,
			resizes: [...host.resizes],
		};

		setEditorHidden.call(host, false);

		assert.deepStrictEqual({
			afterClose,
			editorVisible: host.partVisibility.editor,
			resizes: host.resizes,
			snapshot: strat.memento.dockedEditorSizeBeforeHide,
		}, {
			afterClose: {
				snapshot: undefined,
				grownEditor: undefined,
				grownDetail: undefined,
				resizes: [],
			},
			editorVisible: true,
			resizes: [{ width: 680, height: 800 }],
			snapshot: undefined,
		});
	});

	// --- Docked reveal-sync (grid sash / editor part layout) ---------------

	test('marks docked editor visible when grid sash reveals editor content', () => {
		const host = createHost({ dockDetailPanel: true, sessionsWidth: 1000, dockedWidth: 300, editorWidth: 305 });
		const strat = dockedStrategy(host);
		strat.memento.dockedEditorSizeBeforeHide = { width: 900, height: 800 };

		strat.onGridDidChange();

		assert.deepStrictEqual({
			editorVisible: host.partVisibility.editor,
			events: host.events,
			layoutCount: strat.layoutCount,
			saveCount: host.saveCount,
			classToggles: host.classToggles,
			resizes: host.resizes,
			snapshot: strat.memento.dockedEditorSizeBeforeHide,
		}, {
			editorVisible: true,
			events: [{ partId: Parts.EDITOR_PART, visible: true }],
			layoutCount: 1,
			saveCount: 1,
			classToggles: [{ name: 'nomaineditorarea', force: false }],
			resizes: [],
			snapshot: undefined,
		});
	});

	test('marks docked editor visible from editor part layout width', () => {
		const host = createHost({ dockDetailPanel: true, sessionsWidth: 1000, dockedWidth: 300, editorWidth: 300 });
		const strat = dockedStrategy(host);
		strat.memento.dockedEditorSizeBeforeHide = { width: 900, height: 800 };

		strat.onEditorNodeResized(305);

		assert.deepStrictEqual({
			editorVisible: host.partVisibility.editor,
			events: host.events,
			layoutCount: strat.layoutCount,
			saveCount: host.saveCount,
			snapshot: strat.memento.dockedEditorSizeBeforeHide,
		}, {
			editorVisible: true,
			events: [{ partId: Parts.EDITOR_PART, visible: true }],
			layoutCount: 1,
			saveCount: 1,
			snapshot: undefined,
		});
	});

	test('keeps docked editor hidden when editor part layout width leaves only detail width', () => {
		const host = createHost({ dockDetailPanel: true, sessionsWidth: 1000, dockedWidth: 300, editorWidth: 300 });
		const strat = dockedStrategy(host);

		strat.onEditorNodeResized(304);

		assert.deepStrictEqual({
			editorVisible: host.partVisibility.editor,
			events: host.events,
			layoutCount: strat.layoutCount,
			saveCount: host.saveCount,
		}, {
			editorVisible: false,
			events: [],
			layoutCount: 0,
			saveCount: 0,
		});
	});

	test('keeps docked editor hidden when grid sash leaves only detail width', () => {
		const host = createHost({ dockDetailPanel: true, sessionsWidth: 1000, dockedWidth: 300, editorWidth: 300 });
		const strat = dockedStrategy(host);

		strat.onGridDidChange();

		assert.deepStrictEqual({
			editorVisible: host.partVisibility.editor,
			events: host.events,
			layoutCount: strat.layoutCount,
			saveCount: host.saveCount,
		}, {
			editorVisible: false,
			events: [],
			layoutCount: 0,
			saveCount: 0,
		});
	});

	test('hides docked editor when sash squeezes node down to detail width', () => {
		const host = createHost({ dockDetailPanel: true, sessionsWidth: 1000, dockedWidth: 300, editorWidth: 600, partVisibility: { editor: true, auxiliaryBar: true } });
		const strat = dockedStrategy(host);

		strat.onEditorNodeResized(304);

		assert.deepStrictEqual({
			editorVisible: host.partVisibility.editor,
			events: host.events,
			layoutCount: strat.layoutCount,
			saveCount: host.saveCount,
			classToggles: host.classToggles,
		}, {
			editorVisible: false,
			events: [{ partId: Parts.EDITOR_PART, visible: false }],
			layoutCount: 1,
			saveCount: 1,
			classToggles: [{ name: 'nomaineditorarea', force: true }],
		});
	});

	test('does not hide docked editor when node is squeezed but detail is also hidden', () => {
		const host = createHost({ dockDetailPanel: true, sessionsWidth: 1000, dockedWidth: 300, editorWidth: 600, partVisibility: { editor: true, auxiliaryBar: false } });
		const strat = dockedStrategy(host);

		strat.onEditorNodeResized(304);

		assert.deepStrictEqual({
			editorVisible: host.partVisibility.editor,
			events: host.events,
			layoutCount: strat.layoutCount,
			saveCount: host.saveCount,
		}, {
			editorVisible: true,
			events: [],
			layoutCount: 0,
			saveCount: 0,
		});
	});

	test('clears stale snapshots and explicit-reveal flag when sash-collapse hides the editor', () => {
		const host = createHost({ dockDetailPanel: true, sessionsWidth: 1000, dockedWidth: 300, editorWidth: 600, partVisibility: { editor: true, auxiliaryBar: true } });
		const strat = dockedStrategy(host);
		strat.memento.editorSizeGrownForSidebarHide = { width: 800, height: 600 };
		strat.memento.detailWidthGrownForSidebarHide = 400;
		host._editorRevealedExplicitly = true;

		strat.onEditorNodeResized(300);

		assert.deepStrictEqual({
			editorVisible: host.partVisibility.editor,
			editorSizeGrownForSidebarHide: strat.memento.editorSizeGrownForSidebarHide,
			detailWidthGrownForSidebarHide: strat.memento.detailWidthGrownForSidebarHide,
			editorRevealedExplicitly: host._editorRevealedExplicitly,
		}, {
			editorVisible: false,
			editorSizeGrownForSidebarHide: undefined,
			detailWidthGrownForSidebarHide: undefined,
			editorRevealedExplicitly: false,
		});
	});

	// --- DockedAuxiliaryBarController --------------------------------------

	test('fills the narrowed docked detail node when editor content is hidden', () => {

		const editorContainer = document.createElement('div');
		const auxiliaryBarContainer = document.createElement('div');
		const layouts: { width: number; height: number; top: number; left: number }[] = [];
		const insets: number[] = [];
		const persistedWidths: number[] = [];
		let editorVisible = true;
		let editorWidth = 800;

		Object.defineProperty(editorContainer, 'clientWidth', { get: () => editorWidth });
		Object.defineProperty(editorContainer, 'clientHeight', { value: 600 });
		editorContainer.getBoundingClientRect = () => ({
			width: editorWidth,
			height: 600,
			top: 0,
			right: editorWidth,
			bottom: 600,
			left: 0,
			x: 0,
			y: 0,
			toJSON: () => undefined,
		});

		const auxiliaryBarPart = {
			getContainer: () => auxiliaryBarContainer,
			layout: (width: number, height: number, top: number, left: number) => {
				layouts.push({ width, height, top, left });
			},
		} as unknown as Part;
		const host: IDockedAuxiliaryBarHost = {
			getWidth: () => 260,
			setWidth: width => persistedWidths.push(width),
			isEditorAreaVisible: () => true,
			isEditorVisible: () => editorVisible,
			isAuxiliaryBarVisible: () => true,
			setEditorContentRightInset: px => insets.push(px),
		};
		const controller = new DockedAuxiliaryBarController(editorContainer, auxiliaryBarPart, host);

		controller.layout();
		editorWidth = 260;
		editorVisible = false;
		controller.layout();

		const sash = Reflect.get(controller, '_sash') as { state: SashState } | undefined;
		assert.deepStrictEqual({
			insets,
			persistedWidths,
			layouts,
			style: {
				top: auxiliaryBarContainer.style.top,
				right: auxiliaryBarContainer.style.right,
				width: auxiliaryBarContainer.style.width,
				height: auxiliaryBarContainer.style.height,
			},
			sashState: sash?.state,
		}, {
			insets: [260, 260],
			persistedWidths: [],
			layouts: [
				{ width: 260, height: 566, top: 34, left: 540 },
				{ width: 260, height: 566, top: 34, left: 0 },
			],
			style: {
				top: '34px',
				right: '0px',
				width: '260px',
				height: '566px',
			},
			sashState: SashState.Disabled,
		});

		controller.dispose();
	});

	test('uses persisted docked detail width when editor content is visible', () => {
		const editorContainer = document.createElement('div');
		const auxiliaryBarContainer = document.createElement('div');
		const layouts: { width: number; height: number; top: number; left: number }[] = [];
		const insets: number[] = [];

		Object.defineProperty(editorContainer, 'clientWidth', { value: 800 });
		Object.defineProperty(editorContainer, 'clientHeight', { value: 600 });
		editorContainer.getBoundingClientRect = () => ({
			width: 800,
			height: 600,
			top: 0,
			right: 800,
			bottom: 600,
			left: 0,
			x: 0,
			y: 0,
			toJSON: () => undefined,
		});

		const auxiliaryBarPart = {
			getContainer: () => auxiliaryBarContainer,
			layout: (width: number, height: number, top: number, left: number) => {
				layouts.push({ width, height, top, left });
			},
		} as unknown as Part;
		const host: IDockedAuxiliaryBarHost = {
			getWidth: () => 260,
			setWidth: () => { },
			isEditorAreaVisible: () => true,
			isEditorVisible: () => true,
			isAuxiliaryBarVisible: () => true,
			setEditorContentRightInset: px => insets.push(px),
		};
		const controller = new DockedAuxiliaryBarController(editorContainer, auxiliaryBarPart, host);

		controller.layout();

		const sash = Reflect.get(controller, '_sash') as { state: SashState } | undefined;
		assert.deepStrictEqual({
			insets,
			layouts,
			style: {
				width: auxiliaryBarContainer.style.width,
				height: auxiliaryBarContainer.style.height,
			},
			sashState: sash?.state,
		}, {
			insets: [260],
			layouts: [{ width: 260, height: 566, top: 34, left: 540 }],
			style: {
				width: '260px',
				height: '566px',
			},
			sashState: SashState.Enabled,
		});

		controller.dispose();
	});

	// --- Last-editor close ---------------------------------------------------

	test('docked last editor close hides the whole side pane under suppression', () => {
		const editorHiddenCalls: { hidden: boolean; suppression: number }[] = [];
		const auxHiddenCalls: { hidden: boolean; suppression: number }[] = [];
		const host = createHost({ dockDetailPanel: true, partVisibility: { editor: true, auxiliaryBar: true } });
		host.editorGroupService = { mainPart: { groups: [{ isEmpty: true }] } };
		host.setEditorHidden = hidden => {
			editorHiddenCalls.push({ hidden, suppression: host._editorPartAutoVisibilitySuppressionCount });
			host.partVisibility.editor = !hidden;
		};
		host.setAuxiliaryBarHidden = hidden => {
			auxHiddenCalls.push({ hidden, suppression: host._editorPartAutoVisibilitySuppressionCount });
			host.partVisibility.auxiliaryBar = !hidden;
		};

		handleDidCloseEditor.call(host);

		assert.deepStrictEqual({
			editorHiddenCalls,
			auxHiddenCalls,
			visibility: host.partVisibility,
			suppression: host._editorPartAutoVisibilitySuppressionCount,
		}, {
			editorHiddenCalls: [{ hidden: true, suppression: 1 }],
			auxHiddenCalls: [{ hidden: true, suppression: 1 }],
			visibility: {
				sidebar: true,
				auxiliaryBar: false,
				editor: false,
				panel: false,
				sessions: true,
			},
			suppression: 0,
		});
	});

	test('docked last editor close hides lingering detail when editor is already hidden', () => {
		const editorHiddenCalls: boolean[] = [];
		const auxHiddenCalls: { hidden: boolean; suppression: number }[] = [];
		const host = createHost({ dockDetailPanel: true, partVisibility: { editor: false, auxiliaryBar: true } });
		host.editorGroupService = { mainPart: { groups: [{ isEmpty: true }] } };
		host.setEditorHidden = hidden => {
			editorHiddenCalls.push(hidden);
			host.partVisibility.editor = !hidden;
		};
		host.setAuxiliaryBarHidden = hidden => {
			auxHiddenCalls.push({ hidden, suppression: host._editorPartAutoVisibilitySuppressionCount });
			host.partVisibility.auxiliaryBar = !hidden;
		};

		handleDidCloseEditor.call(host);

		assert.deepStrictEqual({
			editorHiddenCalls,
			auxHiddenCalls,
			editorVisible: host.partVisibility.editor,
			auxiliaryBarVisible: host.partVisibility.auxiliaryBar,
		}, {
			editorHiddenCalls: [],
			auxHiddenCalls: [{ hidden: true, suppression: 1 }],
			editorVisible: false,
			auxiliaryBarVisible: false,
		});
	});

	// --- Attached editor maximized state -----------------------------------

	interface IWorkbenchTestHarness {
		partVisibility: IPartVisibilityState;
		layoutPolicy: { viewportClass: { get(): 'phone' | 'tablet' | 'desktop' } };
		storageService: { store(...args: unknown[]): void };
		_editorPartAutoVisibilitySuppressionCount: number;
		_editorMaximized: boolean;
		_restoreAttachedEditorMaximizedOnShow: boolean;
		setEditorMaximized(maximized: boolean): void;
		_savePartVisibility(): void;
	}

	function createWorkbenchHarness(): IWorkbenchTestHarness {
		return {
			partVisibility: { sidebar: true, auxiliaryBar: true, editor: true, panel: false, sessions: true },
			layoutPolicy: { viewportClass: { get: () => 'desktop' } },
			storageService: { store: () => { } },
			_editorPartAutoVisibilitySuppressionCount: 0,
			_editorMaximized: false,
			_restoreAttachedEditorMaximizedOnShow: false,
			setEditorMaximized: () => { },
			_savePartVisibility: () => { },
		};
	}

	test('restores attached editor maximized state when the auxiliary bar stays visible', () => {
		const maximizedStates: boolean[] = [];
		const workbench = createWorkbenchHarness();
		workbench._editorMaximized = true;
		workbench.setEditorMaximized = maximized => maximizedStates.push(maximized);

		rememberAttachedEditorMaximizedState.call(workbench);

		workbench._editorMaximized = false;
		restoreAttachedEditorMaximizedState.call(workbench);

		assert.deepStrictEqual(maximizedStates, [true]);
		assert.strictEqual(workbench._restoreAttachedEditorMaximizedOnShow, false);
	});

	test('does not restore attached editor maximized state once the auxiliary bar is hidden', () => {
		const maximizedStates: boolean[] = [];
		const workbench = createWorkbenchHarness();
		workbench._editorMaximized = true;
		workbench.setEditorMaximized = maximized => maximizedStates.push(maximized);

		rememberAttachedEditorMaximizedState.call(workbench);

		workbench._editorMaximized = false;
		workbench.partVisibility.auxiliaryBar = false;
		restoreAttachedEditorMaximizedState.call(workbench);

		assert.deepStrictEqual(maximizedStates, []);
		assert.strictEqual(workbench._restoreAttachedEditorMaximizedOnShow, false);
	});

	test('does not restore after the auxiliary bar is hidden and shown again before reopen', () => {
		const maximizedStates: boolean[] = [];
		const host = createHost({ partVisibility: { editor: true, auxiliaryBar: true } });
		host._editorMaximized = true;
		host.setEditorMaximized = maximized => maximizedStates.push(maximized);

		rememberAttachedEditorMaximizedState.call(host as unknown as IWorkbenchTestHarness);
		setAuxiliaryBarHidden.call(host, true);
		setAuxiliaryBarHidden.call(host, false);

		host._editorMaximized = false;
		restoreAttachedEditorMaximizedState.call(host as unknown as IWorkbenchTestHarness);

		assert.deepStrictEqual(maximizedStates, []);
		assert.strictEqual(host._restoreAttachedEditorMaximizedOnShow, false);
	});

	// --- Docked auxiliary bar visibility -----------------------------------

	test('docked auxiliary bar hide reveals hidden editor content', () => {
		const editorHiddenCalls: boolean[] = [];
		const host = createHost({ dockDetailPanel: true, partVisibility: { editor: false, auxiliaryBar: true } });
		host.setEditorHidden = hidden => {
			editorHiddenCalls.push(hidden);
			host.partVisibility.editor = !hidden;
		};

		setAuxiliaryBarHidden.call(host, true);

		assert.deepStrictEqual({
			editorHiddenCalls,
			editorVisible: host.partVisibility.editor,
			auxiliaryBarVisible: host.partVisibility.auxiliaryBar,
			gridVisible: host.visibilityChanges,
		}, {
			editorHiddenCalls: [false],
			editorVisible: true,
			auxiliaryBarVisible: false,
			gridVisible: [true],
		});
	});

	test('docked auxiliary bar hide does not reveal editor while side pane toggle is suppressed', () => {
		const editorHiddenCalls: boolean[] = [];
		const host = createHost({ dockDetailPanel: true, suppressionCount: 1, partVisibility: { editor: false, auxiliaryBar: true } });
		host.setEditorHidden = hidden => {
			editorHiddenCalls.push(hidden);
			host.partVisibility.editor = !hidden;
		};

		setAuxiliaryBarHidden.call(host, true);

		assert.deepStrictEqual({
			editorHiddenCalls,
			editorVisible: host.partVisibility.editor,
			auxiliaryBarVisible: host.partVisibility.auxiliaryBar,
			gridVisible: host.visibilityChanges,
		}, {
			editorHiddenCalls: [],
			editorVisible: false,
			auxiliaryBarVisible: false,
			gridVisible: [false],
		});
	});

	test('docked auxiliary bar show does not force-open an empty (gated-off) container', () => {
		const openedContainers: string[] = [];
		// The resolved default container is `hideIfEmpty` with no active views
		// (e.g. Changes/Files gated off for a workspace-less quick chat).
		const host = createHost({
			dockDetailPanel: true,
			partVisibility: { editor: true, auxiliaryBar: false },
			viewDescriptorService: {
				getDefaultViewContainer: () => ({ id: 'empty.container' }),
				getViewContainerById: () => ({ hideIfEmpty: true }),
				getViewContainerModel: () => ({ activeViewDescriptors: [] }),
			},
		});
		host.paneCompositeService.openPaneComposite = (id: string) => { openedContainers.push(id); };

		setAuxiliaryBarHidden.call(host, false);

		assert.deepStrictEqual(openedContainers, [], 'must not force-open an empty container in docked mode');
	});

	test('docked auxiliary bar show opens a container that has active views', () => {
		const openedContainers: string[] = [];
		// The resolved default container has an active view descriptor, so it has
		// content to render and must be opened normally.
		const host = createHost({
			dockDetailPanel: true,
			partVisibility: { editor: true, auxiliaryBar: false },
			viewDescriptorService: {
				getDefaultViewContainer: () => ({ id: 'active.container' }),
				getViewContainerById: () => ({ hideIfEmpty: true }),
				getViewContainerModel: () => ({ activeViewDescriptors: [{}] }),
			},
		});
		host.paneCompositeService.openPaneComposite = (id: string) => { openedContainers.push(id); };

		setAuxiliaryBarHidden.call(host, false);

		assert.deepStrictEqual(openedContainers, ['active.container'], 'must open a container that has active views');
	});

	// --- Editor maximize/un-maximize ---------------------------------------

	interface IMaximizeTestHarness {
		partVisibility: IPartVisibilityState;
		readonly editorPartView: object;
		readonly workbenchGrid: {
			getViewSize(view: object): IViewSize;
			resizeView(view: object, size: IViewSize): void;
		};
		_editorMaximized: boolean;
		_editorLastNonMaximizedVisibility?: object;
		_editorLastNonMaximizedSize?: IViewSize;
		readonly _onDidChangeEditorMaximized: { fire(): void };
		_sidePane: ISidePaneLayoutStrategy;
		setEditorHidden(hidden: boolean): void;
		setSideBarHidden(hidden: boolean): void;
		setSessionsHidden(hidden: boolean): void;
		setAuxiliaryBarHidden(hidden: boolean): void;
	}

	test('restores editor size and auxiliary bar visibility when un-maximizing', () => {
		const editorPartView = {};
		const resizes: IViewSize[] = [];
		const auxiliaryBarHiddenCalls: boolean[] = [];
		let editorSize = { width: 700, height: 800 };
		const harness: IMaximizeTestHarness = {
			partVisibility: { sidebar: true, auxiliaryBar: false, editor: true, panel: false, sessions: true },
			editorPartView,
			workbenchGrid: {
				getViewSize: () => editorSize,
				resizeView: (_view, size) => { resizes.push(size); editorSize = size; },
			},
			_editorMaximized: false,
			_onDidChangeEditorMaximized: { fire: () => { } },
			_sidePane: disposables.add(new GridSidePaneStrategy({} as ISidePaneLayoutHost)),
			setEditorHidden: () => { },
			setSideBarHidden: hidden => { harness.partVisibility.sidebar = !hidden; },
			setSessionsHidden: hidden => { harness.partVisibility.sessions = !hidden; },
			setAuxiliaryBarHidden: hidden => { auxiliaryBarHiddenCalls.push(hidden); harness.partVisibility.auxiliaryBar = !hidden; },
		};

		setEditorMaximized.call(harness, true);

		// While maximized the layout controller forces the Changes view (auxiliary
		// bar) visible, which shrinks the editor.
		harness.partVisibility.auxiliaryBar = true;
		editorSize = { width: 500, height: 800 };

		setEditorMaximized.call(harness, false);

		assert.deepStrictEqual({
			auxiliaryBarHiddenCalls,
			resizes,
			auxiliaryBarVisible: harness.partVisibility.auxiliaryBar,
			sidebarVisible: harness.partVisibility.sidebar,
			sessionsVisible: harness.partVisibility.sessions,
		}, {
			auxiliaryBarHiddenCalls: [true],
			resizes: [{ width: 700, height: 800 }],
			auxiliaryBarVisible: false,
			sidebarVisible: true,
			sessionsVisible: true,
		});
	});

	// --- Persistence gating -------------------------------------------------

	test('does not restore saved desktop part visibility on phone layout', () => {
		let getCalled = false;
		const workbench = createWorkbenchHarness();
		workbench.layoutPolicy.viewportClass.get = () => 'phone';
		const storageService = {
			get: () => {
				getCalled = true;
				return JSON.stringify({ editor: true, auxiliaryBar: true, sidebar: true });
			},
			remove: () => { },
		};

		const restored = loadPartVisibility.call(workbench, storageService);

		assert.deepStrictEqual(restored, {});
		assert.strictEqual(getCalled, false);
	});

	test('restores saved desktop part visibility outside phone layout', () => {
		const workbench = createWorkbenchHarness();
		workbench.layoutPolicy.viewportClass.get = () => 'desktop';
		const storageService = {
			get: () => JSON.stringify({ editor: true, auxiliaryBar: false, sidebar: false }),
			remove: () => { },
		};

		const restored = loadPartVisibility.call(workbench, storageService);

		assert.deepStrictEqual(restored, { editor: true, auxiliaryBar: false, sidebar: false });
	});

	test('does not persist part visibility on phone layout', () => {
		let storeCalled = false;
		const workbench = createWorkbenchHarness();
		workbench.layoutPolicy.viewportClass.get = () => 'phone';
		workbench.storageService.store = () => {
			storeCalled = true;
		};

		savePartVisibility.call(workbench);

		assert.strictEqual(storeCalled, false);
	});
});
