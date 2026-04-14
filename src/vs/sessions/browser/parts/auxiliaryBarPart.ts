/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../workbench/browser/parts/auxiliarybar/media/auxiliaryBarPart.css';
import './media/auxiliaryBarPart.css';
import * as dom from '../../../base/browser/dom.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IContextKeyService, IContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { ActiveAuxiliaryContext, AuxiliaryBarFocusContext } from '../../../workbench/common/contextkeys.js';
import { ACTIVITY_BAR_BADGE_BACKGROUND, ACTIVITY_BAR_BADGE_FOREGROUND, ACTIVITY_BAR_TOP_ACTIVE_BORDER, ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER, ACTIVITY_BAR_TOP_FOREGROUND, ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND, PANEL_ACTIVE_TITLE_BORDER, PANEL_ACTIVE_TITLE_FOREGROUND, PANEL_BORDER, PANEL_DRAG_AND_DROP_BORDER, PANEL_INACTIVE_TITLE_FOREGROUND, SIDE_BAR_TITLE_BORDER, SIDE_BAR_FOREGROUND } from '../../../workbench/common/theme.js';
import { contrastBorder } from '../../../platform/theme/common/colorRegistry.js';
import { sessionsAuxiliaryBarBackground } from '../../common/theme.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../workbench/common/views.js';
import { IExtensionService } from '../../../workbench/services/extensions/common/extensions.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { HoverPosition } from '../../../base/browser/ui/hover/hoverWidget.js';
import { IAction } from '../../../base/common/actions.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { LayoutPriority } from '../../../base/browser/ui/splitview/splitview.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../../../workbench/browser/parts/paneCompositePart.js';
import { Part } from '../../../workbench/browser/part.js';
import { ActionsOrientation, IActionViewItem } from '../../../base/browser/ui/actionbar/actionbar.js';
import { IPaneCompositeBarOptions } from '../../../workbench/browser/parts/paneCompositeBar.js';
import { IMenuService, IMenu, MenuId, MenuItemAction } from '../../../platform/actions/common/actions.js';
import { Menus } from '../menus.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { DropdownWithPrimaryActionViewItem } from '../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import { IBaseActionViewItemOptions } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { getFlatContextMenuActions } from '../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IDisposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { Extensions } from '../../../workbench/browser/panecomposite.js';
import { DiffPreviewWidget, IDiffPreviewFile } from './diffPreviewWidget.js';
import { DiffPreviewVisibleContext, DiffPreviewFullWidthContext } from '../../common/contextkeys.js';
import { Sash, Orientation as SashOrientation, ISashEvent, SashState } from '../../../base/browser/ui/sash/sash.js';

/**
 * Auxiliary bar part specifically for agent sessions workbench.
 * This is a simplified version of the AuxiliaryBarPart for agent session contexts.
 */
export class AuxiliaryBarPart extends AbstractPaneCompositePart {

	static readonly activeViewSettingsKey = 'workbench.agentsession.auxiliarybar.activepanelid';
	static readonly pinnedViewsKey = 'workbench.agentsession.auxiliarybar.pinnedPanels';
	static readonly placeholderViewContainersKey = 'workbench.agentsession.auxiliarybar.placeholderPanels';
	static readonly viewContainersWorkspaceStateKey = 'workbench.agentsession.auxiliarybar.viewContainersWorkspaceState';

	/** Visual margin values for the card-like appearance */
	static readonly MARGIN_TOP = 10;
	static readonly MARGIN_BOTTOM = 0;
	static readonly MARGIN_RIGHT = 10;

	// Action ID for run script - defined here to avoid layering issues
	private static readonly RUN_SCRIPT_ACTION_ID = 'workbench.action.agentSessions.runScript';
	private static readonly RUN_SCRIPT_DROPDOWN_MENU_ID = MenuId.for('AgentSessionsRunScriptDropdown');

	// Run script dropdown management
	private readonly _runScriptDropdown = this._register(new MutableDisposable<DropdownWithPrimaryActionViewItem>());
	private readonly _runScriptMenu = this._register(new MutableDisposable<IMenu>());
	private readonly _runScriptMenuListener = this._register(new MutableDisposable<IDisposable>());

