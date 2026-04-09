/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationWelcomeClassic.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { AICustomizationManagementSection } from './aiCustomizationManagement.js';
import { agentIcon, instructionsIcon, pluginIcon, skillIcon, hookIcon } from './aiCustomizationIcons.js';
import { IAICustomizationWorkspaceService, IWelcomePageFeatures } from '../../common/aiCustomizationWorkspaceService.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import type { IAICustomizationWelcomePageImplementation, IWelcomePageCallbacks } from './aiCustomizationWelcomePage.js';

const $ = DOM.$;

interface IClassicCategoryDescription {
	readonly id: AICustomizationManagementSection;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly description: string;
	readonly promptType?: PromptsType;
}

export class ClassicAICustomizationWelcomePage extends Disposable implements IAICustomizationWelcomePageImplementation {

	private readonly cardDisposables = this._register(new DisposableStore());

	readonly container: HTMLElement;
	private cardsContainer: HTMLElement | undefined;
	private inputBox: InputBox | undefined;

	private readonly categoryDescriptions: IClassicCategoryDescription[] = [
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

		this.container = DOM.append(parent, $('.welcome-classic-content-container'));
		const welcomeInner = DOM.append(this.container, $('.welcome-classic-inner'));

		const heading = DOM.append(welcomeInner, $('h2.welcome-classic-heading'));
		heading.textContent = localize('welcomeHeading', "Agent Customizations");

		const subtitle = DOM.append(welcomeInner, $('p.welcome-classic-subtitle'));
		subtitle.textContent = localize('welcomeSubtitle', "Tailor how your agents work in your projects. Configure workspace customizations for the entire team, or create personal ones that follow you across projects.");

		if (this.welcomePageFeatures?.showGettingStartedBanner !== false) {
			const gettingStarted = DOM.append(welcomeInner, $('.welcome-classic-getting-started'));
			const header = DOM.append(gettingStarted, $('.welcome-classic-getting-started-header'));
			const icon = DOM.append(header, $('span.welcome-classic-getting-started-icon.codicon.codicon-sparkle'));
			icon.setAttribute('aria-hidden', 'true');
			const title = DOM.append(header, $('span.welcome-classic-getting-started-title'));
			title.textContent = localize('gettingStartedTitle', "Generate Workflow");

			const inputRow = DOM.append(gettingStarted, $('.welcome-classic-input-row'));
			this.inputBox = this._register(new InputBox(inputRow, undefined, {
				placeholder: localize('workflowInputPlaceholder', "Describe your project and coding patterns..."),
				ariaLabel: localize('workflowInputAriaLabel', "Describe your project to generate a workflow"),
				inputBoxStyles: {
					...defaultInputBoxStyles,
					inputBorder: 'transparent',
					inputBackground: 'transparent',
				},
			}));
			this.inputBox.element.classList.add('welcome-classic-input');

			const submitBtn = DOM.append(inputRow, $('button.welcome-classic-input-submit'));
			submitBtn.setAttribute('aria-label', localize('workflowSubmitAriaLabel', "Generate workflow"));
			const chevron = DOM.append(submitBtn, $('span.welcome-classic-getting-started-chevron.codicon.codicon-arrow-up'));
			chevron.setAttribute('aria-hidden', 'true');

			const submit = () => {
				const value = this.inputBox?.value?.trim();
				this.callbacks.closeEditor();
				const query = value ? `/agent-customization ${value}` : '/agent-customization ';
				this.commandService.executeCommand('workbench.action.chat.open', { query, isPartialQuery: !value });
			};
			this._register(DOM.addDisposableListener(submitBtn, 'click', submit));
			this._register(DOM.addDisposableListener(this.inputBox.inputElement, 'keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					submit();
				}
			}));

			const description = DOM.append(gettingStarted, $('p.welcome-classic-getting-started-desc'));
			description.textContent = localize('gettingStartedDesc', "Describe your stack, conventions, and workflow to draft agents, skills, and instructions.");
		}

		this.cardsContainer = DOM.append(welcomeInner, $('.welcome-classic-cards'));
	}

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

			const card = DOM.append(this.cardsContainer, $('.welcome-classic-card'));
			card.setAttribute('tabindex', '0');
			card.setAttribute('role', 'button');

			const cardHeader = DOM.append(card, $('.welcome-classic-card-header'));
			const iconEl = DOM.append(cardHeader, $('.welcome-classic-card-icon'));
			iconEl.classList.add(...ThemeIcon.asClassNameArray(category.icon));
			const labelEl = DOM.append(cardHeader, $('span.welcome-classic-card-label'));
			labelEl.textContent = category.label;

			const descEl = DOM.append(card, $('p.welcome-classic-card-description'));
			descEl.textContent = category.description;

			const footer = DOM.append(card, $('.welcome-classic-card-footer'));
			if (category.promptType && this.welcomePageFeatures?.showGenerateActions !== false) {
				const generateBtn = DOM.append(footer, $('button.welcome-classic-card-generate'));
				generateBtn.textContent = localize('new', "New...");
				this.cardDisposables.add(DOM.addDisposableListener(generateBtn, 'click', e => {
					e.stopPropagation();
					this.callbacks.closeEditor();
					this.workspaceService.generateCustomization(category.promptType!);
				}));
			} else {
				const createBtn = DOM.append(footer, $('button.welcome-classic-card-generate'));
				createBtn.textContent = localize('browse', "Browse...");
				this.cardDisposables.add(DOM.addDisposableListener(createBtn, 'click', e => {
					e.stopPropagation();
					this.callbacks.selectSection(category.id);
				}));
			}

			this.cardDisposables.add(DOM.addDisposableListener(card, 'click', () => {
				this.callbacks.selectSection(category.id);
			}));
			this.cardDisposables.add(DOM.addDisposableListener(card, 'keydown', e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					this.callbacks.selectSection(category.id);
				}
			}));
		}
	}

	focus(): void {
		this.inputBox?.focus();
	}
}
