/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/aiCustomizationWelcomePromptLaunchers.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { AICustomizationManagementSection } from './aiCustomizationManagement.js';
import { agentIcon, hookIcon, instructionsIcon, mcpServerIcon, pluginIcon, promptIcon, skillIcon } from './aiCustomizationIcons.js';
import { IWelcomePageFeatures } from '../../common/aiCustomizationWorkspaceService.js';
import type { IAICustomizationWelcomePageImplementation, IWelcomePageCallbacks } from './aiCustomizationWelcomePage.js';

const $ = DOM.$;

interface IPromptExample {
	readonly query: string;
	readonly label: string;
	readonly isWildcard?: boolean;
	readonly ariaLabel: string;
}

interface ICategoryDescription {
	readonly id: AICustomizationManagementSection;
	readonly label: string;
	readonly icon: ThemeIcon;
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
			icon: agentIcon,
			description: localize('agentsDesc', "Create specialized agents with focused roles, tools, and instructions."),
			examples: [
				{ query: '/create-agent Create a reviewer agent for risky changes, missing tests, and accessibility issues.', label: localize('agentsExampleReviewLabel', "Reviewer for risky changes"), ariaLabel: localize('agentsExampleReviewAria', "Create a reviewer agent example") },
				{ query: '/create-agent Create a release agent for changelogs, docs, and ship blockers.', label: localize('agentsExampleReleaseLabel', "Release coordinator for ship prep"), ariaLabel: localize('agentsExampleReleaseAria', "Create a release agent example") },
				{ query: '/create-agent ', label: localize('agentsExampleWildcardLabel', "/create-agent"), isWildcard: true, ariaLabel: localize('agentsExampleWildcardAria', "Start with create agent command") },
			],
		},
		{
			id: AICustomizationManagementSection.Skills,
			label: localize('skills', "Skills"),
			icon: skillIcon,
			description: localize('skillsDesc', "Save reusable knowledge and workflows you can invoke across projects."),
			examples: [
				{ query: '/create-skill Create a skill for our TypeScript conventions, repo commands, and test patterns.', label: localize('skillsExampleTypescriptLabel', "Team TypeScript playbook"), ariaLabel: localize('skillsExampleTypescriptAria', "Create a TypeScript conventions skill example") },
				{ query: '/create-skill Create a skill for triaging CI failures and gathering the right logs first.', label: localize('skillsExampleCiLabel', "CI triage workflow"), ariaLabel: localize('skillsExampleCiAria', "Create a CI triage skill example") },
				{ query: '/create-skill ', label: localize('skillsExampleWildcardLabel', "/create-skill"), isWildcard: true, ariaLabel: localize('skillsExampleWildcardAria', "Start with create skill command") },
			],
		},
		{
			id: AICustomizationManagementSection.Instructions,
			label: localize('instructions', "Instructions"),
			icon: instructionsIcon,
			description: localize('instructionsDesc', "Set always-on guidance for your workspace or personal profile."),
			examples: [
				{ query: '/create-instructions Create workspace instructions for coding style, testing expectations, and review checklists.', label: localize('instructionsExampleWorkspaceLabel', "Workspace coding rules"), ariaLabel: localize('instructionsExampleWorkspaceAria', "Create workspace instructions example") },
				{ query: '/create-instructions Create user instructions that prefer concise diffs, reused helpers, and explicit errors.', label: localize('instructionsExampleUserLabel', "Personal editing preferences"), ariaLabel: localize('instructionsExampleUserAria', "Create user instructions example") },
				{ query: '/create-instructions ', label: localize('instructionsExampleWildcardLabel', "/create-instructions"), isWildcard: true, ariaLabel: localize('instructionsExampleWildcardAria', "Start with create instructions command") },
			],
		},
		{
			id: AICustomizationManagementSection.Prompts,
			label: localize('prompts', "Prompts"),
			icon: promptIcon,
			description: localize('promptsDesc', "Save reusable prompt starters for planning, analysis, and authoring."),
			examples: [
				{ query: '/create-prompt Create a reusable prompt that drafts release notes from recent user-facing changes.', label: localize('promptsExampleReleaseNotesLabel', "Reusable release-notes prompt"), ariaLabel: localize('promptsExampleReleaseNotesAria', "Create a release notes prompt example") },
				{ query: '/create-prompt Create a reusable prompt that turns a bug report into repro steps, expected behavior, and likely owners.', label: localize('promptsExampleBugLabel', "Bug report to investigation brief"), ariaLabel: localize('promptsExampleBugAria', "Create a bug report prompt example") },
				{ query: '/create-prompt ', label: localize('promptsExampleWildcardLabel', "/create-prompt"), isWildcard: true, ariaLabel: localize('promptsExampleWildcardAria', "Start with create prompt command") },
			],
		},
		{
			id: AICustomizationManagementSection.Hooks,
			label: localize('hooks', "Hooks"),
			icon: hookIcon,
			description: localize('hooksDesc', "Add automated actions that run when files or tasks change."),
			examples: [
				{ query: '/create-hook Create a hook that reminds the agent to run TypeScript compile checks before tests.', label: localize('hooksExampleCompileLabel', "Before-test compile reminder"), ariaLabel: localize('hooksExampleCompileAria', "Create a compile check hook example") },
				{ query: '/create-hook Create a hook that suggests updating tests and docs when exported behavior changes.', label: localize('hooksExampleTestsLabel', "Code-change follow-up automation"), ariaLabel: localize('hooksExampleTestsAria', "Create a tests and docs hook example") },
				{ query: '/create-hook ', label: localize('hooksExampleWildcardLabel', "/create-hook"), isWildcard: true, ariaLabel: localize('hooksExampleWildcardAria', "Start with create hook command") },
			],
		},
		{
			id: AICustomizationManagementSection.McpServers,
			label: localize('mcpServers', "MCP Servers"),
			icon: mcpServerIcon,
			description: localize('mcpServersDesc', "Connect tool servers that give agents access to extra tools and data."),
			examples: [
				{ query: '/agent-customization Help me configure an MCP server for internal docs and scripts.', label: localize('mcpExampleDocsLabel', "Internal docs tool server"), ariaLabel: localize('mcpExampleDocsAria', "Configure an MCP server for internal docs example") },
				{ query: '/agent-customization Suggest an MCP server setup for local CLI tools, logs, and search.', label: localize('mcpExampleCliLabel', "Local tools and logs server"), ariaLabel: localize('mcpExampleCliAria', "Configure an MCP server for local tools example") },
				{ query: '/agent-customization ', label: localize('mcpExampleWildcardLabel', "/agent-customization"), isWildcard: true, ariaLabel: localize('mcpExampleWildcardAria', "Start with agent customization command for MCP servers") },
			],
		},
		{
			id: AICustomizationManagementSection.Plugins,
			label: localize('plugins', "Plugins"),
			icon: pluginIcon,
			description: localize('pluginsDesc', "Install plugins that add tools, skills, and integrations."),
			examples: [
				{ query: '/agent-customization Suggest plugins for code review, planning, and diagnostics workflows.', label: localize('pluginsExampleReviewLabel', "Review and planning add-ons"), ariaLabel: localize('pluginsExampleReviewAria', "Suggest agent plugins for review and planning example") },
				{ query: '/agent-customization Help me configure plugins for repository analysis and automation.', label: localize('pluginsExampleAutomationLabel', "Repo automation add-ons"), ariaLabel: localize('pluginsExampleAutomationAria', "Configure plugins for automation example") },
				{ query: '/agent-customization ', label: localize('pluginsExampleWildcardLabel', "/agent-customization"), isWildcard: true, ariaLabel: localize('pluginsExampleWildcardAria', "Start with agent customization command for plugins") },
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
		subtitle.textContent = localize('welcomeSubtitle', "Tailor how your agents behave in each project. Describe your codebase to generate a workflow with AI, or start from a focused customization below.");

		if (this.welcomePageFeatures?.showGettingStartedBanner !== false) {
			const primarySection = DOM.append(welcomeInner, $('.welcome-prompts-primary'));
			const primaryLabel = DOM.append(primarySection, $('.welcome-prompts-section-label'));
			const primaryIcon = DOM.append(primaryLabel, $('span.welcome-prompts-section-label-icon.codicon.codicon-sparkle'));
			primaryIcon.setAttribute('aria-hidden', 'true');
			const primaryLabelText = DOM.append(primaryLabel, $('span'));
			primaryLabelText.textContent = localize('generateSetupLabel', "Generate Workflow");

			const inputRow = DOM.append(primarySection, $('.welcome-prompts-input-row'));

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

			const inputHelper = DOM.append(primarySection, $('p.welcome-prompts-input-helper'));
			inputHelper.textContent = localize('workflowInputHelper', "Describe your stack, conventions, and workflow to draft agents, skills, and instructions.");
		}

		const separator = DOM.append(welcomeInner, $('.welcome-prompts-separator'));
		DOM.append(separator, $('span.welcome-prompts-separator-line'));
		const separatorLabel = DOM.append(separator, $('span.welcome-prompts-separator-label'));
		separatorLabel.textContent = localize('individualSetupSeparatorLabel', "Or configure individually");
		DOM.append(separator, $('span.welcome-prompts-separator-line'));

		const secondarySection = DOM.append(welcomeInner, $('.welcome-prompts-secondary'));
		this.groupsContainer = DOM.append(secondarySection, $('.welcome-prompts-groups'));
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
			const header = DOM.append(group, $('.welcome-prompts-group-header'));
			const icon = DOM.append(header, $('span.welcome-prompts-group-icon'));
			icon.classList.add(...ThemeIcon.asClassNameArray(category.icon));
			icon.setAttribute('aria-hidden', 'true');
			const label = DOM.append(header, $('h3.welcome-prompts-group-label'));
			label.textContent = category.label;

			const description = DOM.append(group, $('p.welcome-prompts-group-description'));
			description.textContent = category.description;

			const examples = DOM.append(group, $('.welcome-prompts-group-examples'));
			for (const example of category.examples) {
				const button = DOM.append(examples, $('button.welcome-prompts-example'));
				button.setAttribute('aria-label', example.ariaLabel);
				if (example.isWildcard) {
					button.classList.add('welcome-prompts-example-wildcard');
				}
				const content = DOM.append(button, $('span.welcome-prompts-example-content'));
				const bodyLabel = DOM.append(content, $('span.welcome-prompts-example-body'));
				bodyLabel.textContent = example.label;
				const chevron = DOM.append(button, $('span.welcome-prompts-example-chevron.codicon.codicon-arrow-right'));
				chevron.setAttribute('aria-hidden', 'true');
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
