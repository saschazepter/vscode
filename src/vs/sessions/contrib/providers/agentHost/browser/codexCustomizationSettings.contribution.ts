/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { derived } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { CODEX_AGENT_PROVIDER_ID } from '../../../../../platform/agentHost/common/agentService.js';
import { SessionType } from '../../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { aiCustomizationManagementSectionRegistry } from '../../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import { AICustomizationManagementSection } from '../../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { AHPAgentSettingsWidget } from '../../../../browser/agentGlobalConfigurationSettingsWidget.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';

aiCustomizationManagementSectionRegistry.register({
	id: AICustomizationManagementSection.HarnessSettings,
	label: localize('codexCustomizationSettings.navigationLabel', "Codex Settings"),
	icon: Codicon.openai,
	description: localize('codexCustomizationSettings.navigationDescription', "Configure global behavior for this harness."),
	supportsHarness: harnessId => harnessId === SessionType.AgentHostCodex,
	create: (instantiationService, container) => instantiationService.invokeFunction(accessor => {
		const sessionsService = accessor.get(ISessionsService);
		const providerId = derived(reader => sessionsService.activeSession.read(reader)?.providerId);
		return instantiationService.createInstance(AHPAgentSettingsWidget, container, CODEX_AGENT_PROVIDER_ID, providerId);
	}),
});
