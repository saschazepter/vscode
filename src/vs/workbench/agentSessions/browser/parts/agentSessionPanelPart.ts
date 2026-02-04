/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../browser/parts/panel/media/panelpart.css';
import { IAction } from '../../../../base/common/actions.js';
import { ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { ActivePanelContext, PanelFocusContext } from '../../../common/contextkeys.js';
import { IWorkbenchLayoutService, Parts, Position } from '../../../services/layout/browser/layoutService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { PANEL_BACKGROUND, PANEL_BORDER, PANEL_TITLE_BORDER, PANEL_ACTIVE_TITLE_FOREGROUND, PANEL_INACTIVE_TITLE_FOREGROUND, PANEL_ACTIVE_TITLE_BORDER, PANEL_DRAG_AND_DROP_BORDER, PANEL_TITLE_BADGE_BACKGROUND, PANEL_TITLE_BADGE_FOREGROUND } from '../../../common/theme.js';
import { contrastBorder } from '../../../../platform/theme/common/colorRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { assertReturnsDefined } from '../../../../base/common/types.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../../../browser/parts/paneCompositePart.js';
import { IPaneCompositeBarOptions } from '../../../browser/parts/paneCompositeBar.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

/**
 * Panel part specifically for agent sessions workbench.
 * This is a simplified version of the PanelPart for agent session contexts.
 */
export class AgentSessionPanelPart extends AbstractPaneCompositePart {

	//#region IView

	readonly minimumWidth: number = 300;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	readonly minimumHeight: number = 77;
	readonly maximumHeight: number = Number.POSITIVE_INFINITY;

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

	//#endregion

	static readonly activePanelSettingsKey = 'workbench.agentsession.panelpart.activepanelid';

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
			Parts.PANEL_PART,
			{ hasTitle: true, trailingSeparator: true },
			AgentSessionPanelPart.activePanelSettingsKey,
			ActivePanelContext.bindTo(contextKeyService),
			PanelFocusContext.bindTo(contextKeyService),
			'panel',
			'panel',
			undefined,
			PANEL_TITLE_BORDER,
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

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('workbench.panel.showLabels')) {
				this.updateCompositeBar(true);
			}
		}));
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());
		container.style.backgroundColor = this.getColor(PANEL_BACKGROUND) || '';
		const borderColor = this.getColor(PANEL_BORDER) || this.getColor(contrastBorder) || '';
		container.style.borderLeftColor = borderColor;
		container.style.borderRightColor = borderColor;
		container.style.borderBottomColor = borderColor;

		if (this.titleArea) {
			this.titleArea.style.borderTopColor = this.getColor(PANEL_BORDER) || this.getColor(contrastBorder) || '';
		}
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		return {
			partContainerClass: 'panel',
			pinnedViewContainersKey: 'workbench.agentsession.panel.pinnedPanels',
			placeholderViewContainersKey: 'workbench.agentsession.panel.placeholderPanels',
			viewContainersWorkspaceStateKey: 'workbench.agentsession.panel.viewContainersWorkspaceState',
			icon: this.configurationService.getValue('workbench.panel.showLabels') === false,
			orientation: ActionsOrientation.HORIZONTAL,
			recomputeSizes: true,
			activityHoverOptions: {
				position: () => this.layoutService.getPanelPosition() === Position.BOTTOM && !this.layoutService.isPanelMaximized() ? HoverPosition.ABOVE : HoverPosition.BELOW,
			},
			fillExtraContextMenuActions: actions => this.fillExtraContextMenuActions(actions),
			compositeSize: 0,
			iconSize: 16,
			compact: true,
			overflowActionSize: 44,
			colors: theme => ({
				activeBackgroundColor: theme.getColor(PANEL_BACKGROUND),
				inactiveBackgroundColor: theme.getColor(PANEL_BACKGROUND),
				activeBorderBottomColor: theme.getColor(PANEL_ACTIVE_TITLE_BORDER),
				activeForegroundColor: theme.getColor(PANEL_ACTIVE_TITLE_FOREGROUND),
				inactiveForegroundColor: theme.getColor(PANEL_INACTIVE_TITLE_FOREGROUND),
				badgeBackground: theme.getColor(PANEL_TITLE_BADGE_BACKGROUND),
				badgeForeground: theme.getColor(PANEL_TITLE_BADGE_FOREGROUND),
				dragAndDropBorder: theme.getColor(PANEL_DRAG_AND_DROP_BORDER)
			})
		};
	}

	private fillExtraContextMenuActions(_actions: IAction[]): void { }

	override layout(width: number, height: number, top: number, left: number): void {
		let dimensions: Dimension;
		switch (this.layoutService.getPanelPosition()) {
			case Position.RIGHT:
				dimensions = new Dimension(width - 1, height);
				break;
			case Position.TOP:
				dimensions = new Dimension(width, height - 1);
				break;
			default:
				dimensions = new Dimension(width, height);
				break;
		}

		super.layout(dimensions.width, dimensions.height, top, left);
	}

	protected override shouldShowCompositeBar(): boolean {
		return true;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		return CompositeBarPosition.TITLE;
	}

	toJSON(): object {
		return {
			type: Parts.PANEL_PART
		};
	}
}
