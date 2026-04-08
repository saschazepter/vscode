/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationWelcome.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { AICustomizationManagementSection } from './aiCustomizationManagement.js';
import { agentIcon, instructionsIcon, skillIcon, hookIcon, pluginIcon } from './aiCustomizationIcons.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { IWelcomePageFeatures } from '../../common/aiCustomizationWorkspaceService.js';

const $ = DOM.$;

interface ICategoryDescription {
	readonly id: AICustomizationManagementSection;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly description: string;
	readonly promptType?: PromptsType;
	/** Example prompts shown as chips that prepopulate chat. */
	readonly chips?: readonly { readonly label: string; readonly prompt: string }[];
}

export interface IWelcomePageCallbacks {
	selectSection(section: AICustomizationManagementSection): void;
	closeEditor(): void;
}

/**
 * Renders the welcome page for the Chat Customizations editor.
 *
 * Layout:
 *   "Analyze Your Project and Configure AI" header + description
 *   Input box (describe your project → opens /agent-customization in chat)
 *   2×3 grid of category cards with actionable chip examples
 */
export class AICustomizationWelcomePage extends Disposable {

	readonly container: HTMLElement;
	private inputBox: InputBox | undefined;
	private workflowSection: HTMLElement | undefined;

	private readonly categoryDescriptions: ICategoryDescription[] = [
		{
			id: AICustomizationManagementSection.Agents,
			label: localize('agents', "Agents"),
			icon: agentIcon,
			description: localize('agentsDesc', "Define custom agents with specialized personas, tool access, and instructions for specific tasks."),
			promptType: PromptsType.agent,
			chips: [
				{ label: localize('agentChip.review', "/create-agent code review specialist"), prompt: 'Create a code review agent that checks for best practices and security issues' },
				{ label: localize('agentChip.docs', "/create-agent documentation writer"), prompt: 'Create a documentation agent that writes and maintains project docs' },
			],
		},
		{
			id: AICustomizationManagementSection.Skills,
			label: localize('skills', "Skills"),
			icon: skillIcon,
			description: localize('skillsDesc', "Create reusable skill files that provide domain-specific knowledge and workflows."),
			promptType: PromptsType.skill,
			chips: [
				{ label: localize('skillChip.arch', "/create-skill architecture patterns"), prompt: 'Create a skill that documents our architecture patterns and conventions' },
				{ label: localize('skillChip.debug', "/create-skill debugging workflow"), prompt: 'Create a skill with step-by-step debugging workflows for common issues' },
			],
		},
		{
			id: AICustomizationManagementSection.Instructions,
			label: localize('instructions', "Instructions"),
			icon: instructionsIcon,
			description: localize('instructionsDesc', "Set always-on instructions that guide AI behavior across your workspace or user profile."),
			promptType: PromptsType.instructions,
			chips: [
				{ label: localize('instrChip.style', "/create-instructions coding style"), prompt: 'Create instructions that enforce our coding style and naming conventions' },
				{ label: localize('instrChip.security', "/create-instructions security guidelines"), prompt: 'Create instructions with security best practices for our stack' },
			],
		},
		{
			id: AICustomizationManagementSection.Hooks,
			label: localize('hooks', "Hooks"),
			icon: hookIcon,
			description: localize('hooksDesc', "Configure automated actions triggered by events like saving files or running tasks."),
			promptType: PromptsType.hook,
			chips: [
				{ label: localize('hookChip.commit', "/create-hook generate commit messages"), prompt: 'Create a hook that generates commit messages from staged changes' },
				{ label: localize('hookChip.lint', "/create-hook auto-fix lint on save"), prompt: 'Create a hook that automatically fixes lint errors when saving files' },
			],
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
	) {
		super();

		this.container = DOM.append(parent, $('.welcome-content-container'));
		const welcomeInner = DOM.append(this.container, $('.welcome-inner'));

		const intro = DOM.append(welcomeInner, $('.welcome-intro'));
		const introHeading = DOM.append(intro, $('h2.welcome-intro-heading'));
		introHeading.textContent = localize('welcomeIntroHeading', "Chat Customizations");
		const introDescription = DOM.append(intro, $('p.welcome-intro-description'));
		introDescription.textContent = localize('welcomeIntroDescription', "Tailor how AI agents work in your projects. Configure workspace customizations for the entire team, or create personal ones that follow you across projects.");

		// Input box (gated on welcomePageFeatures)
		if (this.welcomePageFeatures?.showGettingStartedBanner !== false) {
			this.workflowSection = DOM.append(welcomeInner, $('.welcome-workflow-section'));

			const workflowHeader = DOM.append(this.workflowSection, $('.welcome-workflow-header'));
			const workflowIcon = DOM.append(workflowHeader, $('span.welcome-workflow-icon.codicon.codicon-sparkle'));
			workflowIcon.setAttribute('aria-hidden', 'true');
			const workflowTitle = DOM.append(workflowHeader, $('span.welcome-workflow-title'));
			workflowTitle.textContent = localize('configureWorkflowTitle', "Analyze Your Project and Configure AI");

			const workflowDesc = DOM.append(this.workflowSection, $('p.welcome-workflow-desc'));
			workflowDesc.textContent = localize('configureWorkflowDesc', "Describe your project and coding patterns. Copilot can analyze your codebase, suggest the right AI customizations, and generate a starting point you can refine over time.");

			const workflowInputRow = DOM.append(this.workflowSection, $('.welcome-workflow-input-row'));

			this.inputBox = this._register(new InputBox(workflowInputRow, undefined, {
				placeholder: localize('workflowInputPlaceholder', "Describe your project, e.g. A TypeScript monorepo using React, Node, and PostgreSQL..."),
				ariaLabel: localize('workflowInputAriaLabel', "Describe your project and workflow"),
				inputBoxStyles: defaultInputBoxStyles,
			}));
			this.inputBox.element.classList.add('welcome-workflow-input');

			const submitBtn = DOM.append(workflowInputRow, $('button.welcome-workflow-submit'));
			submitBtn.setAttribute('aria-label', localize('workflowSubmitAriaLabel', "Configure with AI"));
			const submitIcon = DOM.append(submitBtn, $('span.codicon.codicon-arrow-right'));
			submitIcon.setAttribute('aria-hidden', 'true');

			const openChatWithPrompt = (prompt?: string) => {
				this.callbacks.closeEditor();
				const value = prompt ?? this.inputBox?.value?.trim();
				const query = value ? `/agent-customization ${value}` : '/agent-customization ';
				this.commandService.executeCommand('workbench.action.chat.open', { query, isPartialQuery: !value });
			};

			this._register(DOM.addDisposableListener(submitBtn, 'click', () => openChatWithPrompt()));
			this.inputBox.onDidChange(() => {
				submitBtn.classList.toggle('has-value', !!this.inputBox?.value?.trim());
			});
			this._register(DOM.addDisposableListener(this.inputBox.inputElement, 'keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					openChatWithPrompt();
				}
			}));

			// Centered separator with text
			const divider = DOM.append(this.workflowSection, $('.welcome-section-divider'));
			const dividerLabel = DOM.append(divider, $('span.welcome-section-divider-label'));
			dividerLabel.textContent = localize('orConfigureIndividually', "or configure individually");

			// Full-width category list
			const list = DOM.append(this.workflowSection, $('.welcome-category-list'));
			for (const category of this.categoryDescriptions) {
				const row = DOM.append(list, $('.welcome-category-item'));
				row.setAttribute('tabindex', '0');
				row.setAttribute('role', 'button');

				const content = DOM.append(row, $('.welcome-category-item-content'));
				const titleRow = DOM.append(content, $('.welcome-category-item-title-row'));
				const iconEl = DOM.append(titleRow, $('span.welcome-category-item-icon'));
				iconEl.classList.add(...ThemeIcon.asClassNameArray(category.icon));
				const labelEl = DOM.append(titleRow, $('span.welcome-category-item-label'));
				labelEl.textContent = category.label;
				const descEl = DOM.append(content, $('p.welcome-category-item-desc'));
				descEl.textContent = category.description;

				if (category.chips) {
					const chipsArea = DOM.append(content, $('div.welcome-category-item-commands'));
					for (const chip of category.chips) {
						const chipBtn = DOM.append(chipsArea, $('button.welcome-category-command'));
						chipBtn.textContent = chip.label;
						const prompt = chip.prompt;
						this._register(DOM.addDisposableListener(chipBtn, 'click', (e) => {
							e.stopPropagation();
							openChatWithPrompt(prompt);
						}));
					}
				}

				this._register(DOM.addDisposableListener(row, 'click', () => {
					this.callbacks.selectSection(category.id);
				}));
				this._register(DOM.addDisposableListener(row, 'keydown', (e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						this.callbacks.selectSection(category.id);
					}
				}));
			}
		}
	}

	/**
	 * No-op — the grid is rendered from `categoryDescriptions` in the constructor.
	 * Kept for API compatibility with the editor.
	 */
	rebuildCards(_visibleSectionIds: ReadonlySet<AICustomizationManagementSection>): void {
		// Cards are static — no rebuild needed
	}

	/**
	 * Focuses the input box when the welcome page receives focus.
	 */
	focus(): void {
		if (this.inputBox) {
			this.inputBox.focus();
		} else {
			this.workflowSection?.focus();
		}
	}
}
