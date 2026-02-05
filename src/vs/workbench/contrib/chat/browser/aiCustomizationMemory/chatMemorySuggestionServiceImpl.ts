/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import {
	IMemoryFact,
	IMemorySuggestion,
	ISerializableMemorySuggestion,
	SuggestionStatus,
	SuggestionTargetType,
} from '../../common/chatMemory/chatMemory.js';
import { IApplySuggestionResult, IChatMemorySuggestionService } from '../../common/chatMemory/chatMemorySuggestionService.js';
import { IPromptsService, PromptsStorage } from '../../common/promptSyntax/service/promptsService.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';

const SUGGESTIONS_STORAGE_KEY = 'chat.memory.suggestions';

/**
 * Matching prompt for determining where a fact should be merged.
 */
const MATCHING_SYSTEM_PROMPT = 'You are analyzing a fact to determine where it should be merged into existing AI customization files.\n\n' +
	'Given a fact and available customization files, determine the best target.\n\n' +
	'Target types:\n' +
	'- instructions: General coding guidelines (.instructions.md)\n' +
	'- agent: AI persona/behavior rules (.agent.md)\n' +
	'- skill: Workflow/capability steps (SKILL.md)\n' +
	'- prompt: Reusable snippet (.prompt.md)\n' +
	'- hook: Automation on events (hooks.json)\n' +
	'- newFile: Create new file if no good match\n\n' +
	'Output JSON:\n' +
	'{"targetType": "instructions", "targetUri": "path/to/file.instructions.md", "suggestedMergeContent": "The formatted content to insert", "confidence": 0.8}';

/**
 * Implementation of IChatMemorySuggestionService.
 * Matches memory facts to customization targets and generates merge suggestions.
 */
