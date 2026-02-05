/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMemoryFact, IMemoryPruneResult, MemoryScope } from './chatMemory.js';

export const IChatMemoryService = createDecorator<IChatMemoryService>('chatMemoryService');

/**
 * Service for storing and managing memory facts.
 * Handles CRUD operations and persistence for both workspace and user scopes.
 */
export interface IChatMemoryService {
	readonly _serviceBrand: undefined;

	/**
	 * Fired when memories change (add, remove, update).
	 */
	readonly onDidChangeMemories: Event<MemoryScope | undefined>;

	/**
	 * List all facts, optionally filtered by scope.
	 */
	listFacts(scope?: MemoryScope): Promise<IMemoryFact[]>;

	/**
	 * Add a new fact.
	 * @returns The created fact with generated ID.
	 */
	addFact(fact: Omit<IMemoryFact, 'id'>): Promise<IMemoryFact>;

	/**
	 * Add multiple facts at once.
	 * @returns The created facts with generated IDs.
	 */
	addFacts(facts: Omit<IMemoryFact, 'id'>[]): Promise<IMemoryFact[]>;

	/**
	 * Remove a fact by ID.
	 */
	removeFact(id: string): Promise<void>;

	/**
	 * Update an existing fact.
	 */
	updateFact(id: string, updates: Partial<Omit<IMemoryFact, 'id'>>): Promise<void>;

	/**
	 * Get the last extraction time for a scope.
	 */
	getLastExtractionTime(scope: MemoryScope): number | undefined;

	/**
	 * Set the last extraction time for a scope.
	 */
	setLastExtractionTime(scope: MemoryScope, time: number): void;

	/**
	 * Prune facts to stay within limits.
	 * Uses time decay, user signals, and LLM deduplication.
	 */
	pruneFacts(scope: MemoryScope): Promise<IMemoryPruneResult>;

	/**
	 * Clear all facts for a scope.
	 */
	clearFacts(scope: MemoryScope): Promise<void>;

	/**
	 * Get the current fact count for a scope.
	 */
	getFactCount(scope: MemoryScope): Promise<number>;
}
