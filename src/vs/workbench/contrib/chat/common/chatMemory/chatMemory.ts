/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';

/**
 * Scope for memory facts - where they are stored and applied.
 */
export type MemoryScope = 'workspace' | 'user';

/**
 * Status of a memory suggestion.
 */
export type SuggestionStatus = 'pending' | 'applied' | 'dismissed';

/**
 * Target type for where a memory suggestion should be merged.
 */
export type SuggestionTargetType = 'agent' | 'skill' | 'instructions' | 'prompt' | 'hook' | 'newFile';

/**
 * Suggestion mode controlling how aggressively memories are extracted and surfaced.
 */
export const enum MemorySuggestionMode {
	/** Disabled - no extraction or tracking */
	Off = 'off',
	/** Extract after every chat turn, notify immediately */
	Eager = 'eager',
	/** Extract periodically (15-30 min), batch notifications */
	Occasional = 'occasional',
	/** Track silently, only surface via reconcile command */
	Manual = 'manual',
}

/**
 * A fact extracted from chat history.
 */
export interface IMemoryFact {
	/** Unique identifier */
	readonly id: string;
	/** The fact content - a concise, actionable statement */
	readonly content: string;
	/** Why this fact was stored */
	readonly reason: string;
	/** File paths or chat turn references */
	readonly citations: string[];
	/** When the fact was extracted (Unix timestamp) */
	readonly timestamp: number;
	/** Where this fact is stored and applies */
	readonly scope: MemoryScope;
	/** Chat session ID this was extracted from */
	readonly sourceSessionId: string;
	/** Extraction confidence 0-1 */
	readonly confidence: number;
}

/**
 * A memory fact matched to a customization target with merge suggestion.
 */
export interface IMemorySuggestion extends IMemoryFact {
	/** Type of customization to merge into */
	readonly targetType: SuggestionTargetType;
	/** URI of existing file to modify, or undefined for new file */
	readonly targetUri?: URI;
	/** Suggested filename if creating new file */
	readonly suggestedFileName?: string;
	/** How the fact would be integrated into the target */
	readonly suggestedMergeContent: string;
	/** Current status of this suggestion */
	status: SuggestionStatus;
}

/**
 * Result of a pruning operation.
 */
export interface IMemoryPruneResult {
	/** Facts that were merged together */
	readonly mergedFacts: Array<{ original: IMemoryFact[]; merged: IMemoryFact }>;
	/** Facts that were removed due to limits/decay */
	readonly removedFacts: IMemoryFact[];
	/** Final fact count after pruning */
	readonly finalCount: number;
}

/**
 * Serializable format for storing facts.
 */
export interface ISerializableMemoryFact {
	id: string;
	content: string;
	reason: string;
	citations: string[];
	timestamp: number;
	scope: MemoryScope;
	sourceSessionId: string;
	confidence: number;
}

/**
 * Serializable format for storing suggestions.
 */
export interface ISerializableMemorySuggestion extends ISerializableMemoryFact {
	targetType: SuggestionTargetType;
	targetUri?: string;
	suggestedFileName?: string;
	suggestedMergeContent: string;
	status: SuggestionStatus;
}

/**
 * Storage format for memory data file.
 */
export interface IMemoryStorageData {
	version: number;
	facts: ISerializableMemoryFact[];
	suggestions: ISerializableMemorySuggestion[];
	lastExtractionTime?: number;
}

/**
 * Constants for memory configuration.
 */
export const ChatMemoryConfiguration = {
	SUGGESTION_MODE: 'chat.memory.suggestionMode',
	MAX_WORKSPACE_FACTS: 'chat.memory.maxWorkspaceFacts',
	MAX_USER_FACTS: 'chat.memory.maxUserFacts',
	EXTRACTION_INTERVAL: 'chat.memory.extractionInterval',
} as const;

/**
 * Default values for memory configuration.
 */
export const ChatMemoryDefaults = {
	SUGGESTION_MODE: MemorySuggestionMode.Occasional,
	MAX_WORKSPACE_FACTS: 50,
	MAX_USER_FACTS: 100,
	EXTRACTION_INTERVAL_MINUTES: 15,
	EAGER_DEBOUNCE_MS: 300,
	BATCH_NOTIFICATION_THRESHOLD: 5,
	CONFIDENCE_THRESHOLD: 0.6,
	SIMILARITY_MERGE_THRESHOLD: 0.85,
} as const;

/**
 * Storage paths and keys.
 */
export const ChatMemoryStorage = {
	/** Relative path for workspace memories */
	WORKSPACE_MEMORIES_PATH: '.github/memories',
	/** Filename for facts storage */
	FACTS_FILENAME: 'facts.json',
	/** Storage key for user facts */
	USER_FACTS_KEY: 'chat.memory.userFacts',
	/** Storage key prefix for last extraction time */
	LAST_EXTRACTION_KEY: 'chat.memory.lastExtraction',
} as const;
