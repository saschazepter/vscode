/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getClientArea } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IEditorPartsView } from '../../../workbench/browser/parts/editor/editor.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { DOCK_DETAIL_PANEL_SETTING } from '../../common/sessionConfig.js';
import { DockedAuxiliaryBarController } from '../dockedAuxiliaryBarController.js';
import { IAgentWorkbenchLayoutService } from '../workbench.js';
import { MainEditorPart } from './editorPart.js';
import { SinglePaneAuxiliaryBarPart } from './singlePaneAuxiliaryBarPart.js';

/**
 * Whether the Agents window should use the single-pane detail-panel layout, where
 * the auxiliary bar is owned by (docked inside) the editor part. True only when the
 * setting is enabled on a non-phone viewport — the classic and mobile layouts keep
 * the auxiliary bar as a standalone part. This is the single source of truth for
 * selecting the single-pane workbench, editor part, and auxiliary bar together.
 */
export function shouldUseSinglePaneLayout(configurationService: IConfigurationService): boolean {
	const { width } = getClientArea(mainWindow.document.body);
	const isPhoneLayout = width < 640;
	return !isPhoneLayout && configurationService.getValue<boolean>(DOCK_DETAIL_PANEL_SETTING) === true;
}

/**
 * Single-pane editor part: owns the docked auxiliary bar so "editor + auxiliary
 * bar" is a single unit. It creates the {@link SinglePaneAuxiliaryBarPart}
 * (lazily, so the pane composite service and the editor part share one instance)
 * and, once its DOM container exists, the {@link DockedAuxiliaryBarController}
 * that docks and sizes the auxiliary bar inside the editor part.
 */
export class SinglePaneMainEditorPart extends MainEditorPart {

	private _auxiliaryBar: SinglePaneAuxiliaryBarPart | undefined;
	private _dockedAuxBar: DockedAuxiliaryBarController | undefined;

	constructor(
		editorPartsView: IEditorPartsView,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IHostService hostService: IHostService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(editorPartsView, _instantiationService, themeService, configurationService, storageService, layoutService, hostService, contextKeyService);
	}

	/**
	 * The auxiliary bar owned by this editor part, created on first access. The
	 * pane composite service reads this so both share the same instance.
	 */
	get auxiliaryBar(): SinglePaneAuxiliaryBarPart {
		if (!this._auxiliaryBar) {
			this._auxiliaryBar = this._register(this._instantiationService.createInstance(SinglePaneAuxiliaryBarPart));
		}
		return this._auxiliaryBar;
	}

	override create(parent: HTMLElement, options?: object): void {
		super.create(parent, options);

		const layoutService = this.layoutService as IAgentWorkbenchLayoutService;
		this._dockedAuxBar = this._register(new DockedAuxiliaryBarController(
			parent,
			this.auxiliaryBar,
			{
				getWidth: () => layoutService.getDockedAuxiliaryBarWidth(),
				setWidth: (width: number) => layoutService.setDockedAuxiliaryBarWidth(width),
				isEditorAreaVisible: () => layoutService.isVisible(Parts.EDITOR_PART, mainWindow) || layoutService.isVisible(Parts.AUXILIARYBAR_PART),
				isEditorVisible: () => layoutService.isVisible(Parts.EDITOR_PART, mainWindow),
				isAuxiliaryBarVisible: () => layoutService.isVisible(Parts.AUXILIARYBAR_PART),
				setEditorContentRightInset: (px: number) => this.setContentRightInset(px),
			},
		));
	}

	/** Re-layouts the docked auxiliary bar. Called by the workbench on layout changes. */
	layoutDockedAuxiliaryBar(): void {
		this._dockedAuxBar?.layout();
	}
}
