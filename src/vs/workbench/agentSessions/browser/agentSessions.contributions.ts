/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../base/common/codicons.js';
import { localize2 } from '../../../nls.js';
import { SyncDescriptor } from '../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../platform/theme/common/iconRegistry.js';
import { IViewContainersRegistry, ViewContainerLocation, IViewsRegistry, Extensions as ViewContainerExtensions, LayoutVisibility } from '../../common/views.js';
import { CHANGES_VIEW_CONTAINER_ID, CHANGES_VIEW_ID, ChangesViewPane, ChangesViewPaneContainer } from './views/changesView.js';

// --- Changes

const changesViewIcon = registerIcon('changes-view-icon', Codicon.gitCompare, localize2('changesViewIcon', 'View icon for the Changes view.').value);

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

const changesViewContainer = viewContainersRegistry.registerViewContainer({
	id: CHANGES_VIEW_CONTAINER_ID,
	title: localize2('changes', 'Changes'),
	ctorDescriptor: new SyncDescriptor(ChangesViewPaneContainer),
	icon: changesViewIcon,
	order: 10,
	hideIfEmpty: true,
	layoutVisibility: LayoutVisibility.AgentSessions
}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: true, isDefault: true });

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

viewsRegistry.registerViews([{
	id: CHANGES_VIEW_ID,
	name: localize2('changes', 'Changes'),
	containerIcon: changesViewIcon,
	ctorDescriptor: new SyncDescriptor(ChangesViewPane),
	canToggleVisibility: true,
	canMoveView: true,
	weight: 100,
	order: 1,
	layoutVisibility: LayoutVisibility.AgentSessions
}], changesViewContainer);