	// Sessions-specific auxiliary bar dimensions (intentionally not tied to the sessions SidebarPart values)
	override readonly minimumWidth: number = 270;
	override readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	override readonly minimumHeight: number = 0;
	override readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	get preferredHeight(): number | undefined {
		return this.layoutService.mainContainerDimension.height * 0.4;
	}

	get preferredWidth(): number | undefined {
		const activeComposite = this.getActivePaneComposite();

		if (!activeComposite) {
			return undefined;
		}

		const width = activeComposite.getOptimalWidth();
		if (typeof width !== 'number') {
			return undefined;
		}

		return Math.max(width, 380);
	}

	readonly priority = LayoutPriority.Low;

	// Diff preview state
	private diffPreviewContainer: HTMLElement | undefined;
	private diffPreviewWidget: DiffPreviewWidget | undefined;
	private diffPreviewSash: Sash | undefined;
	private diffPreviewWidth = 0;
	private diffPreviewVisibleContextKey: IContextKey<boolean>;
	private diffPreviewFullWidthContextKey: IContextKey<boolean>;
	private lastLayoutWidth = 0;
	private savedAuxBarWidth = 0; // absolute width before diff preview was opened

	// Full-width mode: saved visibility state to restore when exiting
	private savedSidebarVisible: boolean | undefined;
	private savedChatBarVisible: boolean | undefined;

	constructor(
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IExtensionService extensionService: IExtensionService,
		@IMenuService menuService: IMenuService,
	) {
		super(
			Parts.AUXILIARYBAR_PART,
			{
				hasTitle: true,
				trailingSeparator: false,
				borderWidth: () => 0,
			},
			AuxiliaryBarPart.activeViewSettingsKey,
			ActiveAuxiliaryContext.bindTo(contextKeyService),
			AuxiliaryBarFocusContext.bindTo(contextKeyService),
			'auxiliarybar',
			'auxiliarybar',
			undefined,
			SIDE_BAR_TITLE_BORDER,
			ViewContainerLocation.AuxiliaryBar,
			Extensions.Auxiliary,
			Menus.AuxiliaryBarTitle,
			Menus.AuxiliaryBarTitleLeft,
			notificationService,
			storageService,
			contextMenuService,
			layoutService,
			keybindingService,
			hoverService,
			instantiationService,
			themeService,
			viewDescriptorService,
			contextKeyService,
			extensionService,
			menuService,
		);

		this.diffPreviewVisibleContextKey = DiffPreviewVisibleContext.bindTo(contextKeyService);
		this.diffPreviewFullWidthContextKey = DiffPreviewFullWidthContext.bindTo(contextKeyService);
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		parent.setAttribute('role', 'complementary');
		parent.setAttribute('aria-label', localize('auxiliaryBarAriaLabel', "Session Details"));

		// Add the diff preview container as the first child. It's absolutely positioned
		// and does not interfere with the existing title/content direct-child selectors.
		this.diffPreviewContainer = dom.$('.auxbar-diff-preview');
		this.diffPreviewContainer.style.display = 'none';
		parent.insertBefore(this.diffPreviewContainer, parent.firstChild);
		parent.classList.add('has-diff-preview-host');

		// Create the sash between diff preview and content — placed directly in the part
		this.diffPreviewSash = this._register(new Sash(parent, {
			getVerticalSashLeft: () => this.diffPreviewWidth,
		}, { orientation: SashOrientation.VERTICAL }));
		this.diffPreviewSash.state = SashState.Disabled;

		let sashStartWidth = 0;
		this._register(this.diffPreviewSash.onDidStart((e: ISashEvent) => {
			sashStartWidth = this.diffPreviewWidth;
		}));
		this._register(this.diffPreviewSash.onDidChange((e: ISashEvent) => {
			const delta = e.currentX - e.startX;
			const newWidth = Math.max(200, Math.min(sashStartWidth + delta, this.lastLayoutWidth - 270));
			this.diffPreviewWidth = newWidth;
			this.relayoutWithDiffPreview();
		}));

		// Create the diff preview widget
		this.diffPreviewWidget = this._register(this.instantiationService.createInstance(DiffPreviewWidget, this.diffPreviewContainer));
	}

