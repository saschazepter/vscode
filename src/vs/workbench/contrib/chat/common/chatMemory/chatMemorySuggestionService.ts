/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMemoryFact, IMemorySuggestion, SuggestionStatus } from './chatMemory.js';

export const IChatMemorySuggestionService = createDecorator<IChatMemorySuggestionService>('chatMemorySuggestionService');

/**
 * Result of applying a suggestion.
 */
export interface IApplySuggestionResult {
	/** Whether the apply succeeded */
	readonly success: boolean;
	/** The file that was modified or created */
	readonly targetUri?: import('../../../../../base/common/uri.js').URI;
	/** Error message if failed */
	readonly error?: string;
}

/**
 * Service for matching memory facts to customization targets and generating merge suggestions.
 */
export interface IChatMemorySuggestionService {
	readonly _serviceBrand: undefined;

	/**
	 * Fired when a new suggestion is added.
	 */
	readonly onDidAddSuggestion: Event<IMemorySuggestion>;

	/**
	 * Fired when suggestions change (add, apply, dismiss).
	 */
	readonly onDidChangeSuggestions: Event<void>;

	/**
	 * List all suggestions, optionally filtered by status.
	 */
	listSuggestions(status?: SuggestionStatus): Promise<IMemorySuggestion[]>;

	/**
	 * Generate suggestions for a fact by matching it to customization targets.
	 * @returns Suggestions (may be multiple if fact fits multiple targets).
	 */
	generateSuggestionsForFact(fact: IMemoryFact, token?: CancellationToken): Promise<IMemorySuggestion[]>;

	/**
	 * Generate suggestions for multiple facts.
	 */
	generateSuggestionsForFacts(facts: IMemoryFact[], token?: CancellationToken): Promise<IMemorySuggestion[]>;

	/**
	 * Apply a suggestion - merge the fact into the target file.
	 */
	applySuggestion(id: string): Promise<IApplySuggestionResult>;

	/**
	 * Dismiss a suggestion - mark as dismissed, won't be shown again.
	 */
	dismissSuggestion(id: string): Promise<void>;

	/**
	 * Get the count of pending suggestions.
	 */
	getPendingSuggestionCount(): number;

	/**
	 * Clear all suggestions with a given status.
	 */
	clearSuggestions(status?: SuggestionStatus): Promise<void>;

	/**
	 * Get suggestions grouped by target type.
	 */
	getSuggestionsGroupedByTarget(): Promise<Map<string, IMemorySuggestion[]>>;
}
