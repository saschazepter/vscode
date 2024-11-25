/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatInputPart } from '../chatInputPart.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { CompletionContext, CompletionItem, CompletionItemProvider, CompletionList, ProviderResult } from '../../../../../editor/common/languages.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../../common/contributions.js';

/**
 * TODO: @legomushroom
 */
class PromptDocumentCompletions extends Disposable implements CompletionItemProvider {
	/** TODO: @legomushroom */
	public readonly _debugDisplayName: string = 'PromptDocumentCompletions';

	/** TODO: @legomushroom */
	public readonly triggerCharacters: string[] = ['#']; // TODO: @legomushroom - use a constant instead

	constructor(
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
	) {
		super();

		this._register(this.languageFeaturesService.completionProvider.register({
			scheme: ChatInputPart.INPUT_SCHEME,
			hasAccessToAllModels: true,
			pattern: '*.prompt.md', // TODO: @legomushroom - use a constant instead
		}, this));
		// this._register(CommandsRegistry.registerCommand(BuiltinDynamicCompletions.addReferenceCommand, (_services, arg) => this.cmdAddReference(arg)));
	}

	provideCompletionItems(model: ITextModel, position: Position, context: CompletionContext, token: CancellationToken): ProviderResult<CompletionList> {
		throw new Error('Method not implemented.');
	}

	resolveCompletionItem?(item: CompletionItem, token: CancellationToken): ProviderResult<CompletionItem> {
		throw new Error('Method not implemented.');
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(PromptDocumentCompletions, LifecyclePhase.Eventually);
