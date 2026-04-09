/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationWelcomePromptLaunchers.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { AICustomizationManagementSection } from './aiCustomizationManagement.js';
import { IWelcomePageFeatures } from '../../common/aiCustomizationWorkspaceService.js';
import type { IAICustomizationWelcomePageImplementation, IWelcomePageCallbacks } from './aiCustomizationWelcomePage.js';

const $ = DOM.$;

interface IPromptExample {
	readonly query: string;
	readonly ariaLabel: string;
}

interface ICategoryDescription {
	readonly id: AICustomizationManagementSection;
	readonly label: string;
	readonly description: string;
	readonly examples: readonly IPromptExample[];
}

export class PromptLaunchersAICustomizationWelcomePage extends Disposable implements IAICustomizationWelcomePageImplementation {

	private readonly cardDisposables = this._register(new DisposableStore());

	readonly container: HTMLElement;
	private groupsContainer: HTMLElement | undefined;
	private inputBox: InputBox | undefined;

	private readonly categoryDescriptions: ICategoryDescription[] = [
		{
			id: AICustomizationManagementSection.Agents,
			label: localize('agents', "Agents"),
			description: localize('agentsDesc', "Define custom agents with specialized personas, tool access, and instructions for specific tasks."),
			examples: [
				{ query: '/create-agent Create a reviewer agent that checks pull requests for risky changes, missing tests, and accessibility issues.', ariaLabel: localize('agentsExampleReviewAria', "Create a reviewer agent example") },
				{ query: '/create-agent Create a release agent that prepares changelogs, verifies docs, and summarizes ship blockers.', ariaLabel: localize('agentsExampleReleaseAria', "Create a release agent example") },
				{ query: '/create-agent ', ariaLabel: localize('agentsExampleWildcardAria', "Start with create agent command") },
			],
		},
		{
			id: AICustomizationManagementSection.Skills,
			label: localize('skills', "Skills"),
			description: localize('skillsDesc', "Create reusable skill files that provide domain-specific knowledge and workflows."),
			examples: [
				{ query: '/create-skill Create a skill for our TypeScript conventions, repo commands, and test patterns.', ariaLabel: localize('skillsExampleTypescriptAria', "Create a TypeScript conventions skill example") },
				{ query: '/create-skill Create a skill for triaging CI failures and gathering the right logs first.', ariaLabel: localize('skillsExampleCiAria', "Create a CI triage skill example") },
				{ query: '/create-skill ', ariaLabel: localize('skillsExampleWildcardAria', "Start with create skill command") },
			],
		},
		{
			id: AICustomizationManagementSection.Instructions,
			label: localize('instructions', "Instructions"),
			description: localize('instructionsDesc', "Set always-on instructions that guide AI behavior across your workspace or user profile."),
			examples: [
				{ query: '/create-instructions Create workspace instructions for coding style, testing expectations, and review checklist.', ariaLabel: localize('instructionsExampleWorkspaceAria', "Create workspace instructions example") },
				{ query: '/create-instructions Create user instructions that prefer concise diffs, reused helpers, and explicit error handling.', ariaLabel: localize('instructionsExampleUserAria', "Create user instructions example") },
				{ query: '/create-instructions ', ariaLabel: localize('instructionsExampleWildcardAria', "Start with create instructions command") },
			],
		},
		{
			id: AICustomizationManagementSection.Prompts,
			label: localize('prompts', "Prompts"),
			description: localize('promptsDesc', "Save reusable prompts you can run again for planning, analysis, and repeatable authoring tasks."),
			examples: [
				{ query: '/create-prompt Create a reusable prompt that drafts release notes from recent user-facing changes.', ariaLabel: localize('promptsExampleReleaseNotesAria', "Create a release notes prompt example") },
				{ query: '/create-prompt Create a reusable prompt that turns a bug report into repro steps, expected behavior, and likely owners.', ariaLabel: localize('promptsExampleBugAria', "Create a bug report prompt example") },
				{ query: '/create-prompt ', ariaLabel: localize('promptsExampleWildcardAria', "Start with create prompt command") },
			],
		},
		{
			id: AICustomizationManagementSection.Hooks,
			label: localize('hooks', "Hooks"),
			description: localize('hooksDesc', "Configure automated actions triggered by events like saving files or running tasks."),
			examples: [
				{ query: '/create-hook Create a hook that reminds the agent to run TypeScript compile checks before tests.', ariaLabel: localize('hooksExampleCompileAria', "Create a compile check hook example") },
				{ query: '/create-hook Create a hook that suggests updating tests and docs when exported behavior changes.', ariaLabel: localize('hooksExampleTestsAria', "Create a tests and docs hook example") },
				{ query: '/create-hook ', ariaLabel: localize('hooksExampleWildcardAria', "Start with create hook command") },
			],
		},
		{
			id: AICustomizationManagementSection.McpServers,
			label: localize('mcpServers', "MCP Servers"),
			description: localize('mcpServersDesc', "Connect external tool servers that extend AI capabilities with custom tools and data sources."),
			examples: [
				{ query: '/agent-customization Help me configure an MCP server that exposes our internal docs and scripts to agents.', ariaLabel: localize('mcpExampleDocsAria', "Configure an MCP server for internal docs example") },
				{ query: '/agent-customization Suggest an MCP server setup for local CLI tools, logs, and project search.', ariaLabel: localize('mcpExampleCliAria', "Configure an MCP server for local tools example") },
				{ query: '/agent-customization ', ariaLabel: localize('mcpExampleWildcardAria', "Start with agent customization command for MCP servers") },
			],
		},
		{
			id: AICustomizationManagementSection.Plugins,
			label: localize('plugins', "Plugins"),
			description: localize('pluginsDesc', "Install and manage agent plugins that add additional tools, skills, and integrations."),
			examples: [
				{ query: '/agent-customization Suggest agent plugins that add code review, planning, and diagnostics workflows.', ariaLabel: localize('pluginsExampleReviewAria', "Suggest agent plugins for review and planning example") },
				{ query: '/agent-customization Help me configure plugins for repository analysis and automation tasks.', ariaLabel: localize('pluginsExampleAutomationAria', "Configure plugins for automation example") },
				{ query: '/agent-customization ', ariaLabel: localize('pluginsExampleWildcardAria', "Start with agent customization command for plugins") },
			],
		},
	];

