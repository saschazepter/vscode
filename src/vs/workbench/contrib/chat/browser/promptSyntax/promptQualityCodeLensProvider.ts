/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { CodeLens, CodeLensList, CodeLensProvider } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { localize } from '../../../../../nls.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { ALL_PROMPTS_LANGUAGE_SELECTOR, getPromptsTypeForLanguageId } from '../../common/promptSyntax/promptTypes.js';
import { registerEditorFeature } from '../../../../../editor/common/editorFeatures.js';
import { QUALITY_MARKERS_OWNER_ID } from '../../common/promptSyntax/languageProviders/promptQualityContribution.js';
import { CHARS_PER_TOKEN } from '../../common/promptSyntax/languageProviders/promptQualityConstants.js';

class PromptQualityCodeLensProvider extends Disposable implements CodeLensProvider {

	private readonly _onDidChange = this._register(new Emitter<this>());
	public readonly onDidChange: Event<this> = this._onDidChange.event;

	constructor(
		@ILanguageFeaturesService languageService: ILanguageFeaturesService,
		@IMarkerService private readonly markerService: IMarkerService,
	) {
		super();
		this._register(languageService.codeLensProvider.register(ALL_PROMPTS_LANGUAGE_SELECTOR, this));
		this._register(this.markerService.onMarkerChanged(resources => {
			if (resources.some(() => true)) {
				this._onDidChange.fire(this);
			}
		}));
	}

	async provideCodeLenses(model: ITextModel, _token: CancellationToken): Promise<undefined | CodeLensList> {
		const promptType = getPromptsTypeForLanguageId(model.getLanguageId());
		if (!promptType) {
			return undefined;
		}

		const lenses: CodeLens[] = [];

		// Issue count summary at top of file
		const markers = this.markerService.read({
			resource: model.uri,
			owner: QUALITY_MARKERS_OWNER_ID,
		});
		const issueCount = markers.length;
		lenses.push({
			range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
			command: {
				title: issueCount === 0
					? localize('promptQualityCodeLens.noIssues', "Prompt Quality: No issues found")
					: localize('promptQualityCodeLens.issues', "Prompt Quality: {0} issue(s) found", issueCount),
				id: 'workbench.actions.view.problems',
			},
		});

		// Per-section token counts (single pass)
		const lineCount = model.getLineCount();
		type SectionInfo = { line: number; name: string; chars: number };
		const sections: SectionInfo[] = [];
		let currentSection: SectionInfo | undefined;
		for (let i = 1; i <= lineCount; i++) {
			const lineContent = model.getLineContent(i);
			const headerMatch = lineContent.match(/^(#{1,6})\s+(.+)$/);
			if (headerMatch) {
				currentSection = { line: i, name: headerMatch[2], chars: 0 };
				sections.push(currentSection);
			}
			if (currentSection) {
				currentSection.chars += lineContent.length + 1; // +1 for newline
			}
		}

		for (const section of sections) {
			const sectionTokens = Math.ceil(section.chars / CHARS_PER_TOKEN);
			lenses.push({
				range: { startLineNumber: section.line, startColumn: 1, endLineNumber: section.line, endColumn: 1 },
				command: {
					title: localize('promptQualityCodeLens.sectionTokens', "\u00A7 {0} \u2014 ~{1} tokens", section.name, sectionTokens),
					id: 'workbench.actions.view.problems',
				},
			});
		}

		if (lenses.length === 0) {
			return undefined;
		}

		return { lenses, dispose: () => { } };
	}
}

registerEditorFeature(PromptQualityCodeLensProvider);
