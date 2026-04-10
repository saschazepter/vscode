/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { AICustomizationManagementSection } from './aiCustomizationManagement.js';
import { IAICustomizationWorkspaceService, IWelcomePageFeatures } from '../../common/aiCustomizationWorkspaceService.js';
import { PromptLaunchersAICustomizationWelcomePage } from './aiCustomizationWelcomePagePromptLaunchers.js';

const $ = DOM.$;

export interface IWelcomePageCallbacks {
	selectSection(section: AICustomizationManagementSection): void;
	selectSectionWithMarketplace(section: AICustomizationManagementSection): void;
	closeEditor(): void;
	/**
	 * Prefill the chat input with a query. In the sessions window this
	 * uses the sessions chat widget; in core VS Code it opens the chat view.
	 */
	prefillChat(query: string, options?: { isPartialQuery?: boolean }): void;
}

export interface IAICustomizationWelcomePageImplementation extends IDisposable {
	readonly container: HTMLElement;
	rebuildCards(visibleSectionIds: ReadonlySet<AICustomizationManagementSection>): void;
	focus(): void;
}

/**
 * Renders the welcome page for AI Customizations.
 */
export class AICustomizationWelcomePage extends Disposable {

	private readonly implementation: PromptLaunchersAICustomizationWelcomePage;

	readonly container: HTMLElement;

	constructor(
		parent: HTMLElement,
		welcomePageFeatures: IWelcomePageFeatures | undefined,
		callbacks: IWelcomePageCallbacks,
		commandService: ICommandService,
		workspaceService: IAICustomizationWorkspaceService,
	) {
		super();

		this.container = DOM.append(parent, $('.welcome-page-host'));
		this.container.style.height = '100%';
		this.container.style.overflow = 'hidden';
		this.implementation = this._register(new PromptLaunchersAICustomizationWelcomePage(this.container, welcomePageFeatures, callbacks, commandService, workspaceService));
	}

	rebuildCards(visibleSectionIds: ReadonlySet<AICustomizationManagementSection>): void {
		this.implementation.rebuildCards(visibleSectionIds);
	}

	focus(): void {
		this.implementation.focus();
	}
}
