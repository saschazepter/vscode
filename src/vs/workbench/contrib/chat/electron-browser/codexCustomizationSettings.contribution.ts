/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { CodexCustomizationSettingsWidget } from '../../../../sessions/browser/codexCustomizationSettingsWidget.js';
import { aiCustomizationManagementSectionRegistry } from '../browser/aiCustomization/aiCustomizationManagementSectionRegistry.js';
import { AICustomizationManagementSection } from '../common/aiCustomizationWorkspaceService.js';
import { SessionType } from '../common/chatSessionsService.js';

aiCustomizationManagementSectionRegistry.register({
	id: AICustomizationManagementSection.HarnessSettings,
	label: localize('codexCustomizationSettings.navigationLabel', "Codex Settings"),
	icon: Codicon.openai,
	description: localize('codexCustomizationSettings.navigationDescription', "Configure the account and behavior used by this harness."),
	supportsHarness: harnessId => harnessId === SessionType.AgentHostCodex,
	create: (instantiationService, container) => instantiationService.createInstance(CodexCustomizationSettingsWidget, container, undefined),
});
