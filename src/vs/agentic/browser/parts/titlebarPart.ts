/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { MultiWindowParts, Part } from '../../../workbench/browser/part.js';
import { ITitleService } from '../../../workbench/services/title/browser/titleService.js';
import { getZoomFactor, isWCOEnabled, getWCOTitlebarAreaRect } from '../../../base/browser/browser.js';
import { hasCustomTitlebar, hasNativeTitlebar, DEFAULT_CUSTOM_TITLEBAR_HEIGHT, TitlebarStyle, getTitleBarStyle, getWindowControlsStyle, WindowControlsStyle } from '../../../platform/window/common/window.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { StandardMouseEvent } from '../../../base/browser/mouseEvent.js';
import { IConfigurationService, IConfigurationChangeEvent } from '../../../platform/configuration/common/configuration.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../workbench/services/environment/browser/environmentService.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { TITLE_BAR_ACTIVE_BACKGROUND, TITLE_BAR_ACTIVE_FOREGROUND, TITLE_BAR_INACTIVE_FOREGROUND, TITLE_BAR_INACTIVE_BACKGROUND, TITLE_BAR_BORDER, WORKBENCH_BACKGROUND } from '../../../workbench/common/theme.js';
import { isMacintosh, isWeb, isNative, platformLocale } from '../../../base/common/platform.js';
import { Color } from '../../../base/common/color.js';
import { EventType, EventHelper, Dimension, append, $, addDisposableListener, prepend, reset, getWindow, getWindowId } from '../../../base/browser/dom.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { IStorageService, StorageScope } from '../../../platform/storage/common/storage.js';
import { Parts, IWorkbenchLayoutService, ActivityBarPosition, LayoutSettings } from '../../../workbench/services/layout/browser/layoutService.js';
import { createActionViewItem, fillInActionBarActions } from '../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenu, IMenuService, MenuId } from '../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { WindowTitle } from '../../../workbench/browser/parts/titlebar/windowTitle.js';
import { CommandCenterControl } from './commandCenterControl.js';
import { WorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';
import { ACCOUNTS_ACTIVITY_ID, GLOBAL_ACTIVITY_ID } from '../../../workbench/common/activity.js';
import { AccountsActivityActionViewItem, isAccountsActionVisible, SimpleAccountActivityActionViewItem, SimpleGlobalActivityActionViewItem } from '../../../workbench/browser/parts/globalCompositeBar.js';
import { HoverPosition } from '../../../base/browser/ui/hover/hoverWidget.js';
import { IEditorGroupsContainer, IEditorGroupsService } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { IAction } from '../../../base/common/actions.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { ActionsOrientation, IActionViewItem, prepareActions } from '../../../base/browser/ui/actionbar/actionbar.js';
import { AnchorAlignment } from '../../../base/browser/ui/contextview/contextview.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { ResolvedKeybinding } from '../../../base/common/keybindings.js';
import { IToolbarActions } from '../../../workbench/common/editor.js';
import { CodeWindow, mainWindow } from '../../../base/browser/window.js';
import { ACCOUNTS_ACTIVITY_TILE_ACTION, GLOBAL_ACTIVITY_TITLE_ACTION } from '../../../workbench/browser/parts/titlebar/titlebarActions.js';
import { createInstantHoverDelegate } from '../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IBaseActionViewItemOptions } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { IHoverDelegate } from '../../../base/browser/ui/hover/hoverDelegate.js';
import { safeIntl } from '../../../base/common/date.js';
import { ITitlebarPart, ITitleProperties, ITitleVariable, IAuxiliaryTitlebarPart } from '../../../workbench/browser/parts/titlebar/titlebarPart.js';
import { Menus } from '../menus.js';

/**
 * Agent Sessions titlebar part a fully independent titlebar for the agent sessions workbench.
 *
 * This is a standalone copy (not extending `BrowserTitlebarPart`) so that the
 * agent sessions workbench can evolve its titlebar independently from the
 * default workbench.
 *
 * Key differences from `BrowserTitlebarPart`:
 * - Always shows command center (no settings-driven toggle)
 * - No menubar
 * - No editor actions in the toolbar
 * - Uses agent-session-specific menu IDs
 */
export class TitlebarPart extends Part implements ITitlebarPart {

	//#region IView

	readonly minimumWidth: number = 0;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;

	get minimumHeight(): number {
		const wcoEnabled = isWeb && isWCOEnabled();
		let value = DEFAULT_CUSTOM_TITLEBAR_HEIGHT; // always command center height
		if (wcoEnabled) {
			value = Math.max(value, getWCOTitlebarAreaRect(getWindow(this.element))?.height ?? 0);
		}

		return value / (this.preventZoom ? getZoomFactor(getWindow(this.element)) : 1);
	}

	get maximumHeight(): number { return this.minimumHeight; }

	//#endregion

	//#region Events

	private _onMenubarVisibilityChange = this._register(new Emitter<boolean>());
	readonly onMenubarVisibilityChange = this._onMenubarVisibilityChange.event;

	private readonly _onWillDispose = this._register(new Emitter<void>());
	readonly onWillDispose = this._onWillDispose.event;

	//#endregion

	private rootContainer!: HTMLElement;
	private windowControlsContainer: HTMLElement | undefined;
	private title!: HTMLElement;

	private leftContent!: HTMLElement;
	private centerContent!: HTMLElement;
	private rightContent!: HTMLElement;

	private actionToolBar!: WorkbenchToolBar;
	private readonly actionToolBarDisposable = this._register(new DisposableStore());
	private actionToolBarElement!: HTMLElement;

	private globalToolbarMenu: IMenu | undefined;
	private layoutToolbarMenu: IMenu | undefined;

	private readonly globalToolbarMenuDisposables = this._register(new DisposableStore());
	private readonly layoutToolbarMenuDisposables = this._register(new DisposableStore());
	private readonly activityToolbarDisposables = this._register(new DisposableStore());

	private readonly hoverDelegate: IHoverDelegate;

	private readonly titleDisposables = this._register(new DisposableStore());
	private titleBarStyle: TitlebarStyle;

	private isInactive: boolean = false;

	private readonly isAuxiliary: boolean;

	private readonly windowTitle: WindowTitle;

	constructor(
		id: string,
		targetWindow: CodeWindow,
		editorGroupsContainer: IEditorGroupsContainer,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IConfigurationService protected readonly configurationService: IConfigurationService,
		@IBrowserWorkbenchEnvironmentService protected readonly environmentService: IBrowserWorkbenchEnvironmentService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IHostService private readonly hostService: IHostService,
		@IEditorService _editorService: IEditorService,
		@IMenuService private readonly menuService: IMenuService,
		@IKeybindingService private readonly keybindingService: IKeybindingService
	) {
		super(id, { hasTitle: false }, themeService, storageService, layoutService);

		this.isAuxiliary = targetWindow.vscodeWindowId !== mainWindow.vscodeWindowId;

		this.titleBarStyle = getTitleBarStyle(this.configurationService);

		this.windowTitle = this._register(instantiationService.createInstance(WindowTitle, targetWindow));

		this.hoverDelegate = this._register(createInstantHoverDelegate());

		this.registerListeners(getWindowId(targetWindow));
	}

	private registerListeners(targetWindowId: number): void {
		this._register(this.hostService.onDidChangeFocus(focused => focused ? this.onFocus() : this.onBlur()));
		this._register(this.hostService.onDidChangeActiveWindow(windowId => windowId === targetWindowId ? this.onFocus() : this.onBlur()));
		this._register(this.configurationService.onDidChangeConfiguration(e => this.onConfigurationChanged(e)));
	}

	private onBlur(): void {
		this.isInactive = true;
		this.updateStyles();
	}

	private onFocus(): void {
		this.isInactive = false;
		this.updateStyles();
	}

	private onConfigurationChanged(event: IConfigurationChangeEvent): void {
		if (hasCustomTitlebar(this.configurationService, this.titleBarStyle) && this.actionToolBar) {
			const affectsLayoutControl = event.affectsConfiguration(LayoutSettings.LAYOUT_ACTIONS);
			const affectsActivityControl = event.affectsConfiguration(LayoutSettings.ACTIVITY_BAR_LOCATION);

			if (affectsLayoutControl || affectsActivityControl) {
				this.createActionToolBarMenus({ layoutActions: affectsLayoutControl, activityActions: affectsActivityControl });
				this._onDidChange.fire(undefined);
			}
		}
	}

	updateProperties(properties: ITitleProperties): void {
		this.windowTitle.updateProperties(properties);
	}

	registerVariables(variables: ITitleVariable[]): void {
		this.windowTitle.registerVariables(variables);
	}

	updateOptions(_options: { compact: boolean }): void {
		// No compact mode support in agent sessions titlebar
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		this.rootContainer = append(parent, $('.titlebar-container'));

		this.leftContent = append(this.rootContainer, $('.titlebar-left'));
		this.centerContent = append(this.rootContainer, $('.titlebar-center'));
		this.rightContent = append(this.rootContainer, $('.titlebar-right'));

		// Draggable region
		prepend(this.rootContainer, $('div.titlebar-drag-region'));

		// No menubar in agent sessions titlebar

		// Title - always command center
		this.title = append(this.centerContent, $('div.window-title'));
		this.createTitle();

		// Action Toolbar
		if (hasCustomTitlebar(this.configurationService, this.titleBarStyle)) {
			this.actionToolBarElement = append(this.rightContent, $('div.action-toolbar-container'));
			this.createActionToolBar();
			this.createActionToolBarMenus();
		}

		// Window Controls Container
		if (!hasNativeTitlebar(this.configurationService, this.titleBarStyle)) {
			let primaryWindowControlsLocation = isMacintosh ? 'left' : 'right';
			if (isMacintosh && isNative) {
				const localeInfo = safeIntl.Locale(platformLocale).value;
				const textInfo = (localeInfo as { textInfo?: { direction?: string } }).textInfo;
				if (textInfo?.direction === 'rtl') {
					primaryWindowControlsLocation = 'right';
				}
			}

			if (isMacintosh && isNative && primaryWindowControlsLocation === 'left') {
				// macOS native: controls on the left, no container needed
			} else if (getWindowControlsStyle(this.configurationService) === WindowControlsStyle.HIDDEN) {
				// controls explicitly disabled
			} else {
				this.windowControlsContainer = append(primaryWindowControlsLocation === 'left' ? this.leftContent : this.rightContent, $('div.window-controls-container'));
				if (isWeb) {
					append(primaryWindowControlsLocation === 'left' ? this.rightContent : this.leftContent, $('div.window-controls-container'));
				}

				if (isWCOEnabled()) {
					this.windowControlsContainer.classList.add('wco-enabled');
				}
			}
		}

		// Context menu
		{
			this._register(addDisposableListener(this.rootContainer, EventType.CONTEXT_MENU, e => {
				EventHelper.stop(e);
				this.onContextMenu(e, Menus.TitleBarContext);
			}));
		}

		this.updateStyles();

		return this.element;
	}

	private createTitle(): void {
		this.titleDisposables.clear();

		// Always show command center with agent-session-specific menu IDs
		const commandCenter = this.instantiationService.createInstance(
			CommandCenterControl,
			this.windowTitle,
			this.hoverDelegate
		);
		reset(this.title, commandCenter.element);
		this.titleDisposables.add(commandCenter);
	}

	private actionViewItemProvider(action: IAction, options: IBaseActionViewItemOptions): IActionViewItem | undefined {
		if (!this.isAuxiliary) {
			if (action.id === GLOBAL_ACTIVITY_ID) {
				return this.instantiationService.createInstance(SimpleGlobalActivityActionViewItem, { position: () => HoverPosition.BELOW }, options);
			}
			if (action.id === ACCOUNTS_ACTIVITY_ID) {
				return this.instantiationService.createInstance(SimpleAccountActivityActionViewItem, { position: () => HoverPosition.BELOW }, options);
			}
		}

		return createActionViewItem(this.instantiationService, action, { ...options, menuAsChild: false });
	}

	private getKeybinding(action: IAction): ResolvedKeybinding | undefined {
		return this.keybindingService.lookupKeybinding(action.id, this.contextKeyService);
	}

	private createActionToolBar(): void {
		this.actionToolBarDisposable.clear();

		this.actionToolBar = this.actionToolBarDisposable.add(this.instantiationService.createInstance(WorkbenchToolBar, this.actionToolBarElement, {
			contextMenu: Menus.TitleBarContext,
			orientation: ActionsOrientation.HORIZONTAL,
			ariaLabel: localize('ariaLabelTitleActions', "Title actions"),
			getKeyBinding: action => this.getKeybinding(action),
			overflowBehavior: { maxItems: 9, exempted: [ACCOUNTS_ACTIVITY_ID, GLOBAL_ACTIVITY_ID] },
			anchorAlignmentProvider: () => AnchorAlignment.RIGHT,
			telemetrySource: 'titlePart',
			highlightToggledItems: this.isAuxiliary,
			actionViewItemProvider: (action, options) => this.actionViewItemProvider(action, options),
			hoverDelegate: this.hoverDelegate
		}));
	}

	private createActionToolBarMenus(update: true | { layoutActions?: boolean; globalActions?: boolean; activityActions?: boolean } = true): void {
		if (update === true) {
			update = { layoutActions: true, globalActions: true, activityActions: true };
		}

		const updateToolBarActions = () => {
			const actions: IToolbarActions = { primary: [], secondary: [] };

			// --- Global Actions
			if (this.globalToolbarMenu) {
				fillInActionBarActions(
					this.globalToolbarMenu.getActions(),
					actions
				);
			}

			// --- Layout Actions
			if (this.layoutToolbarMenu) {
				fillInActionBarActions(
					this.layoutToolbarMenu.getActions(),
					actions,
					() => true // always in overflow
				);
			}

			// --- Activity Actions (always at the end)
			if (this.activityActionsEnabled) {
				if (isAccountsActionVisible(this.storageService)) {
					actions.primary.push(ACCOUNTS_ACTIVITY_TILE_ACTION);
				}

				actions.primary.push(GLOBAL_ACTIVITY_TITLE_ACTION);
			}

			this.actionToolBar.setActions(prepareActions(actions.primary), prepareActions(actions.secondary));
		};

		if (update.layoutActions) {
			this.layoutToolbarMenuDisposables.clear();

			if (this.layoutControlEnabled) {
				this.layoutToolbarMenu = this.menuService.createMenu(MenuId.LayoutControlMenu, this.contextKeyService);

				this.layoutToolbarMenuDisposables.add(this.layoutToolbarMenu);
				this.layoutToolbarMenuDisposables.add(this.layoutToolbarMenu.onDidChange(() => updateToolBarActions()));
			} else {
				this.layoutToolbarMenu = undefined;
			}
		}

		if (update.globalActions) {
			this.globalToolbarMenuDisposables.clear();

			this.globalToolbarMenu = this.menuService.createMenu(Menus.TitleBarRight, this.contextKeyService);

			this.globalToolbarMenuDisposables.add(this.globalToolbarMenu);
			this.globalToolbarMenuDisposables.add(this.globalToolbarMenu.onDidChange(() => updateToolBarActions()));
		}

		if (update.activityActions) {
			this.activityToolbarDisposables.clear();
			if (this.activityActionsEnabled) {
				this.activityToolbarDisposables.add(this.storageService.onDidChangeValue(StorageScope.PROFILE, AccountsActivityActionViewItem.ACCOUNTS_VISIBILITY_PREFERENCE_KEY, this._store)(() => updateToolBarActions()));
			}
		}

		updateToolBarActions();
	}

	override updateStyles(): void {
		super.updateStyles();

		if (this.element) {
			if (this.isInactive) {
				this.element.classList.add('inactive');
			} else {
				this.element.classList.remove('inactive');
			}

			const titleBackground = this.getColor(this.isInactive ? TITLE_BAR_INACTIVE_BACKGROUND : TITLE_BAR_ACTIVE_BACKGROUND, (color, theme) => {
				return color.isOpaque() ? color : color.makeOpaque(WORKBENCH_BACKGROUND(theme));
			}) || '';
			this.element.style.backgroundColor = titleBackground;

			if (titleBackground && Color.fromHex(titleBackground).isLighter()) {
				this.element.classList.add('light');
			} else {
				this.element.classList.remove('light');
			}

			const titleForeground = this.getColor(this.isInactive ? TITLE_BAR_INACTIVE_FOREGROUND : TITLE_BAR_ACTIVE_FOREGROUND);
			this.element.style.color = titleForeground || '';

			const titleBorder = this.getColor(TITLE_BAR_BORDER);
			this.element.style.borderBottom = titleBorder ? `1px solid ${titleBorder}` : '';
		}
	}

	private onContextMenu(e: MouseEvent, menuId: MenuId): void {
		const event = new StandardMouseEvent(getWindow(this.element), e);

		this.contextMenuService.showContextMenu({
			getAnchor: () => event,
			menuId,
			contextKeyService: this.contextKeyService,
			domForShadowRoot: isMacintosh && isNative ? event.target : undefined
		});
	}

	private get layoutControlEnabled(): boolean {
		return this.configurationService.getValue<boolean>(LayoutSettings.LAYOUT_ACTIONS) !== false;
	}

	private get activityActionsEnabled(): boolean {
		const activityBarPosition = this.configurationService.getValue<ActivityBarPosition>(LayoutSettings.ACTIVITY_BAR_LOCATION);
		return !this.isAuxiliary && (activityBarPosition === ActivityBarPosition.TOP || activityBarPosition === ActivityBarPosition.BOTTOM);
	}

	get hasZoomableElements(): boolean {
		return true; // always has command center
	}

	get preventZoom(): boolean {
		return getZoomFactor(getWindow(this.element)) < 1 || !this.hasZoomableElements;
	}

	override layout(width: number, height: number): void {
		this.updateLayout(new Dimension(width, height));
		super.layoutContents(width, height);
	}

	private updateLayout(dimension: Dimension): void {
		if (!hasCustomTitlebar(this.configurationService, this.titleBarStyle)) {
			return;
		}

		const zoomFactor = getZoomFactor(getWindow(this.element));

		this.element.style.setProperty('--zoom-factor', zoomFactor.toString());
		this.rootContainer.classList.toggle('counter-zoom', this.preventZoom);
		this.rootContainer.classList.toggle('has-center', true); // always has command center
	}

	focus(): void {
		// eslint-disable-next-line no-restricted-syntax
		(this.element.querySelector('[tabindex]:not([tabindex="-1"])') as HTMLElement | null)?.focus();
	}

	toJSON(): object {
		return {
			type: Parts.TITLEBAR_PART
		};
	}

	override dispose(): void {
		this._onWillDispose.fire();
		super.dispose();
	}
}

/**
 * Main agent sessions titlebar part (for the main window).
 */
export class MainTitlebarPart extends TitlebarPart {

	constructor(
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
		@IMenuService menuService: IMenuService,
		@IKeybindingService keybindingService: IKeybindingService,
	) {
		super(Parts.TITLEBAR_PART, mainWindow, editorGroupService.mainPart, contextMenuService, configurationService, environmentService, instantiationService, themeService, storageService, layoutService, contextKeyService, hostService, editorService, menuService, keybindingService);
	}
}

/**
 * Auxiliary agent sessions titlebar part (for auxiliary windows).
 */
export class AuxiliaryTitlebarPart extends TitlebarPart implements IAuxiliaryTitlebarPart {

	private static COUNTER = 1;

	get height() { return this.minimumHeight; }

	constructor(
		readonly container: HTMLElement,
		editorGroupsContainer: IEditorGroupsContainer,
		private readonly mainTitlebar: TitlebarPart,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IBrowserWorkbenchEnvironmentService environmentService: IBrowserWorkbenchEnvironmentService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHostService hostService: IHostService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IEditorService editorService: IEditorService,
		@IMenuService menuService: IMenuService,
		@IKeybindingService keybindingService: IKeybindingService,
	) {
		const id = AuxiliaryTitlebarPart.COUNTER++;
		super(`workbench.parts.auxiliaryTitle.${id}`, getWindow(container), editorGroupsContainer, contextMenuService, configurationService, environmentService, instantiationService, themeService, storageService, layoutService, contextKeyService, hostService, editorService, menuService, keybindingService);
	}

	override get preventZoom(): boolean {
		return getZoomFactor(getWindow(this.element)) < 1 || !this.mainTitlebar.hasZoomableElements;
	}
}

/**
 * Agent Sessions title service - manages agent-session-specific titlebar parts.
 */
export class TitleService extends MultiWindowParts<TitlebarPart> implements ITitleService {

	declare _serviceBrand: undefined;

	readonly mainPart: TitlebarPart;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@IThemeService themeService: IThemeService
	) {
		super('workbench.agentSessionsTitleService', themeService, storageService);

		this.mainPart = this._register(this.instantiationService.createInstance(MainTitlebarPart));
		this.onMenubarVisibilityChange = this.mainPart.onMenubarVisibilityChange;
		this._register(this.registerPart(this.mainPart));
	}

	//#region Auxiliary Titlebar Parts

	createAuxiliaryTitlebarPart(container: HTMLElement, editorGroupsContainer: IEditorGroupsContainer, instantiationService: IInstantiationService): IAuxiliaryTitlebarPart {
		const titlebarPartContainer = $('.part.titlebar', { role: 'none' });
		titlebarPartContainer.style.position = 'relative';
		container.insertBefore(titlebarPartContainer, container.firstChild);

		const disposables = new DisposableStore();

		const titlebarPart = instantiationService.createInstance(AuxiliaryTitlebarPart, titlebarPartContainer, editorGroupsContainer, this.mainPart);
		disposables.add(this.registerPart(titlebarPart));

		disposables.add(Event.runAndSubscribe(titlebarPart.onDidChange, () => titlebarPartContainer.style.height = `${titlebarPart.height}px`));
		titlebarPart.create(titlebarPartContainer);

		if (this.properties) {
			titlebarPart.updateProperties(this.properties);
		}

		if (this.variables.size) {
			titlebarPart.registerVariables(Array.from(this.variables.values()));
		}

		Event.once(titlebarPart.onWillDispose)(() => disposables.dispose());

		return titlebarPart;
	}

	//#endregion

	//#region Service Implementation

	readonly onMenubarVisibilityChange: Event<boolean>;

	private properties: ITitleProperties | undefined = undefined;

	updateProperties(properties: ITitleProperties): void {
		this.properties = properties;

		for (const part of this.parts) {
			part.updateProperties(properties);
		}
	}

	private readonly variables = new Map<string, ITitleVariable>();

	registerVariables(variables: ITitleVariable[]): void {
		const newVariables: ITitleVariable[] = [];

		for (const variable of variables) {
			if (!this.variables.has(variable.name)) {
				this.variables.set(variable.name, variable);
				newVariables.push(variable);
			}
		}

		for (const part of this.parts) {
			part.registerVariables(newVariables);
		}
	}

	//#endregion
}
