/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './projectBarPart.css';
import { Part } from '../../../../browser/part.js';
import { IWorkbenchLayoutService, Parts, Position } from '../../../../services/layout/browser/layoutService.js';
import { IColorTheme, IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, IWorkspaceFolder, IWorkspaceFoldersChangeEvent } from '../../../../../platform/workspace/common/workspace.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ACTIVITY_BAR_BACKGROUND, ACTIVITY_BAR_BADGE_BACKGROUND, ACTIVITY_BAR_BADGE_FOREGROUND, ACTIVITY_BAR_BORDER, ACTIVITY_BAR_FOREGROUND, ACTIVITY_BAR_INACTIVE_FOREGROUND } from '../../../../common/theme.js';
import { contrastBorder } from '../../../../../platform/theme/common/colorRegistry.js';
import { assertReturnsDefined } from '../../../../../base/common/types.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { GlobalCompositeBar } from '../../../../browser/parts/globalCompositeBar.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IAction } from '../../../../../base/common/actions.js';

const HOVER_GROUP_ID = 'projectbar';

/**
 * ProjectBarPart displays workspace folders and allows selection between them.
 * It is positioned to the left of the sidebar and has the same visual style as the activity bar.
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
	private workspaceFolders: IWorkspaceFolder[] = [];
	private _selectedFolderIndex: number = 0;
	private readonly globalCompositeBar: GlobalCompositeBar;

	private readonly workspaceEntryDisposables = this._register(new MutableDisposable<DisposableStore>());

	private readonly _onDidSelectWorkspace = this._register(new Emitter<IWorkspaceFolder | undefined>());
	readonly onDidSelectWorkspace: Event<IWorkspaceFolder | undefined> = this._onDidSelectWorkspace.event;

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ICommandService private readonly commandService: ICommandService,
		@IHoverService private readonly hoverService: IHoverService,
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

		// Listen for workspace folder changes
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(e => this.onWorkspaceFoldersChanged(e)));
	}

	private getContextMenuActions(): IAction[] {
		return this.globalCompositeBar.getContextMenuActions();
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		this.content = append(this.element, $('.content'));

		// Initialize workspace folders
		this.workspaceFolders = this.workspaceContextService.getWorkspace().folders;

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
					content: 'Add Folder to Workspace'
				},
				{ groupId: HOVER_GROUP_ID }
			)
		);

		// Click handler to add folder
		this.workspaceEntryDisposables.value?.add(
			addDisposableListener(this.addFolderButton, EventType.CLICK, () => {
				this.commandService.executeCommand('workbench.action.addRootFolder');
			})
		);

		// Keyboard support
		this.addFolderButton.setAttribute('tabindex', '0');
		this.addFolderButton.setAttribute('role', 'button');
		this.addFolderButton.setAttribute('aria-label', 'Add Folder to Workspace');
		this.workspaceEntryDisposables.value?.add(
			addDisposableListener(this.addFolderButton, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					this.commandService.executeCommand('workbench.action.addRootFolder');
				}
			})
		);
	}

	private createWorkspaceEntries(container: HTMLElement): void {
		for (let i = 0; i < this.workspaceFolders.length; i++) {
			this.createWorkspaceEntry(container, this.workspaceFolders[i], i);
		}

		// Auto-select first folder if available and none selected
		if (this.workspaceFolders.length > 0 && this._selectedFolderIndex >= 0) {
			this._onDidSelectWorkspace.fire(this.workspaceFolders[this._selectedFolderIndex]);
		}
	}

	private createWorkspaceEntry(container: HTMLElement, folder: IWorkspaceFolder, index: number): void {
		const entryDisposables = this.workspaceEntryDisposables.value!;

		const entry = append(container, $('.action-item.workspace-entry'));
		const actionLabel = append(entry, $('span.action-label.workspace-icon'));
		append(entry, $('span.active-item-indicator'));

		// Get first letter of workspace name
		const folderName = folder.name;
		const firstLetter = folderName.charAt(0).toUpperCase();
		actionLabel.textContent = firstLetter;

		// Set selected state
		if (index === this._selectedFolderIndex) {
			entry.classList.add('checked');
		}

		// Add hover tooltip with folder name
		entryDisposables.add(
			this.hoverService.setupDelayedHover(
				entry,
				{
					appearance: { showPointer: true },
					position: { hoverPosition: HoverPosition.RIGHT },
					content: folderName
				},
				{ groupId: HOVER_GROUP_ID }
			)
		);

		// Click handler to select workspace
		entryDisposables.add(
			addDisposableListener(entry, EventType.CLICK, () => {
				this.selectWorkspace(index);
			})
		);

		// Keyboard support
		entry.setAttribute('tabindex', '0');
		entry.setAttribute('role', 'button');
		entry.setAttribute('aria-label', folderName);
		entry.setAttribute('aria-pressed', index === this._selectedFolderIndex ? 'true' : 'false');
		entryDisposables.add(
			addDisposableListener(entry, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					this.selectWorkspace(index);
				}
			})
		);
	}

	private selectWorkspace(index: number): void {
		if (index < 0 || index >= this.workspaceFolders.length) {
			return;
		}

		if (this._selectedFolderIndex === index) {
			return; // Already selected
		}

		this._selectedFolderIndex = index;

		// Re-render to update visual state
		this.renderContent();

		// Fire selection event
		this._onDidSelectWorkspace.fire(this.workspaceFolders[index]);
	}

	private onWorkspaceFoldersChanged(e: IWorkspaceFoldersChangeEvent): void {
		// Update workspace folders
		this.workspaceFolders = this.workspaceContextService.getWorkspace().folders;

		// Adjust selected index if needed
		if (this._selectedFolderIndex >= this.workspaceFolders.length) {
			this._selectedFolderIndex = Math.max(0, this.workspaceFolders.length - 1);
		}

		// Re-render
		this.renderContent();

		// Fire selection event if we have folders
		if (this.workspaceFolders.length > 0) {
			this._onDidSelectWorkspace.fire(this.workspaceFolders[this._selectedFolderIndex]);
		} else {
			this._onDidSelectWorkspace.fire(undefined);
		}
	}

	get selectedWorkspaceFolder(): IWorkspaceFolder | undefined {
		if (this._selectedFolderIndex >= 0 && this._selectedFolderIndex < this.workspaceFolders.length) {
			return this.workspaceFolders[this._selectedFolderIndex];
		}
		return undefined;
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
