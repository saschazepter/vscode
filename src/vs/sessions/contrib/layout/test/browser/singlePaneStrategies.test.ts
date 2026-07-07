/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { derived } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Parts } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { IActiveSession } from '../../../../services/sessions/common/sessionsManagement.js';
import { SessionStatus } from '../../../../services/sessions/common/session.js';
import { ISessionViewState } from '../../browser/baseSessionLayoutController.js';
import { ISinglePaneLayoutContext, SinglePaneDockedTabsCoordinator } from '../../browser/singlePane/singlePaneLayoutStrategy.js';
import { SinglePaneNewSessionRulesStrategy } from '../../browser/singlePane/singlePaneNewSessionRulesStrategy.js';
import { SinglePaneQuickChatEditorHideStrategy } from '../../browser/singlePane/singlePaneQuickChatEditorHideStrategy.js';
import { SinglePaneDetailVisibilityStrategy } from '../../browser/singlePane/singlePaneDetailVisibilityStrategy.js';
import { SinglePaneDetailPanelStrategy } from '../../browser/singlePane/singlePaneDetailPanelStrategy.js';
import { SinglePaneManagedTabsStrategy } from '../../browser/singlePane/singlePaneManagedTabsStrategy.js';
import { SinglePaneEditorAreaCollapseStrategy } from '../../browser/singlePane/singlePaneEditorAreaCollapseStrategy.js';
import { SinglePaneResponsiveSidebarStrategy } from '../../browser/singlePane/singlePaneResponsiveSidebarStrategy.js';
import { SinglePaneFilesTabMissingContext } from '../../../../common/contextkeys.js';
import { ISessionChangesService } from '../../../changes/browser/sessionChangesService.js';
import { CHANGES_VIEW_ID, CHANGES_VIEW_CONTAINER_ID } from '../../../changes/common/changes.js';
import { SESSIONS_FILES_CONTAINER_ID } from '../../../files/browser/files.contribution.js';
import { EmptyFileEditorInput } from '../../../editor/browser/emptyFileEditorInput.js';
import { timeout } from '../../../../../base/common/async.js';
import { createTestHarness, ICreateOptions, ITestLayoutHarness, makeSession, TestStubEditorInput } from './layoutControllerTestUtils.js';

/**
 * Mutable state backing a test {@link ISinglePaneLayoutContext}. Tests flip these
 * flags / seed the map to reproduce the coordination the real controller drives.
 */
interface ITestContextState {
	isRestoringSessionLayout: boolean;
	togglingSidePane: boolean;
	hidingAuxiliaryBarForRestore: boolean;
	readonly viewStateBySession: ResourceMap<ISessionViewState>;
	/** Records every `withSessionLayoutRestore` invocation. */
	readonly restoreCalls: number[];
}

/**
 * Builds an {@link ISinglePaneLayoutContext} backed by the shared test harness so
 * a strategy can be instantiated in isolation via `createInstance(Strategy, ctx)`.
 * The returned `state` lets tests toggle the coordination flags the controller
 * would otherwise own.
 */
