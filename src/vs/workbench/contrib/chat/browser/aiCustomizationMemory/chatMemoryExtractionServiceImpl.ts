/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../base/browser/window.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ChatMemoryConfiguration, IMemoryFact, MemorySuggestionMode } from '../../common/chatMemory/chatMemory.js';
import { IChatMemoryExtractionService, IExtractionResult } from '../../common/chatMemory/chatMemoryExtractionService.js';
import { IChatMemoryService } from '../../common/chatMemory/chatMemoryService.js';
import { IChatService } from '../../common/chatService/chatService.js';
import { getExtractionIntervalMinutes, getSuggestionMode } from './chatMemoryConfiguration.js';

const PROCESSED_SESSIONS_KEY = 'chat.memory.processedSessions';

/**
 * Extraction prompt for the LLM.
 */
const EXTRACTION_SYSTEM_PROMPT = 'You are analyzing a coding assistant conversation to extract durable, actionable facts.\n\n' +
	'Your task:\n' +
	'1. Extract facts about codebase conventions, patterns, tools, or user preferences\n' +
	'2. Separate facts into WORKSPACE (this project) vs USER (personal style) scope\n' +
	'3. Filter out transient/ephemeral information\n\n' +
	'Rules:\n' +
	'- Facts must be actionable for future coding tasks\n' +
	'- Facts must be durable (not session-specific like "tests failing now")\n' +
	'- Exclude secrets, tokens, emails, credentials\n' +
	'- Prefer short, imperative or declarative statements\n' +
	'- If fact references files/paths/tools/CI, scope=workspace\n' +
	'- If about personal style with no repo tie, scope=user\n\n' +
	'Output JSON only:\n' +
	'{"facts": [{"content": "Use tabs for indentation", "reason": "User explicitly stated preference", "citations": ["conversation turn 3"], "scope": "workspace", "confidence": 0.9}]}';

/**
 * Implementation of IChatMemoryExtractionService.
 * Handles background extraction of memory facts from chat history.
 */
