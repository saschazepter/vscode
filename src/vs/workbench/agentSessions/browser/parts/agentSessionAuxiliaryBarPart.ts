/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../browser/parts/auxiliarybar/media/auxiliaryBarPart.css';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { contrastBorder } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ActiveAuxiliaryContext, AuxiliaryBarFocusContext } from '../../../common/contextkeys.js';
import { ACTIVITY_BAR_BADGE_BACKGROUND, ACTIVITY_BAR_BADGE_FOREGROUND, ACTIVITY_BAR_TOP_ACTIVE_BORDER, ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER, ACTIVITY_BAR_TOP_FOREGROUND, ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND, PANEL_ACTIVE_TITLE_BORDER, PANEL_ACTIVE_TITLE_FOREGROUND, PANEL_DRAG_AND_DROP_BORDER, PANEL_INACTIVE_TITLE_FOREGROUND, SIDE_BAR_BACKGROUND, SIDE_BAR_BORDER, SIDE_BAR_TITLE_BORDER, SIDE_BAR_FOREGROUND } from '../../../common/theme.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { ActivityBarPosition, IWorkbenchLayoutService, LayoutSettings, Parts, Position } from '../../../services/layout/browser/layoutService.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IAction } from '../../../../base/common/actions.js';
import { assertReturnsDefined } from '../../../../base/common/types.js';
import { LayoutPriority } from '../../../../base/browser/ui/splitview/splitview.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../../../browser/parts/paneCompositePart.js';
import { ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IPaneCompositeBarOptions } from '../../../browser/parts/paneCompositeBar.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';

interface IAgentSessionAuxiliaryBarPartConfiguration {
	position: ActivityBarPosition;

	canShowLabels: boolean;
	showLabels: boolean;
}

/**
 * Auxiliary bar part specifically for agent sessions workbench.
 * This is a simplified version of the AuxiliaryBarPart for agent session contexts.
 */
export class AgentSessionAuxiliaryBarPart extends AbstractPaneCompositePart {

	static readonly activeViewSettingsKey = 'workbench.agentsession.auxiliarybar.activepanelid';
	static readonly pinnedViewsKey = 'workbench.agentsession.auxiliarybar.pinnedPanels';
	static readonly placeholdeViewContainersKey = 'workbench.agentsession.auxiliarybar.placeholderPanels';
	static readonly viewContainersWorkspaceStateKey = 'workbench.agentsession.auxiliarybar.viewContainersWorkspaceState';

	// Use the side bar dimensions
	override readonly minimumWidth: number = 170;
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

		return Math.max(width, 300);
	}

	readonly priority = LayoutPriority.Low;

	private configuration: IAgentSessionAuxiliaryBarPartConfiguration;

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
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super(
			Parts.AUXILIARYBAR_PART,
			{
				hasTitle: true,
				trailingSeparator: true,
				borderWidth: () => (this.getColor(SIDE_BAR_BORDER) || this.getColor(contrastBorder)) ? 1 : 0,
			},
			AgentSessionAuxiliaryBarPart.activeViewSettingsKey,
			ActiveAuxiliaryContext.bindTo(contextKeyService),
			AuxiliaryBarFocusContext.bindTo(contextKeyService),
			'auxiliarybar',
			'auxiliarybar',
			undefined,
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

		this.configuration = this.resolveConfiguration();

		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(LayoutSettings.ACTIVITY_BAR_LOCATION)) {
				this.configuration = this.resolveConfiguration();
				this.onDidChangeActivityBarLocation();
			} else if (e.affectsConfiguration('workbench.secondarySideBar.showLabels')) {
				this.configuration = this.resolveConfiguration();
				this.updateCompositeBar(true);
			}
		}));
	}

	private resolveConfiguration(): IAgentSessionAuxiliaryBarPartConfiguration {
		const position = this.configurationService.getValue<ActivityBarPosition>(LayoutSettings.ACTIVITY_BAR_LOCATION);

		const canShowLabels = position !== ActivityBarPosition.TOP && position !== ActivityBarPosition.BOTTOM;
		const showLabels = canShowLabels && this.configurationService.getValue('workbench.secondarySideBar.showLabels') !== false;

		return { position, canShowLabels, showLabels };
	}

	private onDidChangeActivityBarLocation(): void {
		this.updateCompositeBar();

		const id = this.getActiveComposite()?.getId();
		if (id) {
			this.onTitleAreaUpdate(id);
		}
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());
		container.style.backgroundColor = this.getColor(SIDE_BAR_BACKGROUND) || '';
		const borderColor = this.getColor(SIDE_BAR_BORDER) || this.getColor(contrastBorder);
		const isPositionLeft = this.layoutService.getSideBarPosition() === Position.RIGHT;

		container.style.color = this.getColor(SIDE_BAR_FOREGROUND) || '';

		container.style.borderLeftColor = borderColor ?? '';
		container.style.borderRightColor = borderColor ?? '';

		container.style.borderLeftStyle = borderColor && !isPositionLeft ? 'solid' : 'none';
		container.style.borderRightStyle = borderColor && isPositionLeft ? 'solid' : 'none';

		container.style.borderLeftWidth = borderColor && !isPositionLeft ? '1px' : '0px';
		container.style.borderRightWidth = borderColor && isPositionLeft ? '1px' : '0px';
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		const $this = this;
		return {
			partContainerClass: 'auxiliarybar',
			pinnedViewContainersKey: AgentSessionAuxiliaryBarPart.pinnedViewsKey,
			placeholderViewContainersKey: AgentSessionAuxiliaryBarPart.placeholdeViewContainersKey,
			viewContainersWorkspaceStateKey: AgentSessionAuxiliaryBarPart.viewContainersWorkspaceStateKey,
			icon: !this.configuration.showLabels,
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
				activeBackgroundColor: theme.getColor(SIDE_BAR_BACKGROUND),
				inactiveBackgroundColor: theme.getColor(SIDE_BAR_BACKGROUND),
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

	private fillExtraContextMenuActions(_actions: IAction[]): void { }

	protected shouldShowCompositeBar(): boolean {
		return true;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		return CompositeBarPosition.TITLE;
	}

	override toJSON(): object {
		return {
			type: Parts.AUXILIARYBAR_PART
		};
	}
}
