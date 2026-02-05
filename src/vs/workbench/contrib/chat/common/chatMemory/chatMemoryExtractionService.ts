/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMemoryFact, MemorySuggestionMode } from './chatMemory.js';

export const IChatMemoryExtractionService = createDecorator<IChatMemoryExtractionService>('chatMemoryExtractionService');

/**
 * Result of an extraction run.
 */
export interface IExtractionResult {
	/** Facts extracted in this run */
	readonly facts: IMemoryFact[];
	/** Session IDs that were processed */
	readonly processedSessionIds: string[];
	/** Time taken in milliseconds */
	readonly durationMs: number;
	/** Any errors encountered */
	readonly errors: string[];
}

/**
 * Service for extracting memory facts from chat history.
 * Mode-aware: behavior differs based on suggestion mode setting.
 */
export interface IChatMemoryExtractionService {
	readonly _serviceBrand: undefined;

	/**
	 * Fired when an extraction run completes.
	 */
	readonly onDidExtract: Event<IExtractionResult>;

	/**
	 * Fired when the extraction mode changes.
	 */
	readonly onDidChangeSuggestionMode: Event<MemorySuggestionMode>;

	/**
	 * Get the current suggestion mode.
	 */
	readonly suggestionMode: MemorySuggestionMode;

	/**
	 * Whether extraction is currently running.
	 */
	readonly isExtracting: boolean;

	/**
	 * Manually trigger extraction for all unprocessed sessions.
	 * Used by the reconcile command.
	 */
	extractNow(token?: CancellationToken): Promise<IExtractionResult>;

	/**
	 * Extract facts from a specific chat session.
	 * Used in eager mode after each turn.
	 */
	extractFromSession(sessionId: string, token?: CancellationToken): Promise<IMemoryFact[]>;

	/**
	 * Get session IDs that haven't been processed yet.
	 */
	getUnprocessedSessionIds(): Promise<string[]>;

	/**
	 * Mark a session as processed.
	 */
	markSessionProcessed(sessionId: string): void;

	/**
	 * Start the extraction scheduler (for occasional mode).
	 */
	startScheduler(): void;

	/**
	 * Stop the extraction scheduler.
	 */
	stopScheduler(): void;
}
