/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { cycleExternalChangesPresentation, getExternalChangesPresentationLabel } from './externalChangesPresentation.js';
import { toggleExternalChangesDevSeed } from './externalChangesDevSeed.js';

/**
 * Developer command that cycles the active presentation of the out-of-workspace
 * ("external") files in the Changes view, so a reviewer can compare the variants
 * live from the Command Palette without a reload. Developer/experimental only.
 */
class CycleExternalChangesPresentationAction extends Action2 {
	static readonly ID = 'workbench.agentSessions.developer.cycleExternalChangesPresentation';

	constructor() {
		super({
			id: CycleExternalChangesPresentationAction.ID,
			title: localize2('agentSessions.cycleExternalChangesPresentation', "Cycle Agent External Changes Presentation (A/B)"),
			category: Categories.Developer,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		const notificationService = accessor.get(INotificationService);
		const next = cycleExternalChangesPresentation();
		notificationService.info(localize('agentSessions.externalChangesPresentationSwitched', "External changes presentation: {0}", getExternalChangesPresentationLabel(next)));
	}
}

registerAction2(CycleExternalChangesPresentationAction);

/**
 * Developer command that seeds the "Changes Outside This Workspace" section with
 * sample out-of-workspace files so the presentation variants can be demoed and
 * compared without a real agent run. Developer/experimental only.
 */
class ToggleSampleExternalChangesAction extends Action2 {
	static readonly ID = 'workbench.agentSessions.developer.toggleSampleExternalChanges';

	constructor() {
		super({
			id: ToggleSampleExternalChangesAction.ID,
			title: localize2('agentSessions.toggleSampleExternalChanges', "Toggle Sample Agent External Changes (Dev)"),
			category: Categories.Developer,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		const notificationService = accessor.get(INotificationService);
		const on = toggleExternalChangesDevSeed();
		notificationService.info(on
			? localize('agentSessions.sampleExternalChangesOn', "Sample external changes: on")
			: localize('agentSessions.sampleExternalChangesOff', "Sample external changes: off"));
	}
}

registerAction2(ToggleSampleExternalChangesAction);
