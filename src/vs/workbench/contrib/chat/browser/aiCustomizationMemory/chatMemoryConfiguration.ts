/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry, ConfigurationScope } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ChatMemoryConfiguration, ChatMemoryDefaults, MemorySuggestionMode } from '../../common/chatMemory/chatMemory.js';

/**
 * Register memory-related configuration settings.
 */
export function registerChatMemoryConfiguration(): void {
	const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	configurationRegistry.registerConfiguration({
		id: 'chatMemory',
		title: localize('chatMemoryConfigurationTitle', "Chat Memory"),
		type: 'object',
		properties: {
			[ChatMemoryConfiguration.SUGGESTION_MODE]: {
				type: 'string',
				enum: [
					MemorySuggestionMode.Off,
					MemorySuggestionMode.Eager,
					MemorySuggestionMode.Occasional,
					MemorySuggestionMode.Manual,
				],
				enumDescriptions: [
					localize('chat.memory.suggestionMode.off', "Disabled. No memory extraction or tracking."),
					localize('chat.memory.suggestionMode.eager', "Eager. Analyze every chat turn and suggest customization improvements immediately."),
					localize('chat.memory.suggestionMode.occasional', "Occasional. Periodically analyze chat history and batch suggestions."),
					localize('chat.memory.suggestionMode.manual', "Manual. Track facts silently. Run 'Reconcile Memory Suggestions' command to review."),
				],
				default: ChatMemoryDefaults.SUGGESTION_MODE,
				markdownDescription: localize('chat.memory.suggestionMode', "Controls how aggressively Copilot suggests improvements to your AI customizations based on chat history."),
				scope: ConfigurationScope.APPLICATION,
				tags: ['experimental'],
			},
			[ChatMemoryConfiguration.MAX_WORKSPACE_FACTS]: {
				type: 'number',
				default: ChatMemoryDefaults.MAX_WORKSPACE_FACTS,
				minimum: 10,
				maximum: 500,
				markdownDescription: localize('chat.memory.maxWorkspaceFacts', "Maximum number of memory facts to store per workspace."),
				scope: ConfigurationScope.RESOURCE,
				tags: ['experimental'],
			},
			[ChatMemoryConfiguration.MAX_USER_FACTS]: {
				type: 'number',
				default: ChatMemoryDefaults.MAX_USER_FACTS,
				minimum: 10,
				maximum: 500,
				markdownDescription: localize('chat.memory.maxUserFacts', "Maximum number of memory facts to store in user profile."),
				scope: ConfigurationScope.APPLICATION,
				tags: ['experimental'],
			},
			[ChatMemoryConfiguration.EXTRACTION_INTERVAL]: {
				type: 'number',
				default: ChatMemoryDefaults.EXTRACTION_INTERVAL_MINUTES,
				minimum: 5,
				maximum: 120,
				markdownDescription: localize('chat.memory.extractionInterval', "Interval in minutes between automatic memory extraction runs (in 'occasional' mode)."),
				scope: ConfigurationScope.APPLICATION,
				tags: ['experimental'],
			},
		},
	});
}

/**
 * Get the current suggestion mode from configuration.
 */
export function getSuggestionMode(configurationService: IConfigurationService): MemorySuggestionMode {
	const mode = configurationService.getValue<string>(ChatMemoryConfiguration.SUGGESTION_MODE);
	if (mode === MemorySuggestionMode.Off ||
		mode === MemorySuggestionMode.Eager ||
		mode === MemorySuggestionMode.Occasional ||
		mode === MemorySuggestionMode.Manual) {
		return mode;
	}
	return ChatMemoryDefaults.SUGGESTION_MODE;
}

/**
 * Get the maximum workspace facts limit from configuration.
 */
export function getMaxWorkspaceFacts(configurationService: IConfigurationService): number {
	return configurationService.getValue<number>(ChatMemoryConfiguration.MAX_WORKSPACE_FACTS) ?? ChatMemoryDefaults.MAX_WORKSPACE_FACTS;
}

/**
 * Get the maximum user facts limit from configuration.
 */
export function getMaxUserFacts(configurationService: IConfigurationService): number {
	return configurationService.getValue<number>(ChatMemoryConfiguration.MAX_USER_FACTS) ?? ChatMemoryDefaults.MAX_USER_FACTS;
}

/**
 * Get the extraction interval in minutes from configuration.
 */
export function getExtractionIntervalMinutes(configurationService: IConfigurationService): number {
	return configurationService.getValue<number>(ChatMemoryConfiguration.EXTRACTION_INTERVAL) ?? ChatMemoryDefaults.EXTRACTION_INTERVAL_MINUTES;
}
