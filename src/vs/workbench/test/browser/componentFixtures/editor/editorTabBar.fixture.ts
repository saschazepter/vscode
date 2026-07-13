/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, Dimension } from '../../../../../base/browser/dom.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename, dirname } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { ITreeViewsDnDService } from '../../../../../editor/common/services/treeViewsDndService.js';
import { TreeViewsDnDService } from '../../../../../editor/common/services/treeViewsDnd.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { EditorInputCapabilities, EditorsOrder, IEditorPartOptions, Verbosity } from '../../../../common/editor.js';
import { EditorGroupModel } from '../../../../common/editor/editorGroupModel.js';
import { EDITOR_GROUP_HEADER_NO_TABS_BACKGROUND, EDITOR_GROUP_HEADER_TABS_BACKGROUND } from '../../../../common/theme.js';
import { DEFAULT_EDITOR_PART_OPTIONS, IEditorGroupsView, IEditorGroupView, IEditorPartsView } from '../../../../browser/parts/editor/editor.js';
import { EditorTitleControl } from '../../../../browser/parts/editor/editorTitleControl.js';
import { INotebookDocumentService, NotebookDocumentWorkbenchService } from '../../../../services/notebook/common/notebookDocumentService.js';
import { workbenchInstantiationService } from '../../workbenchTestServices.js';
import { ComponentFixtureContext, defineComponentFixture, defineThemedFixtureGroup } from '../fixtureUtils.js';

// ============================================================================
// Fixture editor input
// ============================================================================

interface IFixtureEditorInputOptions {
	readonly typeId?: string;
	readonly dirty?: boolean;
	readonly capabilities?: EditorInputCapabilities;
	readonly icon?: ThemeIcon | URI;
}

/**
 * A lightweight {@link EditorInput} used purely to populate the tab bar for
 * screenshot fixtures. It never resolves a real editor pane; it only provides
 * the label, description (folder path), icon and dirty state that the tab bar
 * renders.
 */
class FixtureEditorInput extends EditorInput {

	constructor(
		readonly resource: URI,
		private readonly _options: IFixtureEditorInputOptions = {}
	) {
		super();
	}

	override get typeId(): string { return this._options.typeId ?? 'workbench.editors.fixtureEditorInput'; }
	override get editorId(): string | undefined { return this.typeId; }

	override get capabilities(): EditorInputCapabilities {
		return this._options.capabilities ?? EditorInputCapabilities.None;
	}

	override getName(): string {
		return basename(this.resource);
	}