export class ChatMemorySuggestionServiceImpl extends Disposable implements IChatMemorySuggestionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidAddSuggestion = this._register(new Emitter<IMemorySuggestion>());
	readonly onDidAddSuggestion: Event<IMemorySuggestion> = this._onDidAddSuggestion.event;

	private readonly _onDidChangeSuggestions = this._register(new Emitter<void>());
	readonly onDidChangeSuggestions: Event<void> = this._onDidChangeSuggestions.event;

	private suggestions: IMemorySuggestion[] = [];
	private initialized = false;

	constructor(
		@IPromptsService private readonly promptsService: IPromptsService,
		@IStorageService private readonly storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	private async ensureInitialized(): Promise<void> {
		if (this.initialized) {
			return;
		}
		this.initialized = true;
		await this.loadSuggestions();
	}

	private async loadSuggestions(): Promise<void> {
		const stored = this.storageService.get(SUGGESTIONS_STORAGE_KEY, StorageScope.WORKSPACE);
		if (stored) {
			try {
				const data = JSON.parse(stored) as ISerializableMemorySuggestion[];
				this.suggestions = data.map(s => this.deserializeSuggestion(s));
			} catch {
				this.suggestions = [];
			}
		}
	}

	private saveSuggestions(): void {
		const serializable = this.suggestions.map(s => this.serializeSuggestion(s));
		this.storageService.store(
			SUGGESTIONS_STORAGE_KEY,
			JSON.stringify(serializable),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE
		);
	}

	private serializeSuggestion(suggestion: IMemorySuggestion): ISerializableMemorySuggestion {
		return {
			id: suggestion.id,
			content: suggestion.content,
			reason: suggestion.reason,
			citations: suggestion.citations,
			timestamp: suggestion.timestamp,
			scope: suggestion.scope,
			sourceSessionId: suggestion.sourceSessionId,
			confidence: suggestion.confidence,
			targetType: suggestion.targetType,
			targetUri: suggestion.targetUri?.toString(),
			suggestedFileName: suggestion.suggestedFileName,
			suggestedMergeContent: suggestion.suggestedMergeContent,
			status: suggestion.status,
		};
	}

	private deserializeSuggestion(data: ISerializableMemorySuggestion): IMemorySuggestion {
		return {
			id: data.id,
			content: data.content,
			reason: data.reason,
			citations: data.citations ?? [],
			timestamp: data.timestamp,
			scope: data.scope,
			sourceSessionId: data.sourceSessionId,
			confidence: data.confidence,
			targetType: data.targetType,
			targetUri: data.targetUri ? URI.parse(data.targetUri) : undefined,
			suggestedFileName: data.suggestedFileName,
			suggestedMergeContent: data.suggestedMergeContent,
			status: data.status,
		};
	}

	async listSuggestions(status?: SuggestionStatus): Promise<IMemorySuggestion[]> {
		await this.ensureInitialized();

		if (status) {
			return this.suggestions.filter(s => s.status === status);
		}
		return [...this.suggestions];
	}

	async generateSuggestionsForFact(fact: IMemoryFact, _token?: CancellationToken): Promise<IMemorySuggestion[]> {
		await this.ensureInitialized();

		// Find the best target for this fact using heuristics
		const target = await this.findBestTarget(fact);

		const suggestion: IMemorySuggestion = {
			...fact,
			id: generateUuid(),
			targetType: target.type,
			targetUri: target.uri,
			suggestedFileName: target.suggestedFileName,
			suggestedMergeContent: this.formatMergeContent(fact, target.type),
			status: 'pending',
		};

		this.suggestions.push(suggestion);
		this.saveSuggestions();
		this._onDidAddSuggestion.fire(suggestion);
		this._onDidChangeSuggestions.fire();

		return [suggestion];
	}

	async generateSuggestionsForFacts(facts: IMemoryFact[], token?: CancellationToken): Promise<IMemorySuggestion[]> {
		const allSuggestions: IMemorySuggestion[] = [];

		for (const fact of facts) {
			if (token?.isCancellationRequested) {
				break;
			}
			const suggestions = await this.generateSuggestionsForFact(fact, token);
			allSuggestions.push(...suggestions);
		}

		return allSuggestions;
	}

	private async findBestTarget(fact: IMemoryFact): Promise<{
		type: SuggestionTargetType;
		uri?: URI;
		suggestedFileName?: string;
	}> {
		// Get existing customization files
		const instructionFiles = await this.promptsService.listPromptFilesForStorage(PromptsType.instructions, PromptsStorage.local, CancellationToken.None);
		const agentFiles = await this.promptsService.listPromptFilesForStorage(PromptsType.agent, PromptsStorage.local, CancellationToken.None);

		// Simple heuristics for matching
		const content = fact.content.toLowerCase();

		// Check if it's about coding style/conventions → instructions
		if (content.includes('use ') || content.includes('prefer ') || content.includes('avoid ') ||
			content.includes('always ') || content.includes('never ') || content.includes('convention')) {
			if (instructionFiles.length > 0) {
				// Find the most relevant instruction file based on citations
				const bestMatch = this.findBestMatchingFile(fact, instructionFiles);
				return { type: 'instructions', uri: bestMatch };
			}
			return { type: 'newFile', suggestedFileName: 'conventions.instructions.md' };
		}

		// Check if it's about AI behavior → agent
		if (content.includes('respond ') || content.includes('explain ') || content.includes('format ') ||
			content.includes('tone ') || content.includes('style ')) {
			if (agentFiles.length > 0) {
				const bestMatch = this.findBestMatchingFile(fact, agentFiles);
				return { type: 'agent', uri: bestMatch };
			}
			return { type: 'newFile', suggestedFileName: 'assistant.agent.md' };
		}

		// Default to instructions
		if (instructionFiles.length > 0) {
			return { type: 'instructions', uri: instructionFiles[0].uri };
		}

		return { type: 'newFile', suggestedFileName: 'coding.instructions.md' };
	}

	private findBestMatchingFile(fact: IMemoryFact, files: readonly { uri: URI }[]): URI {
		// For now, just return the first file
		// In a full implementation, we'd match based on:
		// 1. File's applyTo patterns matching fact citations
		// 2. Content similarity
		// 3. File name relevance
		return files[0].uri;
	}

	private formatMergeContent(fact: IMemoryFact, _targetType: SuggestionTargetType): string {
		// Format the fact as a bullet point or section
		return `- ${fact.content}`;
	}

	async applySuggestion(id: string): Promise<IApplySuggestionResult> {
		await this.ensureInitialized();

		const suggestion = this.suggestions.find(s => s.id === id);
		if (!suggestion) {
			return { success: false, error: 'Suggestion not found' };
		}

		if (suggestion.status !== 'pending') {
			return { success: false, error: `Suggestion is already ${suggestion.status}` };
		}

		try {
			if (suggestion.targetUri) {
				// Open the file and append the content
				const model = await this.textFileService.read(suggestion.targetUri);
				const existingContent = model.value;
				const newContent = existingContent + '\n' + suggestion.suggestedMergeContent;

				await this.textFileService.write(suggestion.targetUri, newContent);

				// Open the file in editor to show the change
				await this.editorService.openEditor({ resource: suggestion.targetUri });

				suggestion.status = 'applied';
				this.saveSuggestions();
				this._onDidChangeSuggestions.fire();

				return { success: true, targetUri: suggestion.targetUri };
			} else if (suggestion.suggestedFileName) {
				// Create a new file
				// This would use IPromptsService to create the file
				this.logService.info(`[ChatMemorySuggestion] Would create new file: ${suggestion.suggestedFileName}`);

				suggestion.status = 'applied';
				this.saveSuggestions();
				this._onDidChangeSuggestions.fire();

				return { success: true };
			}

			return { success: false, error: 'No target URI or filename specified' };
		} catch (e) {
			this.logService.error('[ChatMemorySuggestion] Failed to apply suggestion:', e);
			return { success: false, error: `Failed to apply: ${e}` };
		}
	}

	async dismissSuggestion(id: string): Promise<void> {
		await this.ensureInitialized();

		const suggestion = this.suggestions.find(s => s.id === id);
		if (suggestion && suggestion.status === 'pending') {
			suggestion.status = 'dismissed';
			this.saveSuggestions();
			this._onDidChangeSuggestions.fire();
		}
	}

	getPendingSuggestionCount(): number {
		return this.suggestions.filter(s => s.status === 'pending').length;
	}

	async clearSuggestions(status?: SuggestionStatus): Promise<void> {
		await this.ensureInitialized();

		if (status) {
			this.suggestions = this.suggestions.filter(s => s.status !== status);
		} else {
			this.suggestions = [];
		}

		this.saveSuggestions();
		this._onDidChangeSuggestions.fire();
	}

	async getSuggestionsGroupedByTarget(): Promise<Map<string, IMemorySuggestion[]>> {
		await this.ensureInitialized();

		const grouped = new Map<string, IMemorySuggestion[]>();

		for (const suggestion of this.suggestions.filter(s => s.status === 'pending')) {
			const key = suggestion.targetType;
			const existing = grouped.get(key) || [];
			existing.push(suggestion);
			grouped.set(key, existing);
		}

		return grouped;
	}
}

// Export the prompt for potential use in tests
export { MATCHING_SYSTEM_PROMPT };
