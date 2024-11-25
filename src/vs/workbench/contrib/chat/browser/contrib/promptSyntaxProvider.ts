/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatInputPart } from '../chatInputPart.js';
import { Event } from '../../../../../base/common/event.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../../common/contributions.js';
import { DocumentSemanticTokensProvider, ProviderResult, SemanticTokens, SemanticTokensEdits, SemanticTokensLegend } from '../../../../../editor/common/languages.js';

/**
 * TODO: @legomushroom
 */
export class PromptSyntaxProvider extends Disposable implements DocumentSemanticTokensProvider {
	/** TODO: @legomushroom */
	public readonly _debugDisplayName: string = 'PromptSyntaxProvider';

	onDidChange?: Event<void> | undefined;

	constructor(
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
	) {
		super();

		this._register(this.languageFeaturesService.documentSemanticTokensProvider.register({
			scheme: ChatInputPart.INPUT_SCHEME,
			hasAccessToAllModels: true,
			pattern: '*.prompt.md', // TODO: @legomushroom - use a constant instead
		}, this));
		// this._register(CommandsRegistry.registerCommand(BuiltinDynamicCompletions.addReferenceCommand, (_services, arg) => this.cmdAddReference(arg)));
	}
	getLegend(): SemanticTokensLegend {
		throw new Error('Method not implemented.');
	}
	provideDocumentSemanticTokens(model: ITextModel, lastResultId: string | null, token: CancellationToken): ProviderResult<SemanticTokens | SemanticTokensEdits> {
		throw new Error('Method not implemented.');
	}
	releaseDocumentSemanticTokens(resultId: string | undefined): void {
		throw new Error('Method not implemented.');
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(PromptSyntaxProvider, LifecyclePhase.Eventually);
