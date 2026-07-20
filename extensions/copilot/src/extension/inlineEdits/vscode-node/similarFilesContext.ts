/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getSimilarFilesOptions } from '../../completions-core/vscode-node/lib/src/experiments/similarFileOptionsProvider';
import { getPromptOptions } from '../../completions-core/vscode-node/lib/src/prompt/prompt';
import { NeighborSource, collectRelatedFileUris } from '../../completions-core/vscode-node/lib/src/prompt/similarFiles/neighborFiles';
import { TelemetryWithExp } from '../../completions-core/vscode-node/lib/src/telemetry';
import { ICompletionsTextDocumentManagerService } from '../../completions-core/vscode-node/lib/src/textDocumentManager';
import { DocumentInfoWithOffset } from '../../completions-core/vscode-node/prompt/src/prompt';
import { getSimilarSnippets } from '../../completions-core/vscode-node/prompt/src/snippetInclusion/similarFiles';
import { SnippetWithProviderInfo } from '../../completions-core/vscode-node/prompt/src/snippetInclusion/snippets';
import { ICopilotInlineCompletionItemProviderService } from '../../completions/common/copilotInlineCompletionItemProviderService';
import { LineRange0Based } from '../../xtab/common/lineRange';
import { INeighborFileSnippet, ISimilarFilesContextService } from '../../xtab/common/similarFilesContextService';

type RankedSnippet = SnippetWithProviderInfo & { uri: string; relativePath?: string };

export class SimilarFilesContextService implements ISimilarFilesContextService {

	readonly _serviceBrand: undefined;

	constructor(
		@ICopilotInlineCompletionItemProviderService private readonly _copilotService: ICopilotInlineCompletionItemProviderService,
	) { }

	async compute(uri: string, languageId: string, source: string, cursorOffset: number, includeRelatedFiles: boolean): Promise<string | undefined> {
		try {
			const result = await this._gatherSnippets(uri, languageId, source, cursorOffset, includeRelatedFiles);
			if (!result) {
				return undefined;
			}
			const { neighborFileCount, snippets } = result;
			return JSON.stringify({
				neighborFileCount,
				snippets: snippets.map(s => ({
					score: s.score,
					startLine: s.startLine,
					endLine: s.endLine,
					relativePath: s.relativePath,
					snippet: s.snippet,
				})),
			});
		} catch {
			return undefined;
		}
	}

	async getSnippetsForPrompt(uri: string, languageId: string, source: string, cursorOffset: number, includeRelatedFiles: boolean): Promise<readonly INeighborFileSnippet[] | undefined> {
		try {
			const result = await this._gatherSnippets(uri, languageId, source, cursorOffset, includeRelatedFiles);
			if (!result) {
				return undefined;
			}
			const { snippets, relatedFileUris } = result;
			return snippets.map(s => {
				const snippetUri = s.uri;
				return {
					uri: snippetUri,
					relativePath: s.relativePath,
					snippet: s.snippet,
					lineRange: new LineRange0Based(s.startLine, s.endLine),
					score: s.score,
					isFromRelatedFile: relatedFileUris.has(snippetUri),
				};
			});
		} catch {
			return undefined;
		}
	}

	private async _gatherSnippets(uri: string, languageId: string, source: string, cursorOffset: number, includeRelatedFiles: boolean): Promise<{ neighborFileCount: number; snippets: RankedSnippet[]; relatedFileUris: Set<string> } | undefined> {
		const completionsInstaService = this._copilotService.getOrCreateInstantiationService();
		const telemetryData = TelemetryWithExp.createEmptyConfigForTesting();

		const { docs, neighborSource } = await completionsInstaService.invokeFunction(
			accessor => NeighborSource.getNeighborFilesAndTraits(accessor, uri, languageId, telemetryData, undefined, undefined, undefined, includeRelatedFiles)
		);

		const relatedFileUris = collectRelatedFileUris(neighborSource);

		const promptOptions = completionsInstaService.invokeFunction(getPromptOptions, telemetryData, languageId);
		const similarFilesOptions =
			promptOptions.similarFilesOptions ||
			completionsInstaService.invokeFunction(getSimilarFilesOptions, telemetryData, languageId);

		const tdm = completionsInstaService.invokeFunction(accessor => accessor.get(ICompletionsTextDocumentManagerService));
		const relativePath = tdm.getRelativePath({ uri });

		const docInfo: DocumentInfoWithOffset = {
			uri,
			source,
			languageId,
			offset: cursorOffset,
			relativePath,
		};

		const neighborDocs = Array.from(docs.values());

		const snippets = (await getSimilarSnippets(
			docInfo,
			neighborDocs,
			similarFilesOptions,
		))
			.filter(s => s.snippet.length > 0)
			.sort((a, b) => a.score - b.score);

		return { neighborFileCount: docs.size, snippets, relatedFileUris };
	}
}
