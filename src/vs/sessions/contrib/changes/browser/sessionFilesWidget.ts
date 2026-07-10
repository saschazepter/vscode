/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sessionFilesWidget.css';
import * as dom from '../../../../base/browser/dom.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { Gesture, EventType as TouchEventType } from '../../../../base/browser/touch.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toAction } from '../../../../base/common/actions.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable } from '../../../../base/common/observable.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { DEFAULT_LABELS_CONTAINER, IResourceLabel, ResourceLabels } from '../../../../workbench/browser/labels.js';
import { createFileIconThemableTreeContainerScope } from '../../../../workbench/contrib/files/browser/views/explorerView.js';
import { ACTIVE_GROUP, IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ISessionFile, SessionFileOperation } from '../../../services/sessions/common/session.js';
import { ExternalChangesPresentation, externalChangesPresentationObs } from './externalChangesPresentation.js';

const $ = dom.$;

/** Minimal input contract for {@link SessionFilesWidget.setInput}. */
export interface ISessionFilesInput {
	readonly sessionFilesObs: IObservable<readonly ISessionFile[]>;
}

/** A file row (both variants). Carries an optional inline location suffix. */
interface ISessionFileRow {
	readonly kind: 'file';
	readonly file: ISessionFile;
	/** Dimmed parent-folder path shown after the name (Variant A only). */
	readonly location: string | undefined;
}

/** A location group header (Variant B only). */
interface ISessionLocationRow {
	readonly kind: 'group';
	/** Absolute path label of the containing folder. */
	readonly location: string;
}

type SessionFileListRow = ISessionFileRow | ISessionLocationRow;

class SessionFileListDelegate implements IListVirtualDelegate<SessionFileListRow> {
	static readonly ITEM_HEIGHT = 22;

	getHeight(_element: SessionFileListRow): number {
		return SessionFileListDelegate.ITEM_HEIGHT;
	}

	getTemplateId(element: SessionFileListRow): string {
		return element.kind === 'group'
			? SessionLocationRenderer.TEMPLATE_ID
			: SessionFileRowRenderer.TEMPLATE_ID;
	}
}

interface ISessionFileTemplateData {
	readonly root: HTMLElement;
	readonly label: IResourceLabel;
	readonly badge: HTMLElement;
	readonly toolbar: WorkbenchToolBar;
	readonly templateDisposables: DisposableStore;
}

class SessionFileRowRenderer implements IListRenderer<ISessionFileRow, ISessionFileTemplateData> {
	static readonly TEMPLATE_ID = 'sessionFile';
	readonly templateId = SessionFileRowRenderer.TEMPLATE_ID;

	constructor(
		private readonly _labels: ResourceLabels,
		private readonly _onOpenFile: (file: ISessionFile) => void,
		@ILabelService private readonly _labelService: ILabelService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) { }

	renderTemplate(container: HTMLElement): ISessionFileTemplateData {
		const templateDisposables = new DisposableStore();
		const root = dom.append(container, $('.session-files-widget-file'));
		const label = templateDisposables.add(this._labels.create(root));

		// External-location badge: a subtle icon marking the row as living
		// outside the workspace. Shown after the label in the enriched variant.
		const badge = dom.append(root, $('.session-files-widget-external-badge'));
		badge.classList.add(...ThemeIcon.asClassNameArray(Codicon.linkExternal));

		const actionBarContainer = $('.chat-collapsible-list-action-bar');
		const toolbar = templateDisposables.add(this._instantiationService.createInstance(WorkbenchToolBar, actionBarContainer, undefined));
		label.element.appendChild(actionBarContainer);

		return { root, label, badge, toolbar, templateDisposables };
	}

	renderElement(element: ISessionFileRow, _index: number, templateData: ISessionFileTemplateData): void {
		const { file } = element;
		templateData.root.classList.toggle('grouped', element.location === undefined);
		templateData.badge.style.display = element.location !== undefined ? '' : 'none';
		templateData.label.setResource({
			resource: file.uri,
			name: basename(file.uri),
			description: element.location,
		}, {
			fileKind: FileKind.FILE,
			fileDecorations: undefined,
			strikethrough: file.operation === SessionFileOperation.Deleted,
			title: getSessionFileTitle(file, this._labelService),
			descriptionTitle: element.location,
		});

		templateData.toolbar.setActions([toAction({
			id: 'sessionFiles.openFile',
			label: localize('sessionFiles.openFileAction', "Open File"),
			class: ThemeIcon.asClassName(Codicon.goToFile),
			run: () => this._onOpenFile(file),
		})]);
	}