	constructor(
		parent: HTMLElement,
		private readonly welcomePageFeatures: IWelcomePageFeatures | undefined,
		private readonly callbacks: IWelcomePageCallbacks,
		private readonly commandService: ICommandService,
	) {
		super();

		this.container = DOM.append(parent, $('.welcome-prompts-content-container'));
		const welcomeInner = DOM.append(this.container, $('.welcome-prompts-inner'));

		const heading = DOM.append(welcomeInner, $('h2.welcome-prompts-heading'));
		heading.textContent = localize('welcomeHeading', "Agent Customizations");

		const subtitle = DOM.append(welcomeInner, $('p.welcome-prompts-subtitle'));
		subtitle.textContent = localize('welcomeSubtitle', "Tailor how your agents behave in each project. Create shared customizations for your team, or keep personal ones that follow you across workspaces.");

		const description = DOM.append(welcomeInner, $('p.welcome-prompts-description'));
		description.textContent = localize('welcomeDescription', "Start by describing your codebase to generate a setup with AI, or configure agents, skills, instructions, hooks, MCP servers, and plugins individually.");

		if (this.welcomePageFeatures?.showGettingStartedBanner !== false) {
			const inputRow = DOM.append(welcomeInner, $('.welcome-prompts-input-row'));

			this.inputBox = this._register(new InputBox(inputRow, undefined, {
				placeholder: localize('workflowInputPlaceholder', "Describe your project and coding patterns..."),
				ariaLabel: localize('workflowInputAriaLabel', "Describe your project to configure AI"),
				inputBoxStyles: {
					...defaultInputBoxStyles,
					inputBorder: 'transparent',
					inputBackground: 'transparent',
				},
			}));
			this.inputBox.element.classList.add('welcome-prompts-input');

			const submitBtn = DOM.append(inputRow, $('button.welcome-prompts-input-submit'));
			submitBtn.setAttribute('aria-label', localize('workflowSubmitAriaLabel', "Configure with AI"));
			DOM.append(submitBtn, $('span.codicon.codicon-arrow-right'));

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

			const inputHelper = DOM.append(welcomeInner, $('p.welcome-prompts-input-helper'));
			inputHelper.textContent = localize('workflowInputHelper', "Describe your stack, coding patterns, and team conventions to draft a starting setup for your agents.");
		}

		const divider = DOM.append(welcomeInner, $('.welcome-prompts-section-divider'));
		const dividerLabel = DOM.append(divider, $('span.welcome-prompts-section-divider-label'));
		dividerLabel.textContent = localize('orConfigureIndividually', "or configure individually");

		this.groupsContainer = DOM.append(welcomeInner, $('.welcome-prompts-groups'));
	}

	rebuildCards(visibleSectionIds: ReadonlySet<AICustomizationManagementSection>): void {
		if (!this.groupsContainer) {
			return;
		}

		this.cardDisposables.clear();
		DOM.clearNode(this.groupsContainer);

		for (const category of this.categoryDescriptions) {
			if (!visibleSectionIds.has(category.id)) {
				continue;
			}

			const group = DOM.append(this.groupsContainer, $('.welcome-prompts-group'));
			const label = DOM.append(group, $('h3.welcome-prompts-group-label'));
			label.textContent = category.label;

			const description = DOM.append(group, $('p.welcome-prompts-group-description'));
			description.textContent = category.description;

			const examples = DOM.append(group, $('.welcome-prompts-group-examples'));
			for (const example of category.examples) {
				const button = DOM.append(examples, $('button.welcome-prompts-example'));
				button.setAttribute('aria-label', example.ariaLabel);
				const content = DOM.append(button, $('span.welcome-prompts-example-content'));
				const [command, ...rest] = example.query.split(' ');
				const commandLabel = DOM.append(content, $('span.welcome-prompts-example-command'));
				commandLabel.textContent = command;
				const body = rest.join(' ').trim();
				if (body) {
					const bodyLabel = DOM.append(content, $('span.welcome-prompts-example-body'));
					bodyLabel.textContent = body;
				} else {
					button.classList.add('welcome-prompts-example-command-only');
				}
				this.cardDisposables.add(DOM.addDisposableListener(button, 'click', () => {
					this.callbacks.closeEditor();
					this.commandService.executeCommand('workbench.action.chat.open', {
						mode: 'agent',
						query: example.query,
						isPartialQuery: true,
					});
				}));
			}
		}
	}

	focus(): void {
		this.inputBox?.focus();
	}
}