	override getDescription(_verbosity?: Verbosity): string | undefined {
		const parent = dirname(this.resource);
		return parent.path === '/' ? undefined : parent.path.replace(/^\//, '');
	}

	override getIcon(): ThemeIcon | URI | undefined {
		return this._options.icon;
	}

	override isDirty(): boolean {
		return !!this._options.dirty;
	}
}

// ============================================================================
// Editor specs used to populate the group model
// ============================================================================

interface IEditorSpec {
	readonly resource: URI;
	readonly typeId?: string;
	readonly dirty?: boolean;
	readonly icon?: ThemeIcon | URI;
	readonly capabilities?: EditorInputCapabilities;
	readonly pinned?: boolean;
	readonly sticky?: boolean;
	readonly active?: boolean;
}

function file(path: string): URI {
	return URI.file(path);
}

/** A varied set of editors: different input kinds, file names and folder paths. */
function defaultEditorSpecs(): IEditorSpec[] {
	return [
		{ resource: file('/project/src/app/main.ts'), icon: ThemeIcon.fromId(Codicon.symbolFile.id), sticky: true, pinned: true },
		{ resource: file('/project/src/app/index.ts'), pinned: true },
		{ resource: file('/project/README.md'), icon: ThemeIcon.fromId(Codicon.markdown.id), pinned: true },
		{ resource: file('/project/package.json'), icon: ThemeIcon.fromId(Codicon.json.id), pinned: true, dirty: true, active: true },
		{ resource: URI.from({ scheme: 'untitled', path: 'Untitled-1' }), typeId: 'workbench.editors.untitledFixture', icon: ThemeIcon.fromId(Codicon.file.id), pinned: false /* preview */ },
		{ resource: file('/project/.vscode/settings.json'), icon: ThemeIcon.fromId(Codicon.settingsGear.id), pinned: true },
		{ resource: file('/project/src/app/components/button.tsx'), pinned: true },
		{ resource: file('/project/tests/app/main.test.ts'), pinned: true },
	];
}

/** Two editors sharing a name but living in different folders (to show descriptions). */
function duplicateNameEditorSpecs(): IEditorSpec[] {
	return [
		{ resource: file('/project/src/app/index.ts'), pinned: true, active: true },
		{ resource: file('/project/src/lib/index.ts'), pinned: true },
		{ resource: file('/project/src/lib/util/index.ts'), pinned: true },
		{ resource: file('/project/tests/index.ts'), pinned: true },
	];
}

/** A larger set of editors, useful for wrapping / scrollbar / label variants. */
function manyEditorSpecs(): IEditorSpec[] {
	const names = [
		'main.ts', 'index.ts', 'button.tsx', 'input.tsx', 'list.tsx', 'tree.tsx',
		'model.ts', 'service.ts', 'view.ts', 'controller.ts', 'utils.ts', 'types.ts',
		'app.css', 'theme.css', 'README.md', 'package.json',
	];
	return names.map((name, index) => ({
		resource: file(`/project/src/module${index % 4}/${name}`),
		pinned: true,
		active: index === 0,
		dirty: index % 5 === 0,
	}));
}

/** Editors with dirty state to show modified indicators. */
function dirtyEditorSpecs(): IEditorSpec[] {
	return [
		{ resource: file('/project/src/app/main.ts'), pinned: true, dirty: true, active: true },
		{ resource: file('/project/src/app/index.ts'), pinned: true, dirty: true },
		{ resource: file('/project/README.md'), pinned: true },
		{ resource: file('/project/package.json'), pinned: true, dirty: true },
	];
}

/** Sticky (pinned) editors to show the sticky tab styling. */
function stickyEditorSpecs(): IEditorSpec[] {
	return [
		{ resource: file('/project/src/app/main.ts'), icon: ThemeIcon.fromId(Codicon.symbolFile.id), sticky: true, pinned: true },
		{ resource: file('/project/README.md'), icon: ThemeIcon.fromId(Codicon.markdown.id), sticky: true, pinned: true },
		{ resource: file('/project/package.json'), icon: ThemeIcon.fromId(Codicon.json.id), sticky: true, pinned: true },
		{ resource: file('/project/src/app/index.ts'), pinned: true, active: true },
		{ resource: file('/project/src/app/components/button.tsx'), pinned: true },
	];
}

// ============================================================================
// Rendering
// ============================================================================

interface IRenderOptions {
	readonly partOptions?: Partial<IEditorPartOptions>;
	readonly editors?: IEditorSpec[];
	readonly width?: number;
}

function createPartOptions(overrides?: Partial<IEditorPartOptions>): IEditorPartOptions {
	return {
		...DEFAULT_EDITOR_PART_OPTIONS,
		hasIcons: true,
		...overrides,
	};
}

function populateModel(model: EditorGroupModel, specs: IEditorSpec[], disposableStore: DisposableStore): void {
	// Open sticky editors first so their indices stay at the front.
	const ordered = [...specs].sort((a, b) => (a.sticky === b.sticky) ? 0 : a.sticky ? -1 : 1);
	for (const spec of ordered) {
		const input = disposableStore.add(new FixtureEditorInput(spec.resource, {
			typeId: spec.typeId,
			dirty: spec.dirty,
			icon: spec.icon,
			capabilities: spec.capabilities,
		}));
		model.openEditor(input, {
			pinned: spec.pinned ?? true,
			sticky: spec.sticky,
			active: spec.active,
		});
	}
}

function renderTabBar(ctx: ComponentFixtureContext, options: IRenderOptions): void {
	const { container, disposableStore, theme } = ctx;

	const width = options.width ?? 820;
	const partOptions = createPartOptions(options.partOptions);

	// Configuration: keep breadcrumbs disabled so the tab bar renders without
	// pulling in the breadcrumbs picker/model dependencies.
	const configurationService = new TestConfigurationService();
	configurationService.setUserConfiguration('breadcrumbs', { enabled: false });

	const instantiationService = workbenchInstantiationService({
		configurationService: () => configurationService,
	}, disposableStore);

	// Apply the fixture's themed color data to the existing theme service so
	// that `getColor(...)` in the tab bar returns real colors.
	(instantiationService.get(IThemeService) as TestThemeService).setTheme(theme);

	// Services required transitively by the tab bar that the base workbench test
	// harness does not stub.
	instantiationService.stub(ITreeViewsDnDService, new TreeViewsDnDService());
	instantiationService.stub(INotebookDocumentService, new NotebookDocumentWorkbenchService());

	// Real editor group model populated with the fixture editors.
	const model = disposableStore.add(instantiationService.createInstance(EditorGroupModel, undefined));
	populateModel(model, options.editors ?? defaultEditorSpecs(), disposableStore);

	// Lightweight views that delegate reads to the model. These stand in for the
	// real `EditorGroupView` / `EditorPart` so the title control can render in
	// isolation.
	const groupView = new class extends mock<IEditorGroupView>() {
		relayoutFn: () => void = () => { };
		override get id() { return model.id; }
		override get count() { return model.count; }
		override get activeEditor() { return model.activeEditor; }
		override get activeEditorPane() { return undefined; }
		override get selectedEditors() { return model.selectedEditors; }
		override get ariaLabel() { return 'Editor Group 1'; }
		override getEditorByIndex(index: number) { return model.getEditorByIndex(index); }
		override getIndexOfEditor(editor: EditorInput) { return model.indexOf(editor); }
		override getEditors(order: EditorsOrder, opts?: { excludeSticky?: boolean }) { return model.getEditors(order, opts); }
		override isActive(editor: EditorInput) { return model.isActive(editor); }
		override isPinned(editorOrIndex: EditorInput | number) { return model.isPinned(editorOrIndex); }
		override isSticky(editorOrIndex: EditorInput | number) { return model.isSticky(editorOrIndex); }
		override isSelected(editorOrIndex: EditorInput | number) { return model.isSelected(editorOrIndex); }
		override createEditorActions() { return { actions: { primary: [], secondary: [] }, onDidChange: Event.None }; }
		override relayout() { this.relayoutFn(); }
	};

	const groupsView = new class extends mock<IEditorGroupsView>() {
		override get partOptions() { return partOptions; }
		override get activeGroup() { return groupView; }
		override get groups() { return [groupView]; }
		override readonly onDidChangeEditorPartOptions = Event.None;
		override readonly onDidVisibilityChange = Event.None;
	};

	const editorPartsView = new class extends mock<IEditorPartsView>() {
		override get count() { return 1; }
		override getGroup() { return groupView; }
	};

	// DOM: recreate the ancestor chain the tab bar CSS is scoped to
	// (`.monaco-workbench .part.editor > .content .editor-group-container > .title`).
	// The fixture container already carries the `.monaco-workbench` + theme classes.
	const editorPart = $('.part.editor');
	const content = $('.content');
	const groupContainer = $('.editor-group-container.active');
	const titleContainer = $('.title');
	titleContainer.classList.toggle('tabs', partOptions.showTabs === 'multiple');
	titleContainer.classList.toggle('show-file-icons', partOptions.showIcons);

	const headerBackground = theme.getColor(partOptions.showTabs === 'multiple' ? EDITOR_GROUP_HEADER_TABS_BACKGROUND : EDITOR_GROUP_HEADER_NO_TABS_BACKGROUND);
	if (headerBackground) {
		titleContainer.style.backgroundColor = headerBackground.toString();
	}

	// A small placeholder editor area beneath the tab bar so the tab bar is seen
	// in place inside a group view.
	const editorContainer = $('.editor-container');
	editorContainer.style.height = '96px';
	editorContainer.style.opacity = '0.6';

	editorPart.appendChild(content);
	content.appendChild(groupContainer);
	groupContainer.appendChild(titleContainer);
	groupContainer.appendChild(editorContainer);
	container.appendChild(editorPart);

	container.style.width = `${width}px`;
	groupContainer.style.width = `${width}px`;

	const titleControl = disposableStore.add(instantiationService.createInstance(
		EditorTitleControl,
		titleContainer,
		editorPartsView,
		groupsView,
		groupView,
		model,
		undefined,
	));

	const layout = () => {
		titleControl.layout({
			container: new Dimension(width, titleControl.getHeight().total),
			available: new Dimension(width, 200),
		});
	};
	groupView.relayoutFn = layout;

	titleControl.openEditors(model.getEditors(EditorsOrder.SEQUENTIAL));
	layout();
}

function render(options: IRenderOptions): (ctx: ComponentFixtureContext) => void {
	return (ctx: ComponentFixtureContext) => renderTabBar(ctx, options);
}

// ============================================================================
// Fixtures — at least one per setting that affects the tab bar
// ============================================================================

export default defineThemedFixtureGroup({ path: 'editor/editorTabBar/' }, {
	// Baseline: multiple tabs with mixed sticky / pinned / preview / dirty state.
	Default: defineComponentFixture({ render: render({}) }),

	// showTabs
	ShowTabsSingle: defineComponentFixture({ render: render({ partOptions: { showTabs: 'single' } }) }),
	ShowTabsNone: defineComponentFixture({ render: render({ partOptions: { showTabs: 'none' } }) }),

	// pinnedTabsOnSeparateRow
	PinnedTabsOnSeparateRow: defineComponentFixture({ render: render({ partOptions: { pinnedTabsOnSeparateRow: true }, editors: stickyEditorSpecs() }) }),

	// tabSizing
	TabSizingShrink: defineComponentFixture({ render: render({ partOptions: { tabSizing: 'shrink' }, editors: manyEditorSpecs() }) }),
	TabSizingFixed: defineComponentFixture({ render: render({ partOptions: { tabSizing: 'fixed', tabSizingFixedMinWidth: 60, tabSizingFixedMaxWidth: 120 }, editors: manyEditorSpecs() }) }),

	// tabHeight
	TabHeightCompact: defineComponentFixture({ render: render({ partOptions: { tabHeight: 'compact' } }) }),

	// wrapTabs
	WrapTabs: defineComponentFixture({ render: render({ partOptions: { wrapTabs: true }, editors: manyEditorSpecs(), width: 520 }) }),

	// tabActionLocation
	TabActionLocationLeft: defineComponentFixture({ render: render({ partOptions: { tabActionLocation: 'left' } }) }),

	// tabActionCloseVisibility
	TabActionCloseHidden: defineComponentFixture({ render: render({ partOptions: { tabActionCloseVisibility: false } }) }),

	// tabActionUnpinVisibility (with sticky/compact tabs where the unpin action shows)
	TabActionUnpinHidden: defineComponentFixture({ render: render({ partOptions: { tabActionUnpinVisibility: false, pinnedTabSizing: 'normal' }, editors: stickyEditorSpecs() }) }),

	// showTabIndex
	ShowTabIndex: defineComponentFixture({ render: render({ partOptions: { showTabIndex: true } }) }),

	// highlightModifiedTabs
	HighlightModifiedTabs: defineComponentFixture({ render: render({ partOptions: { highlightModifiedTabs: true }, editors: dirtyEditorSpecs() }) }),

	// labelFormat
	LabelFormatShort: defineComponentFixture({ render: render({ partOptions: { labelFormat: 'short' }, editors: duplicateNameEditorSpecs() }) }),
	LabelFormatMedium: defineComponentFixture({ render: render({ partOptions: { labelFormat: 'medium' }, editors: duplicateNameEditorSpecs() }) }),
	LabelFormatLong: defineComponentFixture({ render: render({ partOptions: { labelFormat: 'long' }, editors: duplicateNameEditorSpecs() }) }),

	// showIcons
	ShowIconsOff: defineComponentFixture({ render: render({ partOptions: { showIcons: false } }) }),

	// decorations (badges + colors)
	DecorationsOff: defineComponentFixture({ render: render({ partOptions: { decorations: { badges: false, colors: false } }, editors: dirtyEditorSpecs() }) }),

	// pinnedTabSizing
	PinnedTabSizingCompact: defineComponentFixture({ render: render({ partOptions: { pinnedTabSizing: 'compact' }, editors: stickyEditorSpecs() }) }),
	PinnedTabSizingShrink: defineComponentFixture({ render: render({ partOptions: { pinnedTabSizing: 'shrink' }, editors: stickyEditorSpecs() }) }),

	// titleScrollbarSizing
	TitleScrollbarLarge: defineComponentFixture({ render: render({ partOptions: { titleScrollbarSizing: 'large' }, editors: manyEditorSpecs(), width: 520 }) }),

	// editorActionsLocation
	EditorActionsHidden: defineComponentFixture({ render: render({ partOptions: { editorActionsLocation: 'hidden' } }) }),

	// alwaysShowEditorActions
	AlwaysShowEditorActions: defineComponentFixture({ render: render({ partOptions: { alwaysShowEditorActions: true } }) }),
});
