/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './projectBarPart.css';
import { Part } from '../../../../browser/part.js';
import { IWorkbenchLayoutService, Parts, Position } from '../../../../services/layout/browser/layoutService.js';
import { IColorTheme, IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ACTIVITY_BAR_BACKGROUND, ACTIVITY_BAR_BADGE_BACKGROUND, ACTIVITY_BAR_BADGE_FOREGROUND, ACTIVITY_BAR_BORDER, ACTIVITY_BAR_FOREGROUND, ACTIVITY_BAR_INACTIVE_FOREGROUND } from '../../../../common/theme.js';
import { contrastBorder } from '../../../../../platform/theme/common/colorRegistry.js';
import { assertReturnsDefined } from '../../../../../base/common/types.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { GlobalCompositeBar } from '../../../../browser/parts/globalCompositeBar.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IAction, Action } from '../../../../../base/common/actions.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IWorkspaceEditingService } from '../../../../services/workspaces/common/workspaceEditing.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { basename } from '../../../../../base/common/resources.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';

const HOVER_GROUP_ID = 'projectbar';
const PROJECT_BAR_FOLDERS_KEY = 'workbench.agentsession.projectbar.folders';

interface IProjectBarEntry {
	readonly uri: URI;
	readonly name: string;
}

/**
 * ProjectBarPart displays project folder entries stored in workspace storage and allows selection between them.
 * When a folder is selected, the workspace editing service is used to replace the current workspace folder
 * with the selected one. It is positioned to the left of the sidebar and has the same visual style as the activity bar.
 * Also includes global activities (accounts, settings) at the bottom.
 */
export class ProjectBarPart extends Part {

	static readonly ACTION_HEIGHT = 48;

	//#region IView

	readonly minimumWidth: number = 48;
	readonly maximumWidth: number = 48;
	readonly minimumHeight: number = 0;
	readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	//#endregion

	private content: HTMLElement | undefined;
	private actionsContainer: HTMLElement | undefined;
	private addFolderButton: HTMLElement | undefined;
	private entries: IProjectBarEntry[] = [];
	private _selectedFolderUri: URI | undefined;
	private readonly globalCompositeBar: GlobalCompositeBar;

	private readonly workspaceEntryDisposables = this._register(new MutableDisposable<DisposableStore>());

	private readonly _onDidSelectWorkspace = this._register(new Emitter<URI | undefined>());
	readonly onDidSelectWorkspace: Event<URI | undefined> = this._onDidSelectWorkspace.event;

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IPathService private readonly pathService: IPathService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@ILabelService private readonly labelService: ILabelService,
		@IHoverService private readonly hoverService: IHoverService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(Parts.PROJECTBAR_PART, { hasTitle: false }, themeService, storageService, layoutService);

		// Create the global composite bar for accounts and settings at the bottom
		this.globalCompositeBar = this._register(instantiationService.createInstance(
			GlobalCompositeBar,
			() => this.getContextMenuActions(),
			(theme: IColorTheme) => ({
				activeForegroundColor: theme.getColor(ACTIVITY_BAR_FOREGROUND),
				inactiveForegroundColor: theme.getColor(ACTIVITY_BAR_INACTIVE_FOREGROUND),
				badgeBackground: theme.getColor(ACTIVITY_BAR_BADGE_BACKGROUND),
				badgeForeground: theme.getColor(ACTIVITY_BAR_BADGE_FOREGROUND),
				activeBackgroundColor: undefined,
				inactiveBackgroundColor: undefined,
				activeBorderBottomColor: undefined,
			}),
			{
				position: () => this.layoutService.getSideBarPosition() === Position.LEFT ? HoverPosition.RIGHT : HoverPosition.LEFT,
			}
		));

