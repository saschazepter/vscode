/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { SyncDescriptor0 } from '../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IProgressIndicator } from '../../../platform/progress/common/progress.js';
import { PaneCompositeDescriptor } from '../panecomposite.js';
import { IPaneComposite } from '../../common/panecomposite.js';
import { ViewContainerLocation } from '../../common/views.js';
import { IPaneCompositePartService } from '../../services/panecomposite/browser/panecomposite.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IPaneCompositePart } from './paneCompositePart.js';

export interface IPaneCompositePartsConfiguration {
	readonly panelPart: SyncDescriptor0<IPaneCompositePart>;
	readonly sideBarPart: SyncDescriptor0<IPaneCompositePart>;
	readonly auxiliaryBarPart: SyncDescriptor0<IPaneCompositePart>;
	readonly chatBarPart: SyncDescriptor0<IPaneCompositePart>;
}

export class PaneCompositePartService extends Disposable implements IPaneCompositePartService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidPaneCompositeOpen = this._register(new Emitter<{ composite: IPaneComposite; viewContainerLocation: ViewContainerLocation }>());
	readonly onDidPaneCompositeOpen = this._onDidPaneCompositeOpen.event;

	private readonly _onDidPaneCompositeClose = this._register(new Emitter<{ composite: IPaneComposite; viewContainerLocation: ViewContainerLocation }>());
	readonly onDidPaneCompositeClose = this._onDidPaneCompositeClose.event;

	private readonly paneCompositeParts = new Map<ViewContainerLocation, IPaneCompositePart>();

	constructor(
		partsConfiguration: IPaneCompositePartsConfiguration,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();

		// Create all parts eagerly - the layout needs them registered before renderWorkbench
		this.registerPart(ViewContainerLocation.Panel, instantiationService.createInstance(partsConfiguration.panelPart));
		this.registerPart(ViewContainerLocation.Sidebar, instantiationService.createInstance(partsConfiguration.sideBarPart));
		this.registerPart(ViewContainerLocation.AuxiliaryBar, instantiationService.createInstance(partsConfiguration.auxiliaryBarPart));
		this.registerPart(ViewContainerLocation.ChatBar, instantiationService.createInstance(partsConfiguration.chatBarPart));
	}

	private registerPart(location: ViewContainerLocation, part: IPaneCompositePart): void {
		this.paneCompositeParts.set(location, part);
		this._register(part.onDidPaneCompositeOpen(composite => this._onDidPaneCompositeOpen.fire({ composite, viewContainerLocation: location })));
		this._register(part.onDidPaneCompositeClose(composite => this._onDidPaneCompositeClose.fire({ composite, viewContainerLocation: location })));
	}

	openPaneComposite(id: string | undefined, viewContainerLocation: ViewContainerLocation, focus?: boolean): Promise<IPaneComposite | undefined> {
		return this.getPartByLocation(viewContainerLocation).openPaneComposite(id, focus);
	}

	getActivePaneComposite(viewContainerLocation: ViewContainerLocation): IPaneComposite | undefined {
		return this.getPartByLocation(viewContainerLocation).getActivePaneComposite();
	}

	getPaneComposite(id: string, viewContainerLocation: ViewContainerLocation): PaneCompositeDescriptor | undefined {
		return this.getPartByLocation(viewContainerLocation).getPaneComposite(id);
	}

	getPaneComposites(viewContainerLocation: ViewContainerLocation): PaneCompositeDescriptor[] {
		return this.getPartByLocation(viewContainerLocation).getPaneComposites();
	}

	getPinnedPaneCompositeIds(viewContainerLocation: ViewContainerLocation): string[] {
		return this.getPartByLocation(viewContainerLocation).getPinnedPaneCompositeIds();
	}

	getVisiblePaneCompositeIds(viewContainerLocation: ViewContainerLocation): string[] {
		return this.getPartByLocation(viewContainerLocation).getVisiblePaneCompositeIds();
	}

	getPaneCompositeIds(viewContainerLocation: ViewContainerLocation): string[] {
		return this.getPartByLocation(viewContainerLocation).getPaneCompositeIds();
	}

	getProgressIndicator(id: string, viewContainerLocation: ViewContainerLocation): IProgressIndicator | undefined {
		return this.getPartByLocation(viewContainerLocation).getProgressIndicator(id);
	}

	hideActivePaneComposite(viewContainerLocation: ViewContainerLocation): void {
		this.getPartByLocation(viewContainerLocation).hideActivePaneComposite();
	}

	getLastActivePaneCompositeId(viewContainerLocation: ViewContainerLocation): string {
		return this.getPartByLocation(viewContainerLocation).getLastActivePaneCompositeId();
	}

	private getPartByLocation(viewContainerLocation: ViewContainerLocation): IPaneCompositePart {
		return assertReturnsDefined(this.paneCompositeParts.get(viewContainerLocation));
	}

}
