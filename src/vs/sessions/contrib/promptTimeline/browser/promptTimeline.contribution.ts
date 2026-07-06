/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { PROMPT_TIMELINE_ENABLED_SETTING, PROMPT_TIMELINE_STYLE_SETTING, PromptTimelineStyle } from '../common/promptTimeline.js';
import { registerPromptTimelineActions } from './promptTimelineActions.js';
import { PromptTimelineWidgetContrib } from './promptTimelineWidgetContrib.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'sessions',
	properties: {
		[PROMPT_TIMELINE_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('sessions.promptTimeline.enabled', "Controls whether the prompt timeline rail is shown alongside the chat transcript in the Agents window. The rail lets you scan and jump between the prompts you have sent."),
			tags: ['experimental'],
		},
		[PROMPT_TIMELINE_STYLE_SETTING]: {
			type: 'string',
			enum: [PromptTimelineStyle.Compact, PromptTimelineStyle.Overview],
			enumDescriptions: [
				localize('sessions.promptTimeline.style.compact', "Dense marks that expand to a pill when hovered or focused."),
				localize('sessions.promptTimeline.style.overview', "A proportional overview ruler of the session with a viewport indicator, like the editor overview ruler."),
			],
			default: PromptTimelineStyle.Compact,
			description: localize('sessions.promptTimeline.style', "Controls the visual style of the prompt timeline rail in the Agents window."),
			tags: ['experimental'],
		},
	},
});

ChatWidget.CONTRIBS.push(PromptTimelineWidgetContrib);
registerPromptTimelineActions();