	disposeTemplate(templateData: ISessionFileTemplateData): void {
		templateData.templateDisposables.dispose();
	}
}

interface ISessionLocationTemplateData {
	readonly icon: HTMLElement;
	readonly labelNode: HTMLElement;
}

class SessionLocationRenderer implements IListRenderer<ISessionLocationRow, ISessionLocationTemplateData> {
	static readonly TEMPLATE_ID = 'sessionLocation';
	readonly templateId = SessionLocationRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): ISessionLocationTemplateData {
		const root = dom.append(container, $('.session-files-widget-location'));
		const icon = dom.append(root, $('.session-files-widget-location-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.folderOpened));
		const labelNode = dom.append(root, $('.session-files-widget-location-label'));
		return { icon, labelNode };
	}

	renderElement(element: ISessionLocationRow, _index: number, templateData: ISessionLocationTemplateData): void {
		templateData.labelNode.textContent = element.location;
		templateData.labelNode.title = element.location;
	}

	disposeTemplate(_templateData: ISessionLocationTemplateData): void { }
}

/**
 * A widget that lists the files created, edited or deleted **outside** the
 * session workspace during the session ("external changes"). Rendered between
 * the changes tree and the CI checks widget in the changes view as a resizable
 * SplitView pane.
 *
 * The presentation is driven by {@link externalChangesPresentationObs} so the
 * developer toggle can compare, at runtime, two ways of making it clear the
 * files live elsewhere but are part of the agent's suggestions:
 * - {@link ExternalChangesPresentation.EnrichedSection} (A): a flat list where
 *   each row shows the parent folder inline plus an external badge, with a
 *   footer note.
 * - {@link ExternalChangesPresentation.GroupedByLocation} (B): files grouped
 *   under location headers.
 *
 * The collapse/resize behaviour mirrors {@link CIStatusWidget}.
 */
export class SessionFilesWidget extends Disposable {

	static readonly HEADER_HEIGHT = 32; // 5px section margin + 6px header margin + 28px header
	static readonly FOOTER_HEIGHT = 34; // provenance note shown in the enriched variant
	static readonly MIN_BODY_HEIGHT = 3 * SessionFileListDelegate.ITEM_HEIGHT + 2;
	static readonly PREFERRED_BODY_HEIGHT = 4 * SessionFileListDelegate.ITEM_HEIGHT;
	static readonly MAX_BODY_HEIGHT = 240;

	private readonly _domNode: HTMLElement;
	private readonly _headerNode: HTMLElement;
	private readonly _titleNode: HTMLElement;
	private readonly _titleLabelNode: HTMLElement;
	private readonly _countNode: HTMLElement;
	private readonly _chevronNode: HTMLElement;
	private readonly _bodyNode: HTMLElement;
	private readonly _listContainer: HTMLElement;
	private readonly _footerNode: HTMLElement;
	private readonly _list: WorkbenchList<SessionFileListRow>;
	private readonly _labels: ResourceLabels;

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight = this._onDidChangeHeight.event;

	private readonly _onDidToggleCollapsed = this._register(new Emitter<boolean>());
	readonly onDidToggleCollapsed = this._onDidToggleCollapsed.event;

	private _files: readonly ISessionFile[] = [];
	private _rows: SessionFileListRow[] = [];
	private _fileCount = 0;
	private _collapsed = false;
	private _presentation: ExternalChangesPresentation = externalChangesPresentationObs.get();

	get element(): HTMLElement {
		return this._domNode;
	}

	/** The full content height the widget would like (header + rows + footer). */
	get desiredHeight(): number {
		if (this._fileCount === 0) {
			return 0;
		}
		if (this._collapsed) {
			return SessionFilesWidget.HEADER_HEIGHT;
		}
		return SessionFilesWidget.HEADER_HEIGHT
			+ this._rows.length * SessionFileListDelegate.ITEM_HEIGHT
			+ this._footerHeight();
	}

	/** Whether the widget is currently visible (has files to show). */
	get visible(): boolean {
		return this._fileCount > 0;
	}

	/** Whether the body is collapsed (header-only). */
	get collapsed(): boolean {
		return this._collapsed;
	}

	constructor(
		container: HTMLElement,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILabelService private readonly _labelService: ILabelService,
		@IEditorService private readonly _editorService: IEditorService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IFileService private readonly _fileService: IFileService,
		@IThemeService private readonly _themeService: IThemeService,
	) {
		super();
		this._labels = this._register(this._instantiationService.createInstance(ResourceLabels, DEFAULT_LABELS_CONTAINER));

		this._domNode = dom.append(container, $('.session-files-widget'));
		this._domNode.style.display = 'none';

		// Enable file icons from the active file icon theme for the resource
		// labels rendered in this widget's list.
		this._register(createFileIconThemableTreeContainerScope(this._domNode, this._themeService));

		// Header (always visible, click to collapse/expand)
		this._headerNode = dom.append(this._domNode, $('.session-files-widget-header'));
		this._titleNode = dom.append(this._headerNode, $('.session-files-widget-title'));
		this._titleLabelNode = dom.append(this._titleNode, $('.session-files-widget-title-label'));
		this._titleLabelNode.textContent = localize('sessionFiles.label', "Changes Outside This Workspace");
		// File count shown in the header only while collapsed (mirrors the
		// customizations section in the sessions view).
		this._countNode = dom.append(this._headerNode, $('.session-files-widget-count.hidden'));
		this._chevronNode = dom.append(this._headerNode, $('.group-chevron'));
		this._chevronNode.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown));

		this._headerNode.setAttribute('role', 'button');
		this._headerNode.setAttribute('aria-label', localize('sessionFiles.toggle', "Toggle Changes Outside This Workspace"));
		this._headerNode.setAttribute('aria-expanded', 'true');
		this._headerNode.tabIndex = 0;

		this._register(this._hoverService.setupManagedHover(
			getDefaultHoverDelegate('mouse'),
			this._headerNode,
			localize('sessionFiles.hover', "Files the agent created, edited, or deleted outside this workspace. They are part of the agent's suggestions, but because they live elsewhere they are not committed with the workspace changes."),
		));

		// Register the gesture target so the toggle works on touch platforms
		// (notably iOS) in the Sessions window, then handle both mouse click and
		// touch tap.
		this._register(Gesture.addTarget(this._headerNode));
		for (const eventType of [dom.EventType.CLICK, TouchEventType.Tap]) {
			this._register(dom.addDisposableListener(this._headerNode, eventType, () => {
				this._toggleCollapsed();
			}));
		}
		this._register(dom.addDisposableListener(this._headerNode, dom.EventType.KEY_DOWN, e => {
			if ((e.key === 'Enter' || e.key === ' ') && e.target === this._headerNode) {
				e.preventDefault();
				this._toggleCollapsed();
			}
		}));

		// Body (list of files + optional footer note)
		const bodyId = 'session-files-widget-body';
		this._bodyNode = dom.append(this._domNode, $(`.${bodyId}`));
		this._bodyNode.id = bodyId;
		this._headerNode.setAttribute('aria-controls', bodyId);

		this._listContainer = $('.session-files-widget-list');
		this._list = this._register(this._instantiationService.createInstance(
			WorkbenchList<SessionFileListRow>,
			'SessionFilesWidget',
			this._listContainer,
			new SessionFileListDelegate(),
			[
				this._instantiationService.createInstance(SessionFileRowRenderer, this._labels, (file: ISessionFile) => this._openFilePlain(file)),
				new SessionLocationRenderer(),
			],
			{
				multipleSelectionSupport: false,
				openOnSingleClick: true,
				accessibilityProvider: {
					getWidgetAriaLabel: () => localize('sessionFiles.listAriaLabel', "Changes Outside This Workspace"),
					getAriaLabel: row => row.kind === 'group'
						? localize('sessionFiles.locationAriaLabel', "Location {0}", row.location)
						: localize('sessionFiles.fileAriaLabel', "{0}, {1}", basename(row.file.uri), getSessionFileOperationLabel(row.file.operation)),
				},
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: row => row.kind === 'group' ? row.location : basename(row.file.uri),
				},
			},
		));
		this._bodyNode.appendChild(this._listContainer);

		// Footer provenance note (enriched variant only).
		this._footerNode = dom.append(this._bodyNode, $('.session-files-widget-footer'));
		const footerIcon = dom.append(this._footerNode, $('.session-files-widget-footer-icon'));
		footerIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.info));
		const footerText = dom.append(this._footerNode, $('.session-files-widget-footer-text'));
		footerText.textContent = localize('sessionFiles.footerNote', "Part of the agent's suggestions, kept outside this workspace and not committed with it.");
		this._footerNode.style.display = 'none';

		this._register(this._list.onDidOpen(e => {
			if (e.element && e.element.kind === 'file') {
				void this._openFile(e.element.file, !!e.editorOptions?.preserveFocus, !!e.editorOptions?.pinned);
			}
		}));

		// Re-render whenever the developer toggle switches the presentation.
		this._register(autorun(reader => {
			const presentation = externalChangesPresentationObs.read(reader);
			if (presentation === this._presentation) {
				return;
			}
			this._presentation = presentation;
			this._rebuild();
		}));
	}

	setInput(input: ISessionFilesInput): IDisposable {
		return autorun(reader => {
			this._files = input.sessionFilesObs.read(reader);
			this._rebuild();
		});
	}

	/** Rebuild the row model and DOM from the current files + presentation. */
	private _rebuild(): void {
		const oldRowCount = this._rows.length;
		this._fileCount = this._files.length;
		this._rows = this._buildRows(this._files);

		if (this._fileCount === 0) {
			this._setCollapsed(false);
			this._list.splice(0, this._list.length, []);
			this._footerNode.style.display = 'none';
			this._domNode.style.display = 'none';
			if (oldRowCount !== 0) {
				this._onDidChangeHeight.fire();
			}
			return;
		}

		this._domNode.style.display = '';
		this._list.splice(0, this._list.length, this._rows);
		this._renderCount();
		this._updateFooterVisibility();

		if (this._rows.length !== oldRowCount) {
			this._onDidChangeHeight.fire();
		}
	}

	/** Build the flat row list for the active presentation. */
	private _buildRows(files: readonly ISessionFile[]): SessionFileListRow[] {
		if (this._presentation === ExternalChangesPresentation.GroupedByLocation) {
			return this._buildGroupedRows(files);
		}
		// Enriched (A): one file row per file, with the parent folder inline.
		return files.map(file => ({
			kind: 'file',
			file,
			location: this._locationLabel(file.uri),
		} satisfies ISessionFileRow));
	}

	/** Group files under their containing folder, preserving first-seen order. */
	private _buildGroupedRows(files: readonly ISessionFile[]): SessionFileListRow[] {
		const groups = new Map<string, ISessionFile[]>();
		for (const file of files) {
			const location = this._locationLabel(file.uri);
			const bucket = groups.get(location);
			if (bucket) {
				bucket.push(file);
			} else {
				groups.set(location, [file]);
			}
		}
		const rows: SessionFileListRow[] = [];
		for (const [location, bucket] of groups) {
			rows.push({ kind: 'group', location } satisfies ISessionLocationRow);
			for (const file of bucket) {
				rows.push({ kind: 'file', file, location: undefined } satisfies ISessionFileRow);
			}
		}
		return rows;
	}

	private _locationLabel(uri: URI): string {
		return this._labelService.getUriLabel(dirname(uri));
	}

	private _footerHeight(): number {
		return this._presentation === ExternalChangesPresentation.EnrichedSection && this._fileCount > 0
			? SessionFilesWidget.FOOTER_HEIGHT
			: 0;
	}

	private _updateFooterVisibility(): void {
		const showFooter = !this._collapsed && this._footerHeight() > 0;
		this._footerNode.style.display = showFooter ? '' : 'none';
	}

	/**
	 * Layout the widget body (list + optional footer) to the given height.
	 * Called by the parent view after computing available space.
	 */
	layout(height: number): void {
		if (this._collapsed) {
			this._bodyNode.style.display = 'none';
			return;
		}
		this._bodyNode.style.display = '';
		this._updateFooterVisibility();
		const listHeight = Math.max(0, height - this._footerHeight());
		// Pin the list container height explicitly so the footer note (appended
		// after it in the body) is not pushed out and clipped by the body's
		// overflow. Inline style wins over the stylesheet's height: 100%.
		this._listContainer.style.height = `${listHeight}px`;
		this._list.layout(listHeight);
	}

	private _toggleCollapsed(): void {
		this._setCollapsed(!this._collapsed);
		this._onDidToggleCollapsed.fire(this._collapsed);
		this._onDidChangeHeight.fire();
	}

	/**
	 * Expand the body if it is currently collapsed, notifying listeners so the
	 * parent pane restores its size. No-op when already expanded.
	 */
	expand(): void {
		if (!this._collapsed) {
			return;
		}
		this._setCollapsed(false);
		this._onDidToggleCollapsed.fire(false);
		this._onDidChangeHeight.fire();
	}

	/**
	 * Move keyboard focus into the files list. Falls back to the header when the
	 * body is collapsed or there is nothing to focus.
	 */
	focus(): void {
		if (this._collapsed || this._fileCount === 0) {
			this._headerNode.focus();
			return;
		}
		this._list.domFocus();
		if (this._list.length > 0 && this._list.getFocus().length === 0) {
			this._list.setFocus([0]);
		}
	}

	private _setCollapsed(collapsed: boolean): void {
		this._collapsed = collapsed;
		this._updateChevron();
		this._headerNode.classList.toggle('collapsed', collapsed);
		this._headerNode.setAttribute('aria-expanded', String(!collapsed));
		this._renderCount();
		this._updateFooterVisibility();
	}

	/** Show the file count in the header only while collapsed. */
	private _renderCount(): void {
		this._countNode.textContent = this._fileCount > 0 ? `${this._fileCount}` : '';
		this._countNode.classList.toggle('hidden', !this._collapsed || this._fileCount === 0);
	}

	private _updateChevron(): void {
		this._chevronNode.className = 'group-chevron';
		this._chevronNode.classList.add(
			...ThemeIcon.asClassNameArray(
				this._collapsed ? Codicon.chevronRight : Codicon.chevronDown
			)
		);
	}

	private async _openFile(file: ISessionFile, preserveFocus: boolean, pinned: boolean): Promise<void> {
		// Created and deleted files open normally; modified files open a diff
		// against their pre-session content when it is available and non-empty.
		if (file.operation === SessionFileOperation.Modified && file.originalUri && await this._hasContent(file.originalUri)) {
			await this._editorService.openEditor({
				original: { resource: file.originalUri },
				modified: { resource: file.uri },
				label: getDiffEditorLabel(file.uri, this._labelService),
				options: { preserveFocus, pinned },
			}, ACTIVE_GROUP);
			return;
		}

		await this._editorService.openEditor({
			resource: file.uri,
			options: { preserveFocus, pinned },
		}, ACTIVE_GROUP);
	}

	private async _hasContent(resource: URI): Promise<boolean> {
		try {
			const content = await this._fileService.readFile(resource);
			return content.value.byteLength > 0;
		} catch {
			return false;
		}
	}

	/** Open the file in a normal editor, ignoring the pre-session diff. */
	private _openFilePlain(file: ISessionFile): void {
		void this._editorService.openEditor({ resource: file.uri }, ACTIVE_GROUP);
	}
}

function getSessionFileOperationLabel(operation: SessionFileOperation): string {
	switch (operation) {
		case SessionFileOperation.Created:
			return localize('sessionFiles.created', "Created");
		case SessionFileOperation.Modified:
			return localize('sessionFiles.modified', "Modified");
		case SessionFileOperation.Deleted:
			return localize('sessionFiles.deleted', "Deleted");
	}
}

function getSessionFileTitle(file: ISessionFile, labelService: ILabelService): string {
	const path = labelService.getUriLabel(file.uri);
	return localize('sessionFiles.title', "{0} ({1})", path, getSessionFileOperationLabel(file.operation));
}

function getDiffEditorLabel(uri: URI, labelService: ILabelService): string {
	return localize('sessionFiles.diffLabel', "{0} (Session Changes)", basename(uri) || labelService.getUriLabel(uri));
}
