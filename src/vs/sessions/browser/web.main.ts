/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../base/common/resources.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { IFileService } from '../../platform/files/common/files.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IPolicyService } from '../../platform/policy/common/policy.js';
import { IUriIdentityService } from '../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../platform/workspace/common/workspace.js';
import { BrowserMain, IBrowserMainWorkbench } from '../../workbench/browser/web.main.js';
import { IBrowserWorkbenchEnvironmentService } from '../../workbench/services/environment/browser/environmentService.js';
import { IWorkbenchConfigurationService } from '../../workbench/services/configuration/common/configuration.js';
import { IUserDataProfileService } from '../../workbench/services/userDataProfile/common/userDataProfile.js';
import { IWorkspaceEditingService } from '../../workbench/services/workspaces/common/workspaceEditing.js';
import { getWorkspaceIdentifier } from '../../workbench/services/workspaces/browser/workspaces.js';
import { SessionsWorkspaceContextService } from '../services/workspace/browser/workspaceContextService.js';
import { ConfigurationService } from '../services/configuration/browser/configurationService.js';
import { Workbench as SessionsWorkbench } from './workbench.js';

export class SessionsBrowserMain extends BrowserMain {

	protected override createWorkbench(domElement: HTMLElement, serviceCollection: ServiceCollection, logService: ILogService): IBrowserMainWorkbench {
		return new SessionsWorkbench(domElement, undefined, serviceCollection, logService);
	}

	protected override async initServices(): Promise<{ serviceCollection: ServiceCollection; configurationService: IWorkbenchConfigurationService; logService: ILogService }> {
		const result = await super.initServices();
		const { serviceCollection } = result;

		// Replace workspace and configuration services with the sessions
		// implementations. This mirrors what the desktop sessions entry does
		// in electron-browser/sessions.main.ts — the agents window manages
		// workspace folders in-memory without creating untitled workspaces
		// or opening new windows.

		const environmentService = serviceCollection.get(IBrowserWorkbenchEnvironmentService) as IBrowserWorkbenchEnvironmentService;
		const uriIdentityService = serviceCollection.get(IUriIdentityService) as IUriIdentityService;
		const userDataProfileService = serviceCollection.get(IUserDataProfileService) as IUserDataProfileService;
		const fileService = serviceCollection.get(IFileService) as IFileService;
		const policyService = serviceCollection.get(IPolicyService) as IPolicyService;

		// Workspace — use a stable synthetic workspace identifier, matching
		// the desktop pattern (environmentService.agentSessionsWorkspace).
		const sessionsWorkspaceUri = joinPath(environmentService.userRoamingDataHome, 'agent-sessions.code-workspace');
		const workspaceIdentifier = getWorkspaceIdentifier(sessionsWorkspaceUri);
		const workspaceContextService = new SessionsWorkspaceContextService(workspaceIdentifier, uriIdentityService);

		serviceCollection.set(IWorkspaceContextService, workspaceContextService);
		serviceCollection.set(IWorkspaceEditingService, workspaceContextService);

		// Configuration — the sessions ConfigurationService is a lighter
		// implementation that works against the in-memory workspace model
		// rather than a real .code-workspace file on disk.
		const configurationService = new ConfigurationService(
			userDataProfileService,
			workspaceContextService,
			uriIdentityService,
			fileService,
			policyService,
			result.logService,
		);
		try {
			await configurationService.initialize();
		} catch (error) {
			onUnexpectedError(error);
		}

		serviceCollection.set(IWorkbenchConfigurationService, configurationService);

		return { serviceCollection, configurationService, logService: result.logService };
	}
}