		// Load entries from storage
		this.loadEntriesFromStorage();
	}

	private getContextMenuActions(): IAction[] {
		return this.globalCompositeBar.getContextMenuActions();
	}

	private loadEntriesFromStorage(): void {
		const raw = this.storageService.get(PROJECT_BAR_FOLDERS_KEY, StorageScope.WORKSPACE);
		if (raw) {
			try {
				const uris: string[] = JSON.parse(raw);
				this.entries = uris.map(uriStr => {
					const uri = URI.parse(uriStr);
					return { uri, name: basename(uri) };
				});
			} catch {
				this.entries = [];
			}
		} else {
			this.entries = [];
		}

		// The selected folder is always the first workspace folder
		const currentFolders = this.workspaceContextService.getWorkspace().folders;
		this._selectedFolderUri = currentFolders.length > 0 ? currentFolders[0].uri : undefined;
	}

	private saveEntriesToStorage(): void {
		const uris = this.entries.map(e => e.uri.toString());
		this.storageService.store(PROJECT_BAR_FOLDERS_KEY, JSON.stringify(uris), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private addFolderEntry(uri: URI): void {
		// Don't add duplicates
		if (this.entries.some(e => e.uri.toString() === uri.toString())) {
			return;
		}

		this.entries.push({ uri, name: basename(uri) });
		this.saveEntriesToStorage();

		// Select the newly added folder
		this._selectedFolderUri = uri;
		this.saveEntriesToStorage();
		this.applySelectedFolder();
		this._onDidSelectWorkspace.fire(this._selectedFolderUri);

		this.renderContent();
	}

	private async applySelectedFolder(): Promise<void> {
		if (!this._selectedFolderUri) {
			return;
		}

		const currentFolders = this.workspaceContextService.getWorkspace().folders;
		const foldersToRemove = currentFolders.map(f => f.uri);

		// Remove existing workspace folders and add the selected one
		await this.workspaceEditingService.updateFolders(
			0,
			foldersToRemove.length,
			[{ uri: this._selectedFolderUri }]
		);
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		this.content = append(this.element, $('.content'));

		// Create actions container for workspace folders and add button
		this.actionsContainer = append(this.content, $('.actions-container'));

		// Create the UI for workspace folders
		this.renderContent();

		// Create global composite bar at the bottom (accounts, settings)
		this.globalCompositeBar.create(this.content);

		return this.content;
	}

	private renderContent(): void {
		if (!this.actionsContainer) {
			return;
		}

		// Clear existing content
		clearNode(this.actionsContainer);
		this.workspaceEntryDisposables.value = new DisposableStore();

		// Create add folder button
		this.createAddFolderButton(this.actionsContainer);

		// Create workspace folder entries
		this.createWorkspaceEntries(this.actionsContainer);
	}

	private createAddFolderButton(container: HTMLElement): void {
		this.addFolderButton = append(container, $('.action-item.add-folder'));
		const actionLabel = append(this.addFolderButton, $('span.action-label'));

		// Add the plus icon using codicon
		actionLabel.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));

		// Add hover tooltip
		this.workspaceEntryDisposables.value?.add(
			this.hoverService.setupDelayedHover(
				this.addFolderButton,
				{
					appearance: { showPointer: true },
					position: { hoverPosition: HoverPosition.RIGHT },
					content: 'Add Folder to Project'
				},
				{ groupId: HOVER_GROUP_ID }
			)
		);

		// Click handler to add folder
		this.workspaceEntryDisposables.value?.add(
			addDisposableListener(this.addFolderButton, EventType.CLICK, () => {
				this.pickAndAddFolder();
			})
		);

		// Keyboard support
		this.addFolderButton.setAttribute('tabindex', '0');
		this.addFolderButton.setAttribute('role', 'button');
		this.addFolderButton.setAttribute('aria-label', 'Add Folder to Project');
		this.workspaceEntryDisposables.value?.add(
			addDisposableListener(this.addFolderButton, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					this.pickAndAddFolder();
				}
			})
		);
	}

	private async pickAndAddFolder(): Promise<void> {
		const folders = await this.fileDialogService.showOpenDialog({
			openLabel: 'Add',
			title: 'Add Folder to Project',
			canSelectFolders: true,
			canSelectMany: false,
			defaultUri: await this.fileDialogService.defaultFolderPath(),
			availableFileSystems: [this.pathService.defaultUriScheme]
		});

		if (folders?.length) {
			this.addFolderEntry(folders[0]);
		}
	}

	private createWorkspaceEntries(container: HTMLElement): void {
		for (let i = 0; i < this.entries.length; i++) {
			this.createWorkspaceEntry(container, this.entries[i], i);
		}

		// Auto-select first entry if available and none selected
		if (this.entries.length > 0 && this._selectedFolderUri) {
			this._onDidSelectWorkspace.fire(this._selectedFolderUri);
		}
	}

	private createWorkspaceEntry(container: HTMLElement, entry: IProjectBarEntry, index: number): void {
		const entryDisposables = this.workspaceEntryDisposables.value!;

		const entryElement = append(container, $('.action-item.workspace-entry'));
		const actionLabel = append(entryElement, $('span.action-label.workspace-icon'));
		append(entryElement, $('span.active-item-indicator'));

		// Get first letter of folder name
		const folderName = entry.name;
		const firstLetter = folderName.charAt(0).toUpperCase();
		actionLabel.textContent = firstLetter;

		// Set selected state
		const isSelected = this._selectedFolderUri?.toString() === entry.uri.toString();
		if (isSelected) {
			entryElement.classList.add('checked');
		}

		// Build hover content with full path
		const folderPath = this.labelService.getUriLabel(entry.uri, { relative: false });

		// Add hover tooltip with folder name
		entryDisposables.add(
			this.hoverService.setupDelayedHover(
				entryElement,
				{
					appearance: { showPointer: true },
					position: { hoverPosition: HoverPosition.RIGHT },
					content: folderPath
				},
				{ groupId: HOVER_GROUP_ID }
			)
		);

		// Click handler to select workspace
		entryDisposables.add(
			addDisposableListener(entryElement, EventType.CLICK, () => {
				this.selectWorkspace(index);
			})
		);

		// Keyboard support
		entryElement.setAttribute('tabindex', '0');
		entryElement.setAttribute('role', 'button');
		entryElement.setAttribute('aria-label', folderName);
		entryElement.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
		entryDisposables.add(
			addDisposableListener(entryElement, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					this.selectWorkspace(index);
				}
			})
		);

		// Context menu with remove action
		entryDisposables.add(
			addDisposableListener(entryElement, EventType.CONTEXT_MENU, (e: MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
				const event = new StandardMouseEvent(getWindow(entryElement), e);
				this.contextMenuService.showContextMenu({
					getAnchor: () => event,
					getActions: () => [
						new Action('projectbar.removeFolder', 'Remove Folder', undefined, true, () => this.removeFolderEntry(index))
					]
				});
			})
		);
	}

	private selectWorkspace(index: number): void {
		if (index < 0 || index >= this.entries.length) {
			return;
		}

		const entry = this.entries[index];
		if (this._selectedFolderUri?.toString() === entry.uri.toString()) {
			return; // Already selected
		}

		this._selectedFolderUri = entry.uri;
		this.saveEntriesToStorage();

		// Re-render to update visual state
		this.renderContent();

		// Apply the selected folder as the workspace folder
		this.applySelectedFolder();

		// Fire selection event
		this._onDidSelectWorkspace.fire(this._selectedFolderUri);
	}

	private removeFolderEntry(index: number): void {
		if (index < 0 || index >= this.entries.length) {
			return;
		}

		const removedUri = this.entries[index].uri;
		this.entries.splice(index, 1);
		this.saveEntriesToStorage();

		// If the removed entry was the selected one, select the first remaining entry
		if (this._selectedFolderUri?.toString() === removedUri.toString()) {
			if (this.entries.length > 0) {
				this._selectedFolderUri = this.entries[0].uri;
				this.applySelectedFolder();
				this._onDidSelectWorkspace.fire(this._selectedFolderUri);
			} else {
				this._selectedFolderUri = undefined;
				this._onDidSelectWorkspace.fire(undefined);
			}
		}

		this.renderContent();
	}

	get selectedWorkspaceFolder(): URI | undefined {
		return this._selectedFolderUri;
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());
		const background = this.getColor(ACTIVITY_BAR_BACKGROUND) || '';
		container.style.backgroundColor = background;

		const borderColor = this.getColor(ACTIVITY_BAR_BORDER) || this.getColor(contrastBorder) || '';
		container.classList.toggle('bordered', !!borderColor);
		container.style.borderColor = borderColor ? borderColor : '';
	}

	focus(): void {
		// Focus the add folder button (first focusable element)
		this.addFolderButton?.focus();
	}

	focusGlobalCompositeBar(): void {
		this.globalCompositeBar.focus();
	}

	override layout(width: number, height: number): void {
		super.layout(width, height, 0, 0);

		// The global composite bar takes some height at the bottom
		// The actions container will take the remaining space due to CSS flex layout
	}

	toJSON(): object {
		return {
			type: Parts.PROJECTBAR_PART
		};
	}
}