function createStrategyTestContext(harness: ITestLayoutHarness): { readonly ctx: ISinglePaneLayoutContext; readonly state: ITestContextState } {
	const state: ITestContextState = {
		isRestoringSessionLayout: false,
		togglingSidePane: false,
		hidingAuxiliaryBarForRestore: false,
		viewStateBySession: new ResourceMap<ISessionViewState>(),
		restoreCalls: [],
	};

	const activeSessionResourceObs = derived(reader => harness.activeSessionObs.read(reader)?.resource);
	const multipleSessionsVisibleObs = derived(reader => harness.visibleSessionsObs.read(reader).length > 1);

	const ctx: ISinglePaneLayoutContext = {
		get isRestoringSessionLayout() { return state.isRestoringSessionLayout; },
		withSessionLayoutRestore: work => {
			state.restoreCalls.push(state.restoreCalls.length);
			const wasRestoring = state.isRestoringSessionLayout;
			state.isRestoringSessionLayout = true;
			try {
				const result = work();
				if (result instanceof Promise) {
					result.finally(() => { state.isRestoringSessionLayout = wasRestoring; });
				} else {
					state.isRestoringSessionLayout = wasRestoring;
				}
			} catch (e) {
				state.isRestoringSessionLayout = wasRestoring;
				throw e;
			}
		},
		get togglingSidePane() { return state.togglingSidePane; },
		multipleSessionsVisibleObs,
		activeSessionResourceObs,
		viewStateBySession: state.viewStateBySession,
		get hidingAuxiliaryBarForRestore() { return state.hidingAuxiliaryBarForRestore; },
		hideAuxiliaryBarForRestore: () => {
			state.hidingAuxiliaryBarForRestore = true;
			try {
				harness.setPartHiddenCalls.push({ hidden: true, part: Parts.AUXILIARYBAR_PART });
				harness.partVisibility.set(Parts.AUXILIARYBAR_PART, false);
			} finally {
				state.hidingAuxiliaryBarForRestore = false;
			}
		},
	};

	return { ctx, state };
}

