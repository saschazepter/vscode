/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import {
	ChatMemoryStorage,
	IMemoryFact,
	IMemoryPruneResult,
	IMemoryStorageData,
	ISerializableMemoryFact,
	MemoryScope,
} from '../../common/chatMemory/chatMemory.js';
import { IChatMemoryService } from '../../common/chatMemory/chatMemoryService.js';
import { getMaxUserFacts, getMaxWorkspaceFacts } from './chatMemoryConfiguration.js';

const STORAGE_VERSION = 1;

/**
 * Implementation of IChatMemoryService.
 * Handles storage of memory facts in workspace (.github/memories/) and user profile.
 */
export class ChatMemoryServiceImpl extends Disposable implements IChatMemoryService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeMemories = this._register(new Emitter<MemoryScope | undefined>());
	readonly onDidChangeMemories: Event<MemoryScope | undefined> = this._onDidChangeMemories.event;

	private workspaceFacts: IMemoryFact[] = [];
	private userFacts: IMemoryFact[] = [];
	private lastExtractionTimes: Map<MemoryScope, number> = new Map();
	private initialized = false;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
	}

	private async ensureInitialized(): Promise<void> {
		if (this.initialized) {
			return;
		}
		this.initialized = true;
		await this.loadFacts();
	}

	private getWorkspaceMemoriesUri(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}
		return joinPath(folders[0].uri, ChatMemoryStorage.WORKSPACE_MEMORIES_PATH, ChatMemoryStorage.FACTS_FILENAME);
	}

	private async loadFacts(): Promise<void> {
		// Load workspace facts
		const workspaceUri = this.getWorkspaceMemoriesUri();
		if (workspaceUri) {
			try {
				const content = await this.fileService.readFile(workspaceUri);
				const data = JSON.parse(content.value.toString()) as IMemoryStorageData;
				this.workspaceFacts = data.facts.map(f => this.deserializeFact(f));
				if (data.lastExtractionTime !== undefined) {
					this.lastExtractionTimes.set('workspace', data.lastExtractionTime);
				}
			} catch {
				// File doesn't exist or invalid, start fresh
				this.workspaceFacts = [];
			}
		}

		// Load user facts from storage service
		const userFactsJson = this.storageService.get(ChatMemoryStorage.USER_FACTS_KEY, StorageScope.PROFILE);
		if (userFactsJson) {
			try {
				const data = JSON.parse(userFactsJson) as IMemoryStorageData;
				this.userFacts = data.facts.map(f => this.deserializeFact(f));
				if (data.lastExtractionTime !== undefined) {
					this.lastExtractionTimes.set('user', data.lastExtractionTime);
				}
			} catch {
				this.userFacts = [];
			}
		}

		// Load last extraction times
		const workspaceLastExtraction = this.storageService.get(`${ChatMemoryStorage.LAST_EXTRACTION_KEY}.workspace`, StorageScope.WORKSPACE);
		if (workspaceLastExtraction) {
			this.lastExtractionTimes.set('workspace', parseInt(workspaceLastExtraction, 10));
		}
		const userLastExtraction = this.storageService.get(`${ChatMemoryStorage.LAST_EXTRACTION_KEY}.user`, StorageScope.PROFILE);
		if (userLastExtraction) {
			this.lastExtractionTimes.set('user', parseInt(userLastExtraction, 10));
		}
	}

	private async saveWorkspaceFacts(): Promise<void> {
		const uri = this.getWorkspaceMemoriesUri();
		if (!uri) {
			return;
		}

		const data: IMemoryStorageData = {
			version: STORAGE_VERSION,
			facts: this.workspaceFacts.map(f => this.serializeFact(f)),
			suggestions: [],
			lastExtractionTime: this.lastExtractionTimes.get('workspace'),
		};

		try {
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(data, null, '\t')));
		} catch (e) {
			this.logService.error('[ChatMemoryService] Failed to save workspace facts:', e);
		}
	}

	private saveUserFacts(): void {
		const data: IMemoryStorageData = {
			version: STORAGE_VERSION,
			facts: this.userFacts.map(f => this.serializeFact(f)),
			suggestions: [],
			lastExtractionTime: this.lastExtractionTimes.get('user'),
		};

		this.storageService.store(
			ChatMemoryStorage.USER_FACTS_KEY,
			JSON.stringify(data),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
	}

	private serializeFact(fact: IMemoryFact): ISerializableMemoryFact {
		return {
			id: fact.id,
			content: fact.content,
			reason: fact.reason,
			citations: fact.citations,
			timestamp: fact.timestamp,
			scope: fact.scope,
			sourceSessionId: fact.sourceSessionId,
			confidence: fact.confidence,
		};
	}

	private deserializeFact(data: ISerializableMemoryFact): IMemoryFact {
		return {
			id: data.id,
			content: data.content,
			reason: data.reason,
			citations: data.citations ?? [],
			timestamp: data.timestamp,
			scope: data.scope,
			sourceSessionId: data.sourceSessionId,
			confidence: data.confidence,
		};
	}

	async listFacts(scope?: MemoryScope): Promise<IMemoryFact[]> {
		await this.ensureInitialized();

		if (scope === 'workspace') {
			return [...this.workspaceFacts];
		}
		if (scope === 'user') {
			return [...this.userFacts];
		}
		return [...this.workspaceFacts, ...this.userFacts];
	}

	async addFact(fact: Omit<IMemoryFact, 'id'>): Promise<IMemoryFact> {
		await this.ensureInitialized();

		const newFact: IMemoryFact = {
			...fact,
			id: generateUuid(),
		};

		if (fact.scope === 'workspace') {
			this.workspaceFacts.push(newFact);
			await this.saveWorkspaceFacts();
		} else {
			this.userFacts.push(newFact);
			this.saveUserFacts();
		}

		this._onDidChangeMemories.fire(fact.scope);
		return newFact;
	}

	async addFacts(facts: Omit<IMemoryFact, 'id'>[]): Promise<IMemoryFact[]> {
		await this.ensureInitialized();

		const newFacts: IMemoryFact[] = facts.map(fact => ({
			...fact,
			id: generateUuid(),
		}));

		const workspaceFacts = newFacts.filter(f => f.scope === 'workspace');
		const userFactsToAdd = newFacts.filter(f => f.scope === 'user');

		if (workspaceFacts.length > 0) {
			this.workspaceFacts.push(...workspaceFacts);
			await this.saveWorkspaceFacts();
		}

		if (userFactsToAdd.length > 0) {
			this.userFacts.push(...userFactsToAdd);
			this.saveUserFacts();
		}

		this._onDidChangeMemories.fire(undefined);
		return newFacts;
	}

	async removeFact(id: string): Promise<void> {
		await this.ensureInitialized();

		const workspaceIndex = this.workspaceFacts.findIndex(f => f.id === id);
		if (workspaceIndex !== -1) {
			this.workspaceFacts.splice(workspaceIndex, 1);
			await this.saveWorkspaceFacts();
			this._onDidChangeMemories.fire('workspace');
			return;
		}

		const userIndex = this.userFacts.findIndex(f => f.id === id);
		if (userIndex !== -1) {
			this.userFacts.splice(userIndex, 1);
			this.saveUserFacts();
			this._onDidChangeMemories.fire('user');
		}
	}

	async updateFact(id: string, updates: Partial<Omit<IMemoryFact, 'id'>>): Promise<void> {
		await this.ensureInitialized();

		const workspaceFact = this.workspaceFacts.find(f => f.id === id);
		if (workspaceFact) {
			Object.assign(workspaceFact, updates);
			await this.saveWorkspaceFacts();
			this._onDidChangeMemories.fire('workspace');
			return;
		}

		const userFact = this.userFacts.find(f => f.id === id);
		if (userFact) {
			Object.assign(userFact, updates);
			this.saveUserFacts();
			this._onDidChangeMemories.fire('user');
		}
	}

	getLastExtractionTime(scope: MemoryScope): number | undefined {
		return this.lastExtractionTimes.get(scope);
	}

	setLastExtractionTime(scope: MemoryScope, time: number): void {
		this.lastExtractionTimes.set(scope, time);

		const storageKey = `${ChatMemoryStorage.LAST_EXTRACTION_KEY}.${scope}`;
		const storageScope = scope === 'workspace' ? StorageScope.WORKSPACE : StorageScope.PROFILE;
		this.storageService.store(storageKey, time.toString(), storageScope, StorageTarget.MACHINE);
	}

	async pruneFacts(scope: MemoryScope): Promise<IMemoryPruneResult> {
		await this.ensureInitialized();

		const maxFacts = scope === 'workspace'
			? getMaxWorkspaceFacts(this.configurationService)
			: getMaxUserFacts(this.configurationService);

		const facts = scope === 'workspace' ? this.workspaceFacts : this.userFacts;
		if (facts.length <= maxFacts) {
			return {
				mergedFacts: [],
				removedFacts: [],
				finalCount: facts.length,
			};
		}

		// Simple pruning: score by recency and confidence, remove lowest scoring
		const scoredFacts = facts.map(fact => ({
			fact,
			score: this.calculateFactScore(fact),
		}));

		scoredFacts.sort((a, b) => b.score - a.score);

		const factsToKeep = scoredFacts.slice(0, maxFacts).map(sf => sf.fact);
		const factsToRemove = scoredFacts.slice(maxFacts).map(sf => sf.fact);

		if (scope === 'workspace') {
			this.workspaceFacts = factsToKeep;
			await this.saveWorkspaceFacts();
		} else {
			this.userFacts = factsToKeep;
			this.saveUserFacts();
		}

		this._onDidChangeMemories.fire(scope);

		return {
			mergedFacts: [],
			removedFacts: factsToRemove,
			finalCount: factsToKeep.length,
		};
	}

	private calculateFactScore(fact: IMemoryFact): number {
		const now = Date.now();
		const ageMs = now - fact.timestamp;
		const ageDays = ageMs / (1000 * 60 * 60 * 24);

		// Recency score: exponential decay over 30 days
		const recencyScore = Math.exp(-ageDays / 30);

		// Confidence score directly from fact
		const confidenceScore = fact.confidence;

		// Combined score (weights can be adjusted)
		return 0.6 * recencyScore + 0.4 * confidenceScore;
	}

	async clearFacts(scope: MemoryScope): Promise<void> {
		await this.ensureInitialized();

		if (scope === 'workspace') {
			this.workspaceFacts = [];
			await this.saveWorkspaceFacts();
		} else {
			this.userFacts = [];
			this.saveUserFacts();
		}

		this._onDidChangeMemories.fire(scope);
	}

	async getFactCount(scope: MemoryScope): Promise<number> {
		await this.ensureInitialized();
		return scope === 'workspace' ? this.workspaceFacts.length : this.userFacts.length;
	}
}
