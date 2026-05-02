/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { IWorkbenchLayoutService } from '../../../../workbench/services/layout/browser/layoutService.js';
import { IRemoteAgentHostService } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { WorkspacePicker } from './sessionWorkspacePicker.js';
import { showMobileWorkspacePickerSheet, shouldUseMobileWorkspacePickerSheet } from './mobileWorkspacePickerSheet.js';

/**
 * Phone variant of {@link WorkspacePicker} that renders the picker as a
 * bottom sheet instead of the desktop action-widget popup. Delegates to
 * `super.showPicker()` when the viewport is no longer phone (e.g. user
 * rotated their device past the phone breakpoint), so a single instance
 * works correctly across rotation.
 */
export class MobileWorkspacePicker extends WorkspacePicker {

	constructor(
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IStorageService storageService: IStorageService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@ISessionsProvidersService sessionsProvidersService: ISessionsProvidersService,
		@IRemoteAgentHostService remoteAgentHostService: IRemoteAgentHostService,
		@IConfigurationService configurationService: IConfigurationService,
		@ICommandService commandService: ICommandService,
		@IWorkspacesService workspacesService: IWorkspacesService,
		@IMenuService menuService: IMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super(
			actionWidgetService,
			storageService,
			uriIdentityService,
			sessionsProvidersService,
			remoteAgentHostService,
			configurationService,
			commandService,
			workspacesService,
			menuService,
			contextKeyService,
			instantiationService,
		);
	}

	override showPicker(): void {
		if (!this._triggerElement) {
			return;
		}
		if (!shouldUseMobileWorkspacePickerSheet(this.layoutService)) {
			super.showPicker();
			return;
		}
		const items = this._buildItems();
		showMobileWorkspacePickerSheet(
			this.layoutService,
			this._triggerElement,
			items,
			(item) => this._dispatchPickerItem(item),
			this._getAllBrowseActions(),
		);
	}
}