suite('SinglePane layout strategies', () => {

	const store = new DisposableStore();
	let harness: ITestLayoutHarness;

	teardown(() => store.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup(options: ICreateOptions = {}): { readonly ctx: ISinglePaneLayoutContext; readonly state: ITestContextState } {
		harness = createTestHarness(store, options);
		return createStrategyTestContext(harness);
	}

	/** Makes the given session the single active + visible session. */
	function activate(session: IActiveSession | undefined): void {
		harness.activeSessionObs.set(session, undefined);
		harness.visibleSessionsObs.set(session ? [session] : [], undefined);
	}

	/** Sets editor part visibility, firing the part-visibility change like production. */
	function setEditorVisible(visible: boolean): void {
		const wasVisible = harness.partVisibility.get(Parts.EDITOR_PART) ?? true;
		harness.partVisibility.set(Parts.EDITOR_PART, visible);
		if (wasVisible !== visible) {
			harness.onDidChangePartVisibility.fire({ partId: Parts.EDITOR_PART, visible });
		}
	}

	/** The last `setPartHidden` call recorded, or `undefined`. */
	function lastHiddenCall() {
		return harness.setPartHiddenCalls.at(-1);
	}

	/** Flushes the shared docked-tab / detail sequencers (several chained microtasks). */
	async function settle(): Promise<void> {
		for (let i = 0; i < 6; i++) {
			await timeout(0);
		}
	}

	// --- [R1] New-session editor stays closed by default ---
	suite('NewSessionRulesStrategy', () => {

		function create(ctx: ISinglePaneLayoutContext) {
			return store.add(harness.instaService.createInstance(SinglePaneNewSessionRulesStrategy, ctx));
		}

		test('hides the editor when it becomes visible in the new-session view', () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.EDITOR_PART, false);
			create(ctx);
			activate(makeSession(URI.parse('session:/a'), { status: SessionStatus.Untitled }));

			setEditorVisible(true);

			assert.deepStrictEqual(lastHiddenCall(), { hidden: true, part: Parts.EDITOR_PART });
		});

		test('hides an inherited-visible editor when the new-session view is entered', () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.EDITOR_PART, true);
			create(ctx);

			activate(makeSession(URI.parse('session:/a'), { status: SessionStatus.Untitled }));

			assert.deepStrictEqual(lastHiddenCall(), { hidden: true, part: Parts.EDITOR_PART });
		});

		test('respects an explicit in-session reveal', () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.EDITOR_PART, false);
			create(ctx);
			activate(makeSession(URI.parse('session:/a'), { status: SessionStatus.Untitled }));
			harness.setPartHiddenCalls.length = 0;

			harness.editorRevealedExplicitly = true;
			setEditorVisible(true);

			assert.strictEqual(lastHiddenCall(), undefined);
		});

		test('does not act for a created (committed) session', () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.EDITOR_PART, false);
			create(ctx);
			activate(makeSession(URI.parse('session:/a'), { status: SessionStatus.Completed, isCreated: true }));

			setEditorVisible(true);

			assert.strictEqual(lastHiddenCall(), undefined);
		});

		test('does not act for a quick chat', () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.EDITOR_PART, false);
			create(ctx);
			activate(makeSession(URI.parse('session:/a'), { status: SessionStatus.Untitled, isQuickChat: true }));

			setEditorVisible(true);

			assert.strictEqual(lastHiddenCall(), undefined);
		});

		test('does not act while multiple sessions are visible', () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.EDITOR_PART, false);
			create(ctx);
			const a = makeSession(URI.parse('session:/a'), { status: SessionStatus.Untitled });
			const b = makeSession(URI.parse('session:/b'), { status: SessionStatus.Untitled });
			harness.activeSessionObs.set(a, undefined);
			harness.visibleSessionsObs.set([a, b], undefined);

			setEditorVisible(true);

			assert.strictEqual(lastHiddenCall(), undefined);
		});
	});

	// --- Quick-chat: collapse the empty docked editor part ---
	suite('QuickChatEditorHideStrategy', () => {

		function create(ctx: ISinglePaneLayoutContext) {
			return store.add(harness.instaService.createInstance(SinglePaneQuickChatEditorHideStrategy, ctx));
		}

		test('hides the editor part while a quick chat has an empty group', () => {
			const { ctx } = setup();
			harness.editorGroupsHaveContent = false;
			harness.partVisibility.set(Parts.EDITOR_PART, true);
			create(ctx);

			activate(makeSession(URI.parse('session:/qc'), { isQuickChat: true }));
			harness.onDidActiveEditorChange.fire();

			assert.deepStrictEqual(lastHiddenCall(), { hidden: true, part: Parts.EDITOR_PART });
		});

		test('does not hide when the quick chat has a real editor open', () => {
			const { ctx } = setup();
			harness.editorGroupsHaveContent = true;
			harness.partVisibility.set(Parts.EDITOR_PART, true);
			create(ctx);

			activate(makeSession(URI.parse('session:/qc'), { isQuickChat: true }));
			harness.onDidActiveEditorChange.fire();

			assert.strictEqual(lastHiddenCall(), undefined);
		});

		test('does not act for a non quick-chat session', () => {
			const { ctx } = setup();
			harness.editorGroupsHaveContent = false;
			harness.partVisibility.set(Parts.EDITOR_PART, true);
			create(ctx);

			activate(makeSession(URI.parse('session:/a'), { isQuickChat: false }));
			harness.onDidActiveEditorChange.fire();

			assert.strictEqual(lastHiddenCall(), undefined);
		});

		test('does not act when the editor part is already hidden', () => {
			const { ctx } = setup();
			harness.editorGroupsHaveContent = false;
			harness.partVisibility.set(Parts.EDITOR_PART, false);
			create(ctx);

			activate(makeSession(URI.parse('session:/qc'), { isQuickChat: true }));
			harness.onDidActiveEditorChange.fire();

			assert.strictEqual(lastHiddenCall(), undefined);
		});
	});

	// --- [D1]/[D2]/[D3]/[D4] Per-session detail (aux-bar) visibility ---
	suite('DetailVisibilityStrategy', () => {

		const A = URI.parse('session:/a');
		const B = URI.parse('session:/b');

		function create(ctx: ISinglePaneLayoutContext) {
			return store.add(harness.instaService.createInstance(SinglePaneDetailVisibilityStrategy, ctx));
		}

		function setAuxVisible(visible: boolean): void {
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, visible);
		}

		function auxHiddenCalls() {
			return harness.setPartHiddenCalls.filter(c => c.part === Parts.AUXILIARYBAR_PART);
		}

		test('[D1] captures detail visibility for the session switched away from', () => {
			const { ctx, state } = setup();
			create(ctx);
			activate(makeSession(A, { isCreated: true }));
			setAuxVisible(true);

			activate(makeSession(B, { isCreated: true }));

			assert.deepStrictEqual(state.viewStateBySession.get(A), {
				auxiliaryBarVisible: true,
				auxiliaryBarActiveViewContainerId: undefined,
			});
		});

		test('[D2] live-captures a created session detail hide', () => {
			const { ctx, state } = setup();
			create(ctx);
			activate(makeSession(A, { isCreated: true }));
			setAuxVisible(false);

			harness.onDidChangePartVisibility.fire({ partId: Parts.AUXILIARYBAR_PART, visible: false });

			assert.deepStrictEqual(state.viewStateBySession.get(A), {
				auxiliaryBarVisible: false,
				auxiliaryBarActiveViewContainerId: undefined,
			});
		});

		test('[D2] updates the shared new-session state for an uncreated session', () => {
			const { ctx } = setup();
			const strategy = create(ctx);
			activate(makeSession(A, { status: SessionStatus.Untitled }));
			setAuxVisible(false);

			harness.onDidChangePartVisibility.fire({ partId: Parts.AUXILIARYBAR_PART, visible: false });

			assert.strictEqual(strategy.newSessionAuxiliaryBarVisible, false);
		});

		test('[D2] ignores a change while restoring session layout', () => {
			const { ctx, state } = setup();
			create(ctx);
			activate(makeSession(A, { isCreated: true }));
			state.viewStateBySession.clear();
			state.isRestoringSessionLayout = true;

			harness.onDidChangePartVisibility.fire({ partId: Parts.AUXILIARYBAR_PART, visible: false });

			assert.strictEqual(state.viewStateBySession.get(A), undefined);
		});

		test('[D2] ignores a change while toggling the whole side pane', () => {
			const { ctx, state } = setup();
			create(ctx);
			activate(makeSession(A, { isCreated: true }));
			state.viewStateBySession.clear();
			state.togglingSidePane = true;

			harness.onDidChangePartVisibility.fire({ partId: Parts.AUXILIARYBAR_PART, visible: false });

			assert.strictEqual(state.viewStateBySession.get(A), undefined);
		});

		test('[D3b] reveals the detail for a new-session view with no saved state', () => {
			const { ctx } = setup();
			create(ctx);

			activate(makeSession(A, { status: SessionStatus.Untitled }));

			assert.deepStrictEqual(auxHiddenCalls(), [{ hidden: false, part: Parts.AUXILIARYBAR_PART }]);
		});

		test('[D3b] hides the detail when the user previously hid the new-session detail', () => {
			const { ctx } = setup({ newSessionViewState: { auxiliaryBarVisible: false } });
			create(ctx);

			activate(makeSession(A, { status: SessionStatus.Untitled }));

			assert.deepStrictEqual(auxHiddenCalls(), [{ hidden: true, part: Parts.AUXILIARYBAR_PART }]);
		});

		test('[D3c] leaves a first-seen created session as-is (no saved state)', () => {
			const { ctx } = setup();
			create(ctx);

			activate(makeSession(A, { isCreated: true }));

			assert.deepStrictEqual(auxHiddenCalls(), []);
		});

		test('[D3c] restores a saved hidden detail for a created session', () => {
			const { ctx, state } = setup();
			state.viewStateBySession.set(A, { auxiliaryBarVisible: false, auxiliaryBarActiveViewContainerId: undefined });
			create(ctx);

			activate(makeSession(A, { isCreated: true }));

			assert.deepStrictEqual(auxHiddenCalls(), [{ hidden: true, part: Parts.AUXILIARYBAR_PART }]);
		});

		test('[D3c] restores a saved visible detail for a created session', () => {
			const { ctx, state } = setup();
			state.viewStateBySession.set(A, { auxiliaryBarVisible: true, auxiliaryBarActiveViewContainerId: undefined });
			create(ctx);

			activate(makeSession(A, { isCreated: true }));

			assert.deepStrictEqual(auxHiddenCalls(), [{ hidden: false, part: Parts.AUXILIARYBAR_PART }]);
		});

		test('[D4] submit keeps the visible detail and reveals Changes', () => {
			const { ctx, state } = setup();
			create(ctx);
			activate(makeSession(A, { status: SessionStatus.Untitled }));
			setAuxVisible(true);

			activate(makeSession(B, { isCreated: true }));

			assert.deepStrictEqual({
				viewState: state.viewStateBySession.get(B),
				openedChanges: harness.openedViews.includes(CHANGES_VIEW_ID),
			}, {
				viewState: { auxiliaryBarVisible: true, auxiliaryBarActiveViewContainerId: undefined },
				openedChanges: true,
			});
		});

		test('[D4] submit with hidden detail does not reveal Changes', () => {
			const { ctx, state } = setup();
			create(ctx);
			activate(makeSession(A, { status: SessionStatus.Untitled }));
			setAuxVisible(false);

			activate(makeSession(B, { isCreated: true }));

			assert.deepStrictEqual({
				viewState: state.viewStateBySession.get(B),
				openedChanges: harness.openedViews.includes(CHANGES_VIEW_ID),
			}, {
				viewState: { auxiliaryBarVisible: false, auxiliaryBarActiveViewContainerId: undefined },
				openedChanges: false,
			});
		});

		test('onSidePaneToggled marks a created-session collapse', () => {
			const { ctx, state } = setup();
			const strategy = create(ctx);
			activate(makeSession(A, { isCreated: true }));

			strategy.onSidePaneToggled(true, true);

			assert.deepStrictEqual(state.viewStateBySession.get(A), {
				auxiliaryBarVisible: false,
				auxiliaryBarActiveViewContainerId: undefined,
				auxiliaryBarHiddenByCollapse: true,
			});
		});
	});

	// --- Detail container (Changes / Files) follows the active editor ---
	suite('DetailPanelStrategy', () => {

		const S = URI.parse('session:/s');

		function create(ctx: ISinglePaneLayoutContext) {
			return store.add(harness.instaService.createInstance(SinglePaneDetailPanelStrategy, ctx));
		}

		function changesEditor(): TestStubEditorInput {
			const resource = harness.sessionChangesService.getChangesEditorResource(S);
			return store.add(new TestStubEditorInput(resource));
		}

		function auxHiddenCalls() {
			return harness.setPartHiddenCalls.filter(c => c.part === Parts.AUXILIARYBAR_PART);
		}

		test('hides the detail for a quick chat', async () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, true);
			create(ctx);

			activate(makeSession(S, { isQuickChat: true }));
			await timeout(0);

			assert.deepStrictEqual(auxHiddenCalls(), [{ hidden: true, part: Parts.AUXILIARYBAR_PART }]);
		});

		test('hides the detail when a created session has an empty editor group', async () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, true);
			harness.editorGroupsHaveContent = false;
			create(ctx);

			activate(makeSession(S, { isCreated: true }));
			await timeout(0);

			assert.deepStrictEqual(auxHiddenCalls(), [{ hidden: true, part: Parts.AUXILIARYBAR_PART }]);
		});

		test('preserves the detail for an empty group during a session restore', async () => {
			const { ctx, state } = setup();
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, true);
			harness.editorGroupsHaveContent = false;
			state.isRestoringSessionLayout = true;
			create(ctx);

			activate(makeSession(S, { isCreated: true }));
			await timeout(0);

			assert.deepStrictEqual(auxHiddenCalls(), []);
		});

		test('opens Changes for a created session with no active editor', async () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, true);
			harness.editorGroupsHaveContent = true;
			create(ctx);

			activate(makeSession(S, { isCreated: true }));
			await timeout(0);

			assert.deepStrictEqual(harness.openedViewContainers, [CHANGES_VIEW_CONTAINER_ID]);
		});

		test('opens Files for an uncreated session with no active editor', async () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, true);
			harness.editorGroupsHaveContent = true;
			create(ctx);

			activate(makeSession(S, { status: SessionStatus.Untitled }));
			await timeout(0);

			assert.deepStrictEqual(harness.openedViewContainers, [SESSIONS_FILES_CONTAINER_ID]);
		});

		test('forces Changes when a changes editor is active', async () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, true);
			harness.editorGroupsHaveContent = true;
			harness.activeEditorInput = changesEditor();
			create(ctx);

			activate(makeSession(S, { isCreated: true }));
			await timeout(0);

			assert.deepStrictEqual(harness.openedViewContainers, [CHANGES_VIEW_CONTAINER_ID]);
		});

		test('forces Files when the empty landing editor is active', async () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, true);
			harness.editorGroupsHaveContent = true;
			harness.activeEditorInput = store.add(new EmptyFileEditorInput());
			create(ctx);

			activate(makeSession(S, { isCreated: true }));
			await timeout(0);

			assert.deepStrictEqual(harness.openedViewContainers, [SESSIONS_FILES_CONTAINER_ID]);
		});

		test('does not reveal a hidden detail when a changes editor becomes active', async () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, false);
			harness.editorGroupsHaveContent = true;
			harness.activeEditorInput = changesEditor();
			create(ctx);

			activate(makeSession(S, { isCreated: true }));
			await timeout(0);

			assert.deepStrictEqual({ hidden: auxHiddenCalls(), opened: harness.openedViewContainers }, { hidden: [], opened: [] });
		});

		test('forces Changes while the editor is maximized', async () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, true);
			harness.editorGroupsHaveContent = true;
			harness.editorMaximized = true;
			create(ctx);

			activate(makeSession(S, { isCreated: true }));
			await timeout(0);

			assert.deepStrictEqual(harness.openedViewContainers, [CHANGES_VIEW_CONTAINER_ID]);
		});
	});

	// --- Managed docked tabs (Changes multi-diff + Files placeholder) ---
	suite('ManagedTabsStrategy', () => {

		const S = URI.parse('session:/s');

		function create(ctx: ISinglePaneLayoutContext) {
			const coordinator = store.add(new SinglePaneDockedTabsCoordinator(harness.instaService.get(ISessionChangesService)));
			return store.add(harness.instaService.createInstance(SinglePaneManagedTabsStrategy, ctx, coordinator));
		}

		/** Classifies the managed group's editors: 'changes' | 'files' | 'other'. */
		function editorKinds(): string[] {
			return harness.activeGroupEditors.map(e => {
				if (e instanceof EmptyFileEditorInput) {
					return 'files';
				}
				return e.resource && harness.sessionChangesService.getSessionResource(e.resource) ? 'changes' : 'other';
			});
		}

		function filesTabMissing(): boolean {
			return !!harness.contextKeyService.getContextKeyValue(SinglePaneFilesTabMissingContext.key);
		}

		test('ensures the Changes and Files tabs for a created session', async () => {
			const { ctx } = setup();
			create(ctx);

			activate(makeSession(S, { isCreated: true }));
			await settle();

			assert.deepStrictEqual(editorKinds(), ['changes', 'files']);
		});

		test('ensures only the Files tab for an uncreated session', async () => {
			const { ctx } = setup();
			create(ctx);

			activate(makeSession(S, { status: SessionStatus.Untitled }));
			await settle();

			assert.deepStrictEqual(editorKinds(), ['files']);
		});

		test('ensures no managed tabs for a quick chat', async () => {
			const { ctx } = setup();
			create(ctx);

			activate(makeSession(S, { isQuickChat: true }));
			await settle();

			assert.deepStrictEqual(editorKinds(), []);
		});

		test('remembers a user Files-tab dismissal and offers the + Files entry', async () => {
			const { ctx } = setup();
			create(ctx);
			activate(makeSession(S, { isCreated: true }));
			await settle();

			const placeholder = harness.activeGroupEditors.find(e => e instanceof EmptyFileEditorInput)!;
			harness.activeGroupEditors.splice(harness.activeGroupEditors.indexOf(placeholder), 1);
			harness.onDidCloseEditor.fire({ editor: placeholder });
			harness.onDidEditorsChange.fire();
			await settle();

			assert.deepStrictEqual({ kinds: editorKinds(), filesMissing: filesTabMissing() }, { kinds: ['changes'], filesMissing: true });
		});

		test('re-ensures a dismissed Files tab after the side pane is reopened', async () => {
			const { ctx } = setup();
			create(ctx);
			activate(makeSession(S, { isCreated: true }));
			await settle();

			// User dismisses the Files placeholder.
			const placeholder = harness.activeGroupEditors.find(e => e instanceof EmptyFileEditorInput)!;
			harness.activeGroupEditors.splice(harness.activeGroupEditors.indexOf(placeholder), 1);
			harness.onDidCloseEditor.fire({ editor: placeholder });
			harness.onDidEditorsChange.fire();
			await settle();

			// Fully close the side pane, then reopen it.
			harness.partVisibility.set(Parts.EDITOR_PART, false);
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, false);
			harness.onDidChangePartVisibility.fire({ partId: Parts.AUXILIARYBAR_PART, visible: false });
			await settle();
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, true);
			harness.onDidChangePartVisibility.fire({ partId: Parts.AUXILIARYBAR_PART, visible: true });
			await settle();

			assert.deepStrictEqual(editorKinds(), ['changes', 'files']);
		});

		test('removes the Files placeholder while a workspace file is open in a visible editor', async () => {
			const { ctx } = setup();
			create(ctx);
			activate(makeSession(S, { isCreated: true }));
			await settle();

			harness.partVisibility.set(Parts.EDITOR_PART, true);
			harness.activeGroupEditors.push(store.add(new TestStubEditorInput(URI.file('/repo/a.ts'))));
			harness.onDidEditorsChange.fire();
			await settle();

			assert.strictEqual(harness.activeGroupEditors.some(e => e instanceof EmptyFileEditorInput), false);
		});
	});

	// --- Editor-area collapse (hide real editors while detail-only) ---
	suite('EditorAreaCollapseStrategy', () => {

		function create(ctx: ISinglePaneLayoutContext) {
			const coordinator = store.add(new SinglePaneDockedTabsCoordinator(harness.instaService.get(ISessionChangesService)));
			const strategy = store.add(harness.instaService.createInstance(SinglePaneEditorAreaCollapseStrategy, ctx, coordinator));
			return { strategy, coordinator };
		}

		function hideEditorArea(): void {
			harness.partVisibility.set(Parts.EDITOR_PART, false);
			harness.onDidChangePartVisibility.fire({ partId: Parts.EDITOR_PART, visible: false });
		}

		function showEditorArea(): void {
			harness.partVisibility.set(Parts.EDITOR_PART, true);
			harness.onDidChangePartVisibility.fire({ partId: Parts.EDITOR_PART, visible: true });
		}

		test('collapses non-managed editors when the editor area is hidden', async () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.EDITOR_PART, true);
			const { coordinator } = create(ctx);
			harness.activeGroupEditors.push(store.add(new TestStubEditorInput(URI.file('/repo/a.ts'))));

			hideEditorArea();
			await settle();

			assert.deepStrictEqual({ editors: harness.activeGroupEditors.length, captured: coordinator.collapsedEditors?.length }, { editors: 0, captured: 1 });
		});

		test('restores collapsed editors when the editor area is shown again', async () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.EDITOR_PART, true);
			const { coordinator } = create(ctx);
			harness.activeGroupEditors.push(store.add(new TestStubEditorInput(URI.file('/repo/a.ts'))));

			hideEditorArea();
			await settle();
			showEditorArea();
			await settle();

			assert.deepStrictEqual({ editors: harness.activeGroupEditors.length, captured: coordinator.collapsedEditors }, { editors: 1, captured: undefined });
		});

		test('skips the collapse during a session-switch restore', async () => {
			const { ctx, state } = setup();
			harness.partVisibility.set(Parts.EDITOR_PART, true);
			const { coordinator } = create(ctx);
			harness.activeGroupEditors.push(store.add(new TestStubEditorInput(URI.file('/repo/a.ts'))));
			state.isRestoringSessionLayout = true;

			hideEditorArea();
			await settle();

			assert.deepStrictEqual({ editors: harness.activeGroupEditors.length, captured: coordinator.collapsedEditors }, { editors: 1, captured: undefined });
		});

		test('does not collapse the managed placeholder tab', async () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.EDITOR_PART, true);
			const { coordinator } = create(ctx);
			harness.activeGroupEditors.push(store.add(new EmptyFileEditorInput()));

			hideEditorArea();
			await settle();

			assert.deepStrictEqual({ editors: harness.activeGroupEditors.length, captured: coordinator.collapsedEditors }, { editors: 1, captured: undefined });
		});
	});

	// --- [D7] Responsive sessions list (auto-hide to free room for the side pane) ---
	suite('ResponsiveSidebarStrategy', () => {

		function create(ctx: ISinglePaneLayoutContext) {
			return store.add(harness.instaService.createInstance(SinglePaneResponsiveSidebarStrategy, ctx));
		}

		test('toggleDetails opens the detail and auto-hides the sessions list', () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, false);
			harness.partVisibility.set(Parts.SIDEBAR_PART, true);
			const strategy = create(ctx);
			harness.setPartHiddenCalls.length = 0;

			const nowVisible = strategy.toggleDetails();

			assert.deepStrictEqual({ nowVisible, calls: harness.setPartHiddenCalls }, {
				nowVisible: true,
				calls: [{ hidden: false, part: Parts.AUXILIARYBAR_PART }, { hidden: true, part: Parts.SIDEBAR_PART }],
			});
		});

		test('toggleDetails closes the detail and restores the auto-hidden list', () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, false);
			harness.partVisibility.set(Parts.SIDEBAR_PART, true);
			const strategy = create(ctx);
			strategy.toggleDetails();
			harness.setPartHiddenCalls.length = 0;

			const nowVisible = strategy.toggleDetails();

			assert.deepStrictEqual({ nowVisible, calls: harness.setPartHiddenCalls }, {
				nowVisible: false,
				calls: [{ hidden: true, part: Parts.AUXILIARYBAR_PART }, { hidden: false, part: Parts.SIDEBAR_PART }],
			});
		});

		test('restores the auto-hidden list once the side pane is fully hidden', () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.EDITOR_PART, true);
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, false);
			harness.partVisibility.set(Parts.SIDEBAR_PART, true);
			const strategy = create(ctx);
			strategy.toggleDetails();
			harness.setPartHiddenCalls.length = 0;

			// Fully hide the side pane (editor + aux).
			harness.partVisibility.set(Parts.EDITOR_PART, false);
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, false);
			harness.onDidChangePartVisibility.fire({ partId: Parts.AUXILIARYBAR_PART, visible: false });

			assert.deepStrictEqual(harness.setPartHiddenCalls.filter(c => c.part === Parts.SIDEBAR_PART), [{ hidden: false, part: Parts.SIDEBAR_PART }]);
		});

		test('a manual sessions-list toggle hands control back (no auto-restore)', () => {
			const { ctx } = setup();
			harness.partVisibility.set(Parts.EDITOR_PART, true);
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, false);
			harness.partVisibility.set(Parts.SIDEBAR_PART, true);
			const strategy = create(ctx);
			strategy.toggleDetails();

			// User manually re-shows the sessions list.
			harness.onDidChangePartVisibility.fire({ partId: Parts.SIDEBAR_PART, visible: true });
			harness.setPartHiddenCalls.length = 0;

			// Fully hide the side pane — the list must not be auto-restored.
			harness.partVisibility.set(Parts.EDITOR_PART, false);
			harness.partVisibility.set(Parts.AUXILIARYBAR_PART, false);
			harness.onDidChangePartVisibility.fire({ partId: Parts.AUXILIARYBAR_PART, visible: false });

			assert.deepStrictEqual(harness.setPartHiddenCalls.filter(c => c.part === Parts.SIDEBAR_PART), []);
		});
	});
});
