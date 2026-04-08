/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationWelcome.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { DisposableStore, Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { AICustomizationManagementSection } from './aiCustomizationManagement.js';
import { agentIcon, instructionsIcon, skillIcon, hookIcon, pluginIcon } from './aiCustomizationIcons.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { IAICustomizationWorkspaceService, IWelcomePageFeatures } from '../../common/aiCustomizationWorkspaceService.js';

const $ = DOM.$;

interface ICategoryDescription {
	readonly id: AICustomizationManagementSection;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly description: string;
	readonly promptType?: PromptsType;
}

export interface IWelcomePageCallbacks {
	selectSection(section: AICustomizationManagementSection): void;
	closeEditor(): void;
}

/**
 * Renders the welcome page for the Chat Customizations editor.
 * This is the original welcome page layout: heading, subtitle,
 * "Configure Your AI" banner, and a responsive card grid.
 */
export class AICustomizationWelcomePage extends Disposable {

	private readonly cardDisposables = this._register(new DisposableStore());

	readonly container: HTMLElement;
	private cardsContainer: HTMLElement | undefined;
	private inputBox: InputBox | undefined;

	private readonly categoryDescriptions: ICategoryDescription[] = [
		{
			id: AICustomizationManagementSection.Agents,
			label: localize('agents', "Agents"),
			icon: agentIcon,
			description: localize('agentsDesc', "Define custom agents with specialized personas, tool access, and instructions for specific tasks."),
			promptType: PromptsType.agent,
		},
		{
			id: AICustomizationManagementSection.Skills,
			label: localize('skills', "Skills"),
			icon: skillIcon,
			description: localize('skillsDesc', "Create reusable skill files that provide domain-specific knowledge and workflows."),
			promptType: PromptsType.skill,
		},
		{
			id: AICustomizationManagementSection.Instructions,
			label: localize('instructions', "Instructions"),
			icon: instructionsIcon,
			description: localize('instructionsDesc', "Set always-on instructions that guide AI behavior across your workspace or user profile."),
			promptType: PromptsType.instructions,
		},
		{
			id: AICustomizationManagementSection.Hooks,
			label: localize('hooks', "Hooks"),
			icon: hookIcon,
			description: localize('hooksDesc', "Configure automated actions triggered by events like saving files or running tasks."),
			promptType: PromptsType.hook,
		},
		{
			id: AICustomizationManagementSection.McpServers,
			label: localize('mcpServers', "MCP Servers"),
			icon: Codicon.server,
			description: localize('mcpServersDesc', "Connect external tool servers that extend AI capabilities with custom tools and data sources."),
		},
		{
			id: AICustomizationManagementSection.Plugins,
			label: localize('plugins', "Plugins"),
			icon: pluginIcon,
			description: localize('pluginsDesc', "Install and manage agent plugins that add additional tools, skills, and integrations."),
		},
	];

	constructor(
		parent: HTMLElement,
		private readonly welcomePageFeatures: IWelcomePageFeatures | undefined,
		private readonly callbacks: IWelcomePageCallbacks,
		private readonly commandService: ICommandService,
		private readonly workspaceService: IAICustomizationWorkspaceService,
	) {
		super();

		this.container = DOM.append(parent, $('.welcome-content-container'));
		const welcomeInner = DOM.append(this.container, $('.welcome-inner'));

		const heading = DOM.append(welcomeInner, $('h2.welcome-heading'));
		heading.textContent = localize('welcomeHeading', "Chat Customizations");

		const subtitle = DOM.append(welcomeInner, $('p.welcome-subtitle'));
		subtitle.textContent = localize('welcomeSubtitle', "Tailor how AI agents work in your projects. Configure workspace customizations for the entire team, or create personal ones that follow you across projects.");

		// Chat-style input box
		if (this.welcomePageFeatures?.showGettingStartedBanner !== false) {
			const inputRow = DOM.append(welcomeInner, $('.welcome-input-row'));

			this.inputBox = this._register(new InputBox(inputRow, undefined, {
				placeholder: localize('workflowInputPlaceholder', "Describe your project and coding patterns..."),
				ariaLabel: localize('workflowInputAriaLabel', "Describe your project to configure AI"),
				inputBoxStyles: defaultInputBoxStyles,
			}));
			this.inputBox.element.classList.add('welcome-input');

			const submitBtn = DOM.append(inputRow, $('button.welcome-input-submit'));
			submitBtn.setAttribute('aria-label', localize('workflowSubmitAriaLabel', "Configure with AI"));
			DOM.append(submitBtn, $('span.codicon.codicon-arrow-right'));

			const submit = () => {
				const value = this.inputBox?.value?.trim();
				this.callbacks.closeEditor();
				const query = value
					? `/agent-customization ${value}`
					: '/agent-customization ';
				this.commandService.executeCommand('workbench.action.chat.open', { query, isPartialQuery: !value });
			};

			this._register(DOM.addDisposableListener(submitBtn, 'click', submit));
			this._register(DOM.addDisposableListener(this.inputBox.inputElement, 'keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					submit();
				}
			}));
		}

		// Centered separator
		const divider = DOM.append(welcomeInner, $('.welcome-section-divider'));
		const dividerLabel = DOM.append(divider, $('span.welcome-section-divider-label'));
		dividerLabel.textContent = localize('orConfigureIndividually', "or configure individually");

		this.cardsContainer = DOM.append(welcomeInner, $('.welcome-cards'));
	}

	/**
	 * Rebuilds the card grid based on the currently visible sections.
	 */
	rebuildCards(visibleSectionIds: ReadonlySet<AICustomizationManagementSection>): void {
		if (!this.cardsContainer) {
			return;
		}
		this.cardDisposables.clear();
		DOM.clearNode(this.cardsContainer);

		for (const category of this.categoryDescriptions) {
			if (!visibleSectionIds.has(category.id)) {
				continue;
			}

			const card = DOM.append(this.cardsContainer, $('.welcome-card'));
			card.setAttribute('tabindex', '0');
			card.setAttribute('role', 'button');

			const cardHeader = DOM.append(card, $('.welcome-card-header'));
			const iconEl = DOM.append(cardHeader, $('.welcome-card-icon'));
			iconEl.classList.add(...ThemeIcon.asClassNameArray(category.icon));
			const labelEl = DOM.append(cardHeader, $('span.welcome-card-label'));
			labelEl.textContent = category.label;

			const descEl = DOM.append(card, $('p.welcome-card-description'));
			descEl.textContent = category.description;

			const cardFooter = DOM.append(card, $('.welcome-card-footer'));

			// "Browse" button navigates to the section
			const browseBtn = DOM.append(cardFooter, $('button.welcome-card-browse'));
			browseBtn.textContent = localize('browse', "Browse");
			this.cardDisposables.add(DOM.addDisposableListener(browseBtn, 'click', (e) => {
				e.stopPropagation();
				this.callbacks.selectSection(category.id);
			}));

			// "Generate with AI" button (only for prompt-based sections when enabled)
			if (category.promptType && this.workspaceService.welcomePageFeatures?.showGenerateActions !== false) {
				const generateBtn = DOM.append(cardFooter, $('button.welcome-card-generate'));
				DOM.append(generateBtn, $('span.codicon.codicon-sparkle'));
				const generateLabel = DOM.append(generateBtn, $('span'));
				generateLabel.textContent = localize('generateWithAI', "Generate with AI");
				const promptType = category.promptType;
				this.cardDisposables.add(DOM.addDisposableListener(generateBtn, 'click', (e) => {
					e.stopPropagation();
					this.callbacks.closeEditor();
					this.workspaceService.generateCustomization(promptType);
				}));
			}

			// Clicking the card itself navigates to the section
			this.cardDisposables.add(DOM.addDisposableListener(card, 'click', () => {
				this.callbacks.selectSection(category.id);
			}));
			this.cardDisposables.add(DOM.addDisposableListener(card, 'keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					this.callbacks.selectSection(category.id);
				}
			}));
		}
	}

	/**
	 * Focuses the getting-started button if available.
	 */
	focus(): void {
		this.inputBox?.focus();
	}
}
