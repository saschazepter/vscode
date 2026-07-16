/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { PROMPT_TIMELINE_RAIL_SETTING, PROMPT_TIMELINE_STICKY_HEADER_SETTING } from '../common/promptTimeline.js';
import { registerPromptTimelineActions } from './promptTimelineActions.js';
import { PromptTimelineWidgetContrib } from './promptTimelineWidgetContrib.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'sessions',
	properties: {
		[PROMPT_TIMELINE_RAIL_SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('sessions.promptTimeline.rail', "Controls whether the prompt timeline rail is shown beside the chat transcript in the Agents window: a scrollbar that fans into prompt pills on scroll or hover, so you can scan and jump between the prompts you have sent."),
			tags: ['experimental'],
			experiment: { mode: 'startup' },
		},
		[PROMPT_TIMELINE_STICKY_HEADER_SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('sessions.promptTimeline.stickyHeader', "Controls whether a sticky header pins the current prompt to the top of the chat transcript in the Agents window while scrolling. Select the header to jump to another prompt."),
			tags: ['experimental'],
			experiment: { mode: 'startup' },
		},
	},
});

ChatWidget.CONTRIBS.push(PromptTimelineWidgetContrib);
registerPromptTimelineActions();