export class ChatMemoryExtractionServiceImpl extends Disposable implements IChatMemoryExtractionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidExtract = this._register(new Emitter<IExtractionResult>());
	readonly onDidExtract: Event<IExtractionResult> = this._onDidExtract.event;

	private readonly _onDidChangeSuggestionMode = this._register(new Emitter<MemorySuggestionMode>());
	readonly onDidChangeSuggestionMode: Event<MemorySuggestionMode> = this._onDidChangeSuggestionMode.event;

	private _suggestionMode: MemorySuggestionMode;
	private _isExtracting = false;
	private processedSessionIds: Set<string> = new Set();

	private schedulerInterval: number | undefined;

	constructor(
		@IChatService private readonly chatService: IChatService,
		@IChatMemoryService private readonly memoryService: IChatMemoryService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._suggestionMode = getSuggestionMode(configurationService);

		// Load processed session IDs
		this.loadProcessedSessionIds();

		// Listen for configuration changes
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ChatMemoryConfiguration.SUGGESTION_MODE)) {
				const newMode = getSuggestionMode(configurationService);
				if (newMode !== this._suggestionMode) {
					const oldMode = this._suggestionMode;
					this._suggestionMode = newMode;
					this._onDidChangeSuggestionMode.fire(newMode);
					this.handleModeChange(oldMode, newMode);
				}
			}
		}));

		// Initialize based on current mode
		if (this._suggestionMode === MemorySuggestionMode.Occasional) {
			this.startScheduler();
		}
	}

	get suggestionMode(): MemorySuggestionMode {
		return this._suggestionMode;
	}

	get isExtracting(): boolean {
		return this._isExtracting;
	}

	private loadProcessedSessionIds(): void {
		const stored = this.storageService.get(PROCESSED_SESSIONS_KEY, StorageScope.WORKSPACE);
		if (stored) {
			try {
				const ids = JSON.parse(stored) as string[];
				this.processedSessionIds = new Set(ids);
			} catch {
				this.processedSessionIds = new Set();
			}
		}
	}

	private saveProcessedSessionIds(): void {
		const ids = Array.from(this.processedSessionIds);
		// Keep only last 100 to prevent unbounded growth
		const trimmedIds = ids.slice(-100);
		this.storageService.store(
			PROCESSED_SESSIONS_KEY,
			JSON.stringify(trimmedIds),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE
		);
	}

	private handleModeChange(oldMode: MemorySuggestionMode, newMode: MemorySuggestionMode): void {
		// Stop scheduler if leaving occasional mode
		if (oldMode === MemorySuggestionMode.Occasional) {
			this.stopScheduler();
		}

		// Start scheduler if entering occasional mode
		if (newMode === MemorySuggestionMode.Occasional) {
			this.startScheduler();
		}
	}

	startScheduler(): void {
		if (this.schedulerInterval) {
			return;
		}

		const intervalMinutes = getExtractionIntervalMinutes(this.configurationService);
		const intervalMs = intervalMinutes * 60 * 1000;

		this.logService.debug(`[ChatMemoryExtraction] Starting scheduler with interval ${intervalMinutes} minutes`);

		this.schedulerInterval = mainWindow.setInterval(() => {
			if (this._suggestionMode === MemorySuggestionMode.Occasional && !this._isExtracting) {
				this.extractNow().catch(e => {
					this.logService.error('[ChatMemoryExtraction] Scheduled extraction failed:', e);
				});
			}
		}, intervalMs);
	}

	stopScheduler(): void {
		if (this.schedulerInterval) {
			mainWindow.clearInterval(this.schedulerInterval);
			this.schedulerInterval = undefined;
			this.logService.debug('[ChatMemoryExtraction] Stopped scheduler');
		}
	}

	async extractNow(token?: CancellationToken): Promise<IExtractionResult> {
		if (this._suggestionMode === MemorySuggestionMode.Off) {
			return {
				facts: [],
				processedSessionIds: [],
				durationMs: 0,
				errors: ['Extraction is disabled (mode is off)'],
			};
		}

		if (this._isExtracting) {
			return {
				facts: [],
				processedSessionIds: [],
				durationMs: 0,
				errors: ['Extraction already in progress'],
			};
		}

		this._isExtracting = true;
		const startTime = Date.now();
		const facts: IMemoryFact[] = [];
		const processedSessionIds: string[] = [];
		const errors: string[] = [];

		try {
			const unprocessedIds = await this.getUnprocessedSessionIds();
			this.logService.debug(`[ChatMemoryExtraction] Found ${unprocessedIds.length} unprocessed sessions`);

			if (unprocessedIds.length === 0) {
				const result: IExtractionResult = {
					facts: [],
					processedSessionIds: [],
					durationMs: Date.now() - startTime,
					errors: [],
				};
				return result;
			}

			// Process sessions - for now, we'll use a simple heuristic-based extraction
			// In a full implementation, this would call an LLM
			for (const sessionId of unprocessedIds) {
				if (token?.isCancellationRequested) {
					break;
				}

				try {
					const sessionFacts = await this.extractFromSession(sessionId, token);
					facts.push(...sessionFacts);
					processedSessionIds.push(sessionId);
				} catch (e) {
					errors.push(`Failed to extract from session ${sessionId}: ${e}`);
				}
			}

			// Store extracted facts
			if (facts.length > 0) {
				await this.memoryService.addFacts(facts);
			}

			// Update last extraction time
			this.memoryService.setLastExtractionTime('workspace', Date.now());
			this.memoryService.setLastExtractionTime('user', Date.now());

		} catch (e) {
			errors.push(`Extraction failed: ${e}`);
			this.logService.error('[ChatMemoryExtraction] Extraction failed:', e);
		} finally {
			this._isExtracting = false;
		}

		const result: IExtractionResult = {
			facts,
			processedSessionIds,
			durationMs: Date.now() - startTime,
			errors,
		};

		this._onDidExtract.fire(result);
		return result;
	}

	async extractFromSession(sessionId: string, _token?: CancellationToken): Promise<IMemoryFact[]> {
		// For now, return empty - this is a placeholder for actual LLM extraction
		// In a full implementation, this would:
		// 1. Load the session from chatService
		// 2. Format the conversation for the LLM
		// 3. Call the LLM with EXTRACTION_SYSTEM_PROMPT
		// 4. Parse the response into IMemoryFact[]

		this.logService.debug(`[ChatMemoryExtraction] Extracting from session ${sessionId} (placeholder)`);

		// Mark as processed
		this.markSessionProcessed(sessionId);

		// Placeholder: In a real implementation, we'd call the LLM here
		// For now, just mark as processed without extracting anything
		return [];
	}

	async getUnprocessedSessionIds(): Promise<string[]> {
		try {
			const historyItems = await this.chatService.getHistorySessionItems();
			const allSessionIds = historyItems.map(item => item.sessionResource.toString());

			return allSessionIds.filter(id => !this.processedSessionIds.has(id));
		} catch (e) {
			this.logService.error('[ChatMemoryExtraction] Failed to get unprocessed sessions:', e);
			return [];
		}
	}

	markSessionProcessed(sessionId: string): void {
		this.processedSessionIds.add(sessionId);
		this.saveProcessedSessionIds();
	}

	override dispose(): void {
		this.stopScheduler();
		super.dispose();
	}
}

// Export the system prompt for potential use in tests
export { EXTRACTION_SYSTEM_PROMPT };
