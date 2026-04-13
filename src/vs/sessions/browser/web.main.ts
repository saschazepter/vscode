/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../platform/log/common/log.js';
import { BrowserMain, IBrowserMainWorkbench } from '../../workbench/browser/web.main.js';
import { Workbench as SessionsWorkbench } from './workbench.js';

type IConfigurationServiceWithInstantiationService = IConfigurationService & {
	acquireInstantiationService(instantiationService: IInstantiationService): void;
};

function canAcquireInstantiationService(configurationService: IConfigurationService): configurationService is IConfigurationServiceWithInstantiationService {
	return 'acquireInstantiationService' in configurationService;
}

class SessionsWebWorkbench extends SessionsWorkbench {
	override startup(): IInstantiationService {
		const instantiationService = super.startup();

		instantiationService.invokeFunction(accessor => {
			const configurationService = accessor.get(IConfigurationService);
			if (canAcquireInstantiationService(configurationService)) {
				configurationService.acquireInstantiationService(instantiationService);
			}
		});

		return instantiationService;
	}
}

export class SessionsBrowserMain extends BrowserMain {

	protected override createWorkbench(domElement: HTMLElement, serviceCollection: ServiceCollection, logService: ILogService): IBrowserMainWorkbench {
		console.log('[Sessions Web] Creating Sessions workbench (not standard workbench)');
		return new SessionsWebWorkbench(domElement, undefined, serviceCollection, logService);
	}
}