	/**
	 * Toggle the diff preview pane. Expands/retracts the aux bar width.
	 */
	toggleDiffPreview(files?: readonly IDiffPreviewFile[]): void {
		if (!this.diffPreviewContainer || !this.diffPreviewWidget || !this.diffPreviewSash) {
			return;
		}

		const isVisible = this.diffPreviewContainer.style.display !== 'none';

		if (isVisible) {
			// If in full-width mode, restore panels first
			if (this.isDiffPreviewFullWidth) {
				this.toggleFullWidth();
			}
			// Hide
			this.diffPreviewWidget.hide();
			this.diffPreviewContainer.style.display = 'none';
			this.diffPreviewSash.state = SashState.Disabled;
			this.diffPreviewWidth = 0;
			this.diffPreviewVisibleContextKey.set(false);
			this.relayoutWithDiffPreview();
			// Restore the aux bar to its original width before the preview was opened
			if (this.savedAuxBarWidth > 0) {
				const currentHeight = this.layoutService.getSize(Parts.AUXILIARYBAR_PART).height;
				this.layoutService.setSize(Parts.AUXILIARYBAR_PART, { width: this.savedAuxBarWidth, height: currentHeight });
				this.savedAuxBarWidth = 0;
			}
		} else {
			// Save the current aux bar width before expanding
			this.savedAuxBarWidth = this.layoutService.getSize(Parts.AUXILIARYBAR_PART).width;
			// Expand aux bar
			this.diffPreviewWidth = DiffPreviewWidget.PREFERRED_WIDTH;
			this.layoutService.resizePart(Parts.AUXILIARYBAR_PART, DiffPreviewWidget.PREFERRED_WIDTH, 0);
			this.diffPreviewContainer.style.display = '';
			this.diffPreviewWidget.show();
			this.diffPreviewSash.state = SashState.Enabled;
			this.diffPreviewVisibleContextKey.set(true);

			if (files) {
				this.diffPreviewWidget.setFiles(files);
			}

			this.relayoutWithDiffPreview();
		}
	}

	/**
	 * Update the diff preview files (if visible).
	 */
	setDiffPreviewFiles(files: readonly IDiffPreviewFile[]): void {
		if (this.diffPreviewWidget?.visible) {
			this.diffPreviewWidget.setFiles(files);
		}
	}

	get isDiffPreviewVisible(): boolean {
		return this.diffPreviewWidget?.visible ?? false;
	}

	get isDiffPreviewFullWidth(): boolean {
		return this.diffPreviewFullWidthContextKey.get() ?? false;
	}

	/**
	 * Toggle full-width mode: hides sidebar and chatbar so the diff preview
	 * fills the remaining space. Toggling again restores previous panel state.
	 */
	toggleFullWidth(): void {
		if (!this.isDiffPreviewVisible) {
			return;
		}

		const isFullWidth = this.isDiffPreviewFullWidth;

		if (isFullWidth) {
			// Restore previous state
			if (this.savedSidebarVisible !== undefined) {
				this.layoutService.setPartHidden(!this.savedSidebarVisible, Parts.SIDEBAR_PART);
			}
			if (this.savedChatBarVisible !== undefined) {
				this.layoutService.setPartHidden(!this.savedChatBarVisible, Parts.CHATBAR_PART);
			}
			this.savedSidebarVisible = undefined;
			this.savedChatBarVisible = undefined;
			this.diffPreviewFullWidthContextKey.set(false);
		} else {
			// Save current state and hide sidebar + chatbar
			this.savedSidebarVisible = this.layoutService.isVisible(Parts.SIDEBAR_PART);
			this.savedChatBarVisible = this.layoutService.isVisible(Parts.CHATBAR_PART);
			this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
			this.layoutService.setPartHidden(true, Parts.CHATBAR_PART);
			this.diffPreviewFullWidthContextKey.set(true);
		}
	}

