/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILanguageModelChatSelector, ILanguageModelsService } from './languageModels.js';
import { ChatConfiguration } from './constants.js';
import { isObject } from '../../../../base/common/types.js';

/**
 * Resolves a language model using a hierarchy of selectors with fallback logic.
 * Tries each selector in order until one resolves to exactly one model.
 */
export async function resolveLanguageModelWithFallback(
	languageModelsService: ILanguageModelsService,
	configurationService: IConfigurationService,
	featureKey: string,
	defaultFallback: ILanguageModelChatSelector[]
): Promise<string | undefined> {
	// First try feature-specific configuration
	const featureSelectors = configurationService.getValue<ILanguageModelChatSelector[] | null>(featureKey);
	if (featureSelectors && Array.isArray(featureSelectors) && featureSelectors.length > 0) {
		const result = await trySelectorsInOrder(languageModelsService, featureSelectors);
		if (result) {
			return result;
		}
		// If feature-specific selectors exist but none resolved, throw error
		throw new Error(`None of the configured model selectors for ${featureKey} resolved to exactly one model.`);
	}

	// Try default configuration
	const defaultSelectors = configurationService.getValue<ILanguageModelChatSelector[] | null>(ChatConfiguration.ExperimentalModelSelectorDefault);
	if (defaultSelectors && Array.isArray(defaultSelectors) && defaultSelectors.length > 0) {
		const result = await trySelectorsInOrder(languageModelsService, defaultSelectors);
		if (result) {
			return result;
		}
		// If default selectors exist but none resolved, throw error
		throw new Error(`None of the configured default model selectors resolved to exactly one model.`);
	}

	// Fall back to hardcoded defaults
	const result = await trySelectorsInOrder(languageModelsService, defaultFallback);
	return result;
}

/**
 * Tries a list of selectors in order, returning the first one that resolves to exactly one model.
 */
async function trySelectorsInOrder(
	languageModelsService: ILanguageModelsService,
	selectors: ILanguageModelChatSelector[]
): Promise<string | undefined> {
	for (const selector of selectors) {
		if (!isObject(selector)) {
			continue;
		}
		try {
			const models = await languageModelsService.selectLanguageModels(selector);
			if (models.length === 1) {
				return models[0];
			}
			// If we get 0 or >1 models, continue to next selector
		} catch (error) {
			// If selector fails, continue to next one
			continue;
		}
	}
	return undefined;
}
