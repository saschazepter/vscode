/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aquarium.css';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { AquariumOverlay } from './aquariumOverlay.js';

/**
 * Lifecycle owner for the Agents window aquarium. Instantiates the overlay
 * (which renders its persistent toggle button and manages the on/off state).
 */
class SessionsAquariumContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessionsAquarium';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(instantiationService.createInstance(AquariumOverlay));
	}
}

registerWorkbenchContribution2(SessionsAquariumContribution.ID, SessionsAquariumContribution, WorkbenchPhase.AfterRestored);
