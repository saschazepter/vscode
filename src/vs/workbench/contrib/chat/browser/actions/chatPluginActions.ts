/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { CHAT_CATEGORY, CHAT_CONFIG_MENU_ID } from './chatActions.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { IExtensionsViewPaneContainer, VIEWLET_ID } from '../../../extensions/common/extensions.js';
import { ViewContainerLocation } from '../../../../common/views.js';

class ManagePluginsAction extends Action2 {
	static readonly ID = 'workbench.action.chat.managePlugins';

	constructor() {
		super({
			id: ManagePluginsAction.ID,
			title: localize2('plugins', 'Plugins'),
			category: CHAT_CATEGORY,
			precondition: ChatContextKeys.enabled,
			menu: [{
				id: CHAT_CONFIG_MENU_ID,
			}],
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const paneCompositeService = accessor.get(IPaneCompositePartService);
		const viewlet = await paneCompositeService.openPaneComposite(VIEWLET_ID, ViewContainerLocation.Sidebar, true);
		const view = viewlet?.getViewPaneContainer() as IExtensionsViewPaneContainer | undefined;
		view?.search('@agentPlugins ');
	}
}

export function registerChatPluginActions() {
	registerAction2(ManagePluginsAction);
}