	/**
	 * Scroll to reveal a specific file in the diff preview.
	 */
	revealInDiffPreview(uri: URI): void {
		if (this.diffPreviewWidget?.visible) {
			this.diffPreviewWidget.revealFile(uri);
		}
	}

	/**
	 * Re-layout the diff preview and part content at the current dimensions.
	 */
	private relayoutWithDiffPreview(): void {
		if (this.dimension) {
			this.layout(this.dimension.width, this.dimension.height, this.contentPosition?.top ?? 0, this.contentPosition?.left ?? 0);
		}
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());

		// Store background and border as CSS variables for the card styling on .part
		container.style.setProperty('--part-background', this.getColor(sessionsAuxiliaryBarBackground) || '');
		container.style.setProperty('--part-border-color', this.getColor(PANEL_BORDER) || this.getColor(contrastBorder) || 'transparent');
		container.style.backgroundColor = this.getColor(sessionsAuxiliaryBarBackground) || '';
		container.style.color = this.getColor(SIDE_BAR_FOREGROUND) || '';

		// Clear borders - the card appearance uses border-radius instead
		container.style.borderLeftColor = '';
		container.style.borderRightColor = '';
		container.style.borderLeftStyle = '';
		container.style.borderRightStyle = '';
		container.style.borderLeftWidth = '';
		container.style.borderRightWidth = '';
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		const $this = this;
		return {
			partContainerClass: 'auxiliarybar',
			pinnedViewContainersKey: AuxiliaryBarPart.pinnedViewsKey,
			placeholderViewContainersKey: AuxiliaryBarPart.placeholderViewContainersKey,
			viewContainersWorkspaceStateKey: AuxiliaryBarPart.viewContainersWorkspaceStateKey,
			icon: false,
			orientation: ActionsOrientation.HORIZONTAL,
			recomputeSizes: true,
			activityHoverOptions: {
				position: () => this.getCompositeBarPosition() === CompositeBarPosition.BOTTOM ? HoverPosition.ABOVE : HoverPosition.BELOW,
			},
			fillExtraContextMenuActions: actions => this.fillExtraContextMenuActions(actions),
			compositeSize: 0,
			iconSize: 16,
			get overflowActionSize() { return $this.getCompositeBarPosition() === CompositeBarPosition.TITLE ? 40 : 30; },
			colors: theme => ({
				activeBackgroundColor: theme.getColor(sessionsAuxiliaryBarBackground),
				inactiveBackgroundColor: theme.getColor(sessionsAuxiliaryBarBackground),
				get activeBorderBottomColor() { return $this.getCompositeBarPosition() === CompositeBarPosition.TITLE ? theme.getColor(PANEL_ACTIVE_TITLE_BORDER) : theme.getColor(ACTIVITY_BAR_TOP_ACTIVE_BORDER); },
				get activeForegroundColor() { return $this.getCompositeBarPosition() === CompositeBarPosition.TITLE ? theme.getColor(PANEL_ACTIVE_TITLE_FOREGROUND) : theme.getColor(ACTIVITY_BAR_TOP_FOREGROUND); },
				get inactiveForegroundColor() { return $this.getCompositeBarPosition() === CompositeBarPosition.TITLE ? theme.getColor(PANEL_INACTIVE_TITLE_FOREGROUND) : theme.getColor(ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND); },
				badgeBackground: theme.getColor(ACTIVITY_BAR_BADGE_BACKGROUND),
				badgeForeground: theme.getColor(ACTIVITY_BAR_BADGE_FOREGROUND),
				get dragAndDropBorder() { return $this.getCompositeBarPosition() === CompositeBarPosition.TITLE ? theme.getColor(PANEL_DRAG_AND_DROP_BORDER) : theme.getColor(ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER); }
			}),
			compact: true
		};
	}

	protected override actionViewItemProvider(action: IAction, options: IBaseActionViewItemOptions): IActionViewItem | undefined {
		// Create a DropdownWithPrimaryActionViewItem for the run script action
		if (action.id === AuxiliaryBarPart.RUN_SCRIPT_ACTION_ID && action instanceof MenuItemAction) {
			// Create and store the menu so we can listen for changes
			if (!this._runScriptMenu.value) {
				this._runScriptMenu.value = this.menuService.createMenu(AuxiliaryBarPart.RUN_SCRIPT_DROPDOWN_MENU_ID, this.contextKeyService);
				this._runScriptMenuListener.value = this._runScriptMenu.value.onDidChange(() => this._updateRunScriptDropdown());
			}

			const dropdownActions = this._getRunScriptDropdownActions();

			const dropdownAction: IAction = {
				id: 'runScriptDropdown',
				label: '',
				tooltip: '',
				class: undefined,
				enabled: true,
				run: () => { }
			};

			this._runScriptDropdown.value = this.instantiationService.createInstance(
				DropdownWithPrimaryActionViewItem,
				action,
				dropdownAction,
				dropdownActions,
				'',
				{
					hoverDelegate: options.hoverDelegate,
					getKeyBinding: (action: IAction) => this.keybindingService.lookupKeybinding(action.id, this.contextKeyService)
				}
			);

			return this._runScriptDropdown.value;
		}

		return super.actionViewItemProvider(action, options);
	}

	private _getRunScriptDropdownActions(): IAction[] {
		if (!this._runScriptMenu.value) {
			return [];
		}
		return getFlatContextMenuActions(this._runScriptMenu.value.getActions({ shouldForwardArgs: true }));
	}

	private _updateRunScriptDropdown(): void {
		if (this._runScriptDropdown.value) {
			const dropdownActions = this._getRunScriptDropdownActions();
			const dropdownAction: IAction = {
				id: 'runScriptDropdown',
				label: '',
				tooltip: '',
				class: undefined,
				enabled: true,
				run: () => { }
			};
			this._runScriptDropdown.value.update(dropdownAction, dropdownActions);
		}
	}

	private fillExtraContextMenuActions(_actions: IAction[]): void { }

	protected shouldShowCompositeBar(): boolean {
		return true;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		return CompositeBarPosition.TITLE;
	}

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			return;
		}

		// Layout content with reduced dimensions to account for visual margins and border
		const borderTotal = 2; // 1px border on each side
		const adjustedWidth = width - AuxiliaryBarPart.MARGIN_RIGHT - borderTotal;
		const adjustedHeight = height - AuxiliaryBarPart.MARGIN_TOP - AuxiliaryBarPart.MARGIN_BOTTOM - borderTotal;

		// Store adjusted width for sash clamping
		this.lastLayoutWidth = adjustedWidth;

		// Clamp diff preview width to available space
		if (this.diffPreviewWidth > 0) {
			this.diffPreviewWidth = Math.min(this.diffPreviewWidth, Math.max(200, adjustedWidth - 270));
		}

		if (this.diffPreviewWidth > 0 && this.diffPreviewContainer) {
			// Size the diff preview container
			this.diffPreviewContainer.style.width = `${this.diffPreviewWidth}px`;
			this.diffPreviewContainer.style.height = `${adjustedHeight}px`;
			this.diffPreviewWidget?.layout(this.diffPreviewWidth, adjustedHeight);

			// Layout part content with reduced width (minus diff preview)
			const contentWidth = Math.max(270, adjustedWidth - this.diffPreviewWidth);
			super.layout(contentWidth, adjustedHeight, top, left);

			// Shift the title and content area to the right of the diff preview
			if (this.titleArea) {
				this.titleArea.style.marginLeft = `${this.diffPreviewWidth}px`;
			}
			if (this.contentArea) {
				this.contentArea.style.marginLeft = `${this.diffPreviewWidth}px`;
			}
		} else {
			// Reset margins
			if (this.titleArea) {
				this.titleArea.style.marginLeft = '';
			}
			if (this.contentArea) {
				this.contentArea.style.marginLeft = '';
			}
			super.layout(adjustedWidth, adjustedHeight, top, left);
		}

		// Position the sash
		this.diffPreviewSash?.layout();

		// Restore the full grid-allocated dimensions so that Part.relayout() works correctly.
		Part.prototype.layout.call(this, width, height, top, left);
	}

	override toJSON(): object {
		return {
			type: Parts.AUXILIARYBAR_PART
		};
	}
}
