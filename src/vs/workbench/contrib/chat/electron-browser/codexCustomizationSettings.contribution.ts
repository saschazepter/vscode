/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { CODEX_AGENT_PROVIDER_ID } from '../../../../platform/agentHost/common/agentService.js';
import { AHPAgentSettingsWidget } from '../../../../sessions/browser/agentGlobalConfigurationSettingsWidget.js';
import { aiCustomizationManagementSectionRegistry } from '../browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import { AICustomizationManagementSection } from '../common/aiCustomizationWorkspaceService.js';
import { SessionType } from '../common/chatSessionsService.js';

aiCustomizationManagementSectionRegistry.register({
	id: AICustomizationManagementSection.HarnessSettings,
	label: localize('codexCustomizationSettings.navigationLabel', "Codex Settings"),
	icon: Codicon.openai,
	description: localize('codexCustomizationSettings.navigationDescription', "Configure global behavior for this harness."),
	supportsHarness: harnessId => harnessId === SessionType.AgentHostCodex,
	create: (instantiationService, container) => instantiationService.createInstance(AHPAgentSettingsWidget, container, CODEX_AGENT_PROVIDER_ID, undefined),
});
