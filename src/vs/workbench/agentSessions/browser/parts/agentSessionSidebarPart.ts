/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../browser/parts/sidebar/media/sidebarpart.css';
import { IWorkbenchLayoutService, Parts, Position as SideBarPosition } from '../../../services/layout/browser/layoutService.js';
import { SidebarFocusContext, ActiveViewletContext } from '../../../common/contextkeys.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { contrastBorder } from '../../../../platform/theme/common/colorRegistry.js';
import { SIDE_BAR_TITLE_FOREGROUND, SIDE_BAR_TITLE_BORDER, SIDE_BAR_BACKGROUND, SIDE_BAR_FOREGROUND, SIDE_BAR_BORDER, SIDE_BAR_DRAG_AND_DROP_BACKGROUND, ACTIVITY_BAR_BADGE_BACKGROUND, ACTIVITY_BAR_BADGE_FOREGROUND, ACTIVITY_BAR_TOP_FOREGROUND, ACTIVITY_BAR_TOP_ACTIVE_BORDER, ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND, ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER } from '../../../common/theme.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { AnchorAlignment } from '../../../../base/browser/ui/contextview/contextview.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { LayoutPriority } from '../../../../base/browser/ui/grid/grid.js';
import { assertReturnsDefined } from '../../../../base/common/types.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../../../browser/parts/paneCompositePart.js';
import { ActivityBarCompositeBar, ActivitybarPart } from '../../../browser/parts/activitybar/activitybarPart.js';
import { ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IPaneCompositeBarOptions } from '../../../browser/parts/paneCompositeBar.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { Separator } from '../../../../base/common/actions.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';

/**
 * Sidebar part specifically for agent sessions workbench.
 * This is a simplified version of the SidebarPart for agent session contexts.
 */
export class AgentSessionSidebarPart extends AbstractPaneCompositePart {

	static readonly activeViewletSettingsKey = 'workbench.agentsession.sidebar.activeviewletid';

	//#region IView

	readonly minimumWidth: number = 170;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	readonly minimumHeight: number = 0;
	readonly maximumHeight: number = Number.POSITIVE_INFINITY;
	override get snap(): boolean { return true; }

	readonly priority: LayoutPriority = LayoutPriority.Low;

	get preferredWidth(): number | undefined {
		const viewlet = this.getActivePaneComposite();

		if (!viewlet) {
			return undefined;
		}

		const width = viewlet.getOptimalWidth();
		if (typeof width !== 'number') {
			return undefined;
		}

		return Math.max(width, 300);
	}

	//#endregion

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
			Parts.SIDEBAR_PART,
			{ hasTitle: true, trailingSeparator: false, borderWidth: () => (this.getColor(SIDE_BAR_BORDER) || this.getColor(contrastBorder)) ? 1 : 0 },
			AgentSessionSidebarPart.activeViewletSettingsKey,
			ActiveViewletContext.bindTo(contextKeyService),
			SidebarFocusContext.bindTo(contextKeyService),
			'sideBar',
			'viewlet',
			SIDE_BAR_TITLE_FOREGROUND,
			SIDE_BAR_TITLE_BORDER,
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
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());

		container.style.backgroundColor = this.getColor(SIDE_BAR_BACKGROUND) || '';
		container.style.color = this.getColor(SIDE_BAR_FOREGROUND) || '';

		const borderColor = this.getColor(SIDE_BAR_BORDER) || this.getColor(contrastBorder);
		const isPositionLeft = this.layoutService.getSideBarPosition() === SideBarPosition.LEFT;
		container.style.borderRightWidth = borderColor && isPositionLeft ? '1px' : '';
		container.style.borderRightStyle = borderColor && isPositionLeft ? 'solid' : '';
		container.style.borderRightColor = isPositionLeft ? borderColor || '' : '';
		container.style.borderLeftWidth = borderColor && !isPositionLeft ? '1px' : '';
		container.style.borderLeftStyle = borderColor && !isPositionLeft ? 'solid' : '';
		container.style.borderLeftColor = !isPositionLeft ? borderColor || '' : '';
		container.style.outlineColor = this.getColor(SIDE_BAR_DRAG_AND_DROP_BACKGROUND) ?? '';
	}

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.layoutService.isVisible(Parts.SIDEBAR_PART)) {
			return;
		}

		super.layout(width, height, top, left);
	}

	protected override getTitleAreaDropDownAnchorAlignment(): AnchorAlignment {
		return this.layoutService.getSideBarPosition() === SideBarPosition.LEFT ? AnchorAlignment.LEFT : AnchorAlignment.RIGHT;
	}

	protected override createCompositeBar(): ActivityBarCompositeBar {
		return this.instantiationService.createInstance(ActivityBarCompositeBar, this.getCompositeBarOptions(), this.partId, this, false);
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		return {
			partContainerClass: 'sidebar',
			pinnedViewContainersKey: ActivitybarPart.pinnedViewContainersKey,
			placeholderViewContainersKey: ActivitybarPart.placeholderViewContainersKey,
			viewContainersWorkspaceStateKey: ActivitybarPart.viewContainersWorkspaceStateKey,
			icon: true,
			orientation: ActionsOrientation.HORIZONTAL,
			recomputeSizes: true,
			activityHoverOptions: {
				position: () => this.getCompositeBarPosition() === CompositeBarPosition.BOTTOM ? HoverPosition.ABOVE : HoverPosition.BELOW,
			},
			fillExtraContextMenuActions: actions => {
				if (this.getCompositeBarPosition() === CompositeBarPosition.TITLE) {
					const viewsSubmenuAction = this.getViewsSubmenuAction();
					if (viewsSubmenuAction) {
						actions.push(new Separator());
						actions.push(viewsSubmenuAction);
					}
				}
			},
			compositeSize: 0,
			iconSize: 16,
			overflowActionSize: 30,
			colors: theme => ({
				activeBackgroundColor: theme.getColor(SIDE_BAR_BACKGROUND),
				inactiveBackgroundColor: theme.getColor(SIDE_BAR_BACKGROUND),
				activeBorderBottomColor: theme.getColor(ACTIVITY_BAR_TOP_ACTIVE_BORDER),
				activeForegroundColor: theme.getColor(ACTIVITY_BAR_TOP_FOREGROUND),
				inactiveForegroundColor: theme.getColor(ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND),
				badgeBackground: theme.getColor(ACTIVITY_BAR_BADGE_BACKGROUND),
				badgeForeground: theme.getColor(ACTIVITY_BAR_BADGE_FOREGROUND),
				dragAndDropBorder: theme.getColor(ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER)
			}),
			compact: true
		};
	}

	protected shouldShowCompositeBar(): boolean {
		return true;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		return CompositeBarPosition.TITLE;
	}

	async focusActivityBar(): Promise<void> {
		if (this.shouldShowCompositeBar()) {
			this.focusCompositeBar();
		}
	}

	toJSON(): object {
		return {
			type: Parts.SIDEBAR_PART
		};
	}
}
