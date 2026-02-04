/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { AgentSessionProviders, getAgentSessionProvider, getAgentSessionProviderDescription, getAgentSessionProviderIcon, getAgentSessionProviderName, isFirstPartyAgentSessionProvider } from '../agentSessions/agentSessions.js';
import { ChatModeKind } from '../../common/constants.js';
import { IChatSessionsExtensionPoint, IChatSessionsService } from '../../common/chatSessionsService.js';
import { Codicon } from '../../../../../base/common/codicons.js';

/**
 * Quick-start type identifier. Can be a built-in type or an extension-contributed type.
 */
export type QuickStartType = string;

/**
 * Configuration for what pickers a provider needs.
 */
export interface IProviderPickerConfig {
	readonly showModelPicker?: boolean;
	readonly showRepoPicker?: boolean;
	readonly showBranchPicker?: boolean;
}

export interface IQuickStartOption {
	readonly type: QuickStartType;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly sessionProvider: AgentSessionProviders;
	readonly modeKind: ChatModeKind;
	readonly lockMode: boolean;
	/** Description of what this provider does */
	readonly description: string;
	/** Configuration for which pickers to show */
	readonly pickerConfig: IProviderPickerConfig;
	/** Whether this option was contributed by an extension */
	readonly isExtensionContributed?: boolean;
	/** Sort order for display (lower numbers first) */
	readonly order?: number;
	/**
	 * Intent patterns for smart matching.
	 * These help match user input to the right mode based on intent rather than exact text.
	 */
	readonly intentPatterns?: IIntentPattern[];
}

/**
 * Represents a pattern that indicates user intent for a particular mode.
 */
export interface IIntentPattern {
	/**
	 * Keywords or phrases that suggest this intent.
	 * Can be simple strings or regex patterns.
	 */
	readonly keywords: readonly string[];
	/**
	 * Weight of this pattern (higher = stronger match). Default is 1.
	 */
	readonly weight?: number;
	/**
	 * If true, the entire input must match the pattern style (e.g., ends with '?').
	 */
	readonly inputStyle?: 'question' | 'command' | 'any';
}


/**
 * Returns the user-friendly display name for an agent session provider.
 * These names are shown in UI buttons and should match across the welcome view and delegation widgets.
 */
export function getAgentSessionProviderDisplayName(provider: AgentSessionProviders): string {
	switch (provider) {
		case AgentSessionProviders.Local:
			return localize('chat.session.providerDisplayName.local', "Explore");
		case AgentSessionProviders.Background:
			return localize('chat.session.providerDisplayName.background', "Code");
		case AgentSessionProviders.Cloud:
			return localize('chat.session.providerDisplayName.cloud', "Cloud");
		case AgentSessionProviders.Claude:
			return 'Claude';
		case AgentSessionProviders.Codex:
			return 'Codex';
	}
}


/**
 * Returns the user-friendly display icon for an agent session provider.
 * These icons are shown in UI buttons and should match across the welcome view and delegation widgets.
 */
export function getAgentSessionProviderDisplayIcon(provider: AgentSessionProviders): ThemeIcon {
	switch (provider) {
		case AgentSessionProviders.Local:
			return Codicon.question; // Explore mode icon
		case AgentSessionProviders.Background:
			return Codicon.remote; // Code/Execute mode icon
		case AgentSessionProviders.Cloud:
			return Codicon.cloud; // Delegate/Cloud mode icon
		case AgentSessionProviders.Claude:
			return Codicon.claude;
		case AgentSessionProviders.Codex:
			return Codicon.openai;
	}
}

/**
 * Returns whether the user should be able to select a model for this provider.
 * Cloud-based and third-party agents typically manage their own model selection.
 */
export function getAgentSessionProviderShowsModelPicker(provider: AgentSessionProviders): boolean {
	switch (provider) {
		case AgentSessionProviders.Local:
			return true; // Explore mode - user picks the model
		case AgentSessionProviders.Background:
		case AgentSessionProviders.Cloud:
		case AgentSessionProviders.Claude:
		case AgentSessionProviders.Codex:
			return false; // These agents manage their own model selection
	}
}

/**
 * Built-in first-party quick-start options with descriptions and intent patterns.
 */
export const QuickStartOptions: IQuickStartOption[] = [
	{
		type: 'explore',
		label: getAgentSessionProviderDisplayName(AgentSessionProviders.Local),
		icon: getAgentSessionProviderDisplayIcon(AgentSessionProviders.Local),
		sessionProvider: AgentSessionProviders.Local,
		modeKind: ChatModeKind.Ask,
		lockMode: true,
		description: localize('quickStart.explore.description', "Explore and understand your code."),
		pickerConfig: {
			showModelPicker: getAgentSessionProviderShowsModelPicker(AgentSessionProviders.Local),
			showRepoPicker: false,
			showBranchPicker: false,
		},
		order: 0,
		intentPatterns: [
			// Questions are strongly associated with Explore
			{ keywords: ['what', 'how', 'why', 'where', 'when', 'which', 'who'], weight: 2, inputStyle: 'question' },
			{ keywords: ['?'], weight: 3 }, // Question mark is a strong signal
			// Understanding/learning intent
			{ keywords: ['explain', 'understand', 'tell me', 'describe', 'help me understand', 'what does', 'what is'], weight: 2 },
			// Code exploration
			{ keywords: ['find', 'search', 'look for', 'locate', 'show me', 'where is'], weight: 1.5 },
			// Context and information gathering
			{ keywords: ['context', 'information', 'about', 'overview', 'summary', 'documentation'], weight: 1 },
			// Simple mode keywords
			{ keywords: ['explore', 'ask', 'question', 'chat'], weight: 1 },
		],
	},
	{
		type: 'background',
		label: getAgentSessionProviderDisplayName(AgentSessionProviders.Background),
		icon: getAgentSessionProviderDisplayIcon(AgentSessionProviders.Background),
		sessionProvider: AgentSessionProviders.Background,
		modeKind: ChatModeKind.Agent,
		lockMode: true,
		description: localize('quickStart.background.description', "Delegate tasks to a background agent running locally in a worktree on your machine."),
		pickerConfig: {
			showModelPicker: getAgentSessionProviderShowsModelPicker(AgentSessionProviders.Background),
			showRepoPicker: true,
			showBranchPicker: false,
		},
		order: 1,
		intentPatterns: [
			// Local/worktree specific
			{ keywords: ['worktree', 'local', 'locally', 'on my machine', 'offline', 'my computer'], weight: 3 },
			{ keywords: ['background', 'in the background', 'while i work'], weight: 2 },
			// Task delegation with local hints
			{ keywords: ['run locally', 'execute locally', 'local agent'], weight: 2.5 },
			// General agent/task patterns (lower weight - could be either background or cloud)
			{ keywords: ['agent', 'delegate', 'task', 'do this', 'make', 'create', 'build', 'implement', 'fix', 'refactor', 'write'], weight: 1 },
			{ keywords: ['run tests', 'test', 'debug'], weight: 1.5 },
		],
	},
	{
		type: 'cloud',
		label: getAgentSessionProviderDisplayName(AgentSessionProviders.Cloud),
		icon: getAgentSessionProviderDisplayIcon(AgentSessionProviders.Cloud),
		sessionProvider: AgentSessionProviders.Cloud,
		modeKind: ChatModeKind.Agent,
		lockMode: true,
		description: localize('quickStart.cloud.description', "Delegate tasks to a GitHub cloud agent."),
		pickerConfig: {
			showModelPicker: getAgentSessionProviderShowsModelPicker(AgentSessionProviders.Cloud),
			showRepoPicker: true,
			showBranchPicker: true,
		},
		order: 2,
		intentPatterns: [
			// Cloud/remote specific
			{ keywords: ['cloud', 'github', 'remote', 'server', 'codespace', 'online'], weight: 3 },
			{ keywords: ['send to', 'send an agent', 'remote agent', 'cloud agent'], weight: 2.5 },
			// PR/collaboration workflows often use cloud
			{ keywords: ['pull request', 'pr', 'merge', 'branch', 'commit'], weight: 2 },
			// General agent/task patterns (lower weight - could be either background or cloud)
			{ keywords: ['agent', 'delegate', 'task', 'do this', 'make', 'create', 'build', 'implement', 'fix', 'refactor', 'write'], weight: 1 },
		],
	},
];

export interface IQuickStartDelegate {
	/**
	 * Called when a quick-start option is selected.
	 */
	onQuickStartSelected(option: IQuickStartOption): void;

	/**
	 * Returns the currently selected quick-start type, if any.
	 */
	getSelectedQuickStart(): QuickStartType | undefined;
}

/**
 * Converts extension-contributed session types to quick-start options.
 */
export function contributionToQuickStartOption(contribution: IChatSessionsExtensionPoint): IQuickStartOption | undefined {
	const agentProvider = getAgentSessionProvider(contribution.type);
	if (!agentProvider) {
		return undefined;
	}

	// Parse icon from contribution or fall back to provider default
	let icon: ThemeIcon;
	if (typeof contribution.icon === 'string' && contribution.icon.startsWith('$(')) {
		const iconId = contribution.icon.slice(2, -1);
		icon = { id: iconId };
	} else {
		icon = getAgentSessionProviderIcon(agentProvider);
	}

	return {
		type: contribution.type,
		label: contribution.displayName || getAgentSessionProviderName(agentProvider),
		icon,
		sessionProvider: agentProvider,
		modeKind: ChatModeKind.Agent,
		lockMode: true,
		description: contribution.description || getAgentSessionProviderDescription(agentProvider),
		pickerConfig: {
			showModelPicker: getAgentSessionProviderShowsModelPicker(agentProvider),
			showRepoPicker: contribution.canDelegate ?? false,
			showBranchPicker: false,
		},
		isExtensionContributed: !isFirstPartyAgentSessionProvider(agentProvider),
		order: contribution.order ?? (isFirstPartyAgentSessionProvider(agentProvider) ? 10 : 100),
	};
}

/**
 * A component that renders quick-start action buttons for the welcome view.
 * Supports built-in options (Explore, Background, Cloud) and extension-contributed providers.
 * Can operate in expanded mode (all buttons visible) or collapsed mode (only selected icon).
 */
export class ChatQuickStartPart extends Disposable {

	public readonly element: HTMLElement;

	private readonly _onDidSelectOption = this._register(new Emitter<IQuickStartOption>());
	public readonly onDidSelectOption: Event<IQuickStartOption> = this._onDidSelectOption.event;

	private readonly _onDidRequestExpand = this._register(new Emitter<void>());
	public readonly onDidRequestExpand: Event<void> = this._onDidRequestExpand.event;

	private readonly buttons: Map<QuickStartType, HTMLElement> = new Map();
	private _selectedType: QuickStartType | undefined;
	private _options: IQuickStartOption[] = [];
	private _isCollapsed: boolean = false;
	private _currentFilterText: string = '';
	private _matchingTypes: Set<QuickStartType> = new Set();
	private readonly buttonDisposables = this._register(new DisposableStore());

	// Collapsed mode elements
	private collapsedContainer: HTMLElement | undefined;
	private expandedContainer: HTMLElement | undefined;

	constructor(
		private readonly delegate: IQuickStartDelegate,
		chatSessionsService?: IChatSessionsService,
	) {
		super();

		this.element = $('.chat-full-welcome-quickStart');
		this._selectedType = delegate.getSelectedQuickStart();
		this.rebuildOptions();

		// Listen for contribution changes
		if (chatSessionsService) {
			this._register(chatSessionsService.onDidChangeAvailability(() => {
				this.rebuildOptions();
			}));
		}
	}

	/**
	 * Rebuilds the options array from built-in options and extension contributions.
	 */
	private rebuildOptions(): void {
		const options: IQuickStartOption[] = [...QuickStartOptions];

		// Should we add extension contributed options?
		// if (this.chatSessionsService) {
		// 	const contributions = this.chatSessionsService.getAllChatSessionContributions();
		// 	for (const contribution of contributions) {
		// 		// Skip if already covered by built-in options
		// 		const existingBuiltIn = QuickStartOptions.find(o =>
		// 			o.sessionProvider === contribution.type || o.type === contribution.type
		// 		);
		// 		if (existingBuiltIn) {
		// 			continue;
		// 		}

		// 		const option = contributionToQuickStartOption(contribution);
		// 		if (option) {
		// 			options.push(option);
		// 		}
		// 	}
		// }

		// Sort by order, then by label
		options.sort((a, b) => {
			const orderDiff = (a.order ?? 100) - (b.order ?? 100);
			if (orderDiff !== 0) {
				return orderDiff;
			}
			return a.label.localeCompare(b.label);
		});

		this._options = options;
		this.buildButtons();
	}

	private buildButtons(): void {
		this.buttonDisposables.clear();
		this.buttons.clear();
		clearNode(this.element);

		// Create collapsed container (shows only selected icon when collapsed)
		this.collapsedContainer = append(this.element, $('.chat-full-welcome-quickStart-collapsed'));
		this.collapsedContainer.style.display = 'none';

		// Create expanded container (shows all buttons)
		this.expandedContainer = append(this.element, $('.chat-full-welcome-quickStart-expanded'));

		for (const option of this._options) {
			const button = append(this.expandedContainer, $('button.chat-full-welcome-quickStart-button'));
			button.setAttribute('type', 'button');
			button.setAttribute('aria-label', option.label);

			if (option.isExtensionContributed) {
				button.classList.add('extension-contributed');
			}

			const iconElement = append(button, $('.chat-full-welcome-quickStart-icon'));
			iconElement.appendChild(renderIcon(option.icon));

			append(button, $('span.chat-full-welcome-quickStart-label', {}, option.label));

			// Update selected state
			if (this._selectedType === option.type) {
				button.classList.add('selected');
			}

			this.buttonDisposables.add({
				dispose: () => {
					button.onclick = null;
				}
			});

			button.onclick = () => {
				this.selectOption(option);
			};

			this.buttons.set(option.type, button);
		}

		// Update collapsed view if we have a selection
		this.updateCollapsedView();
	}

	private selectOption(option: IQuickStartOption): void {
		// Update visual selection
		for (const [type, btn] of this.buttons) {
			btn.classList.toggle('selected', type === option.type);
		}

		this._selectedType = option.type;
		this.updateCollapsedView();
		this.delegate.onQuickStartSelected(option);
		this._onDidSelectOption.fire(option);
	}

	/**
	 * Gets the currently selected quick-start type.
	 */
	public getSelectedType(): QuickStartType | undefined {
		return this._selectedType;
	}

	/**
	 * Programmatically selects a quick-start option.
	 */
	public setSelectedType(type: QuickStartType | undefined): void {
		if (type === this._selectedType) {
			return;
		}

		// Clear selection if undefined
		if (type === undefined) {
			for (const btn of this.buttons.values()) {
				btn.classList.remove('selected');
			}
			this._selectedType = undefined;
			this.updateCollapsedView();
			return;
		}

		// Find and select the option
		const option = this._options.find(o => o.type === type);
		if (option) {
			this.selectOption(option);
		}
	}

	/**
	 * Gets all available quick-start options.
	 */
	public getOptions(): readonly IQuickStartOption[] {
		return this._options;
	}

	/**
	 * Finds an option by type.
	 */
	public getOption(type: QuickStartType): IQuickStartOption | undefined {
		return this._options.find(o => o.type === type);
	}

	/**
	 * Gets the button element for a given option type.
	 */
	public getButtonElement(type: QuickStartType): HTMLElement | undefined {
		return this.buttons.get(type);
	}

	/**
	 * Sets the collapsed state of the quick-start buttons.
	 * In collapsed mode, only the selected icon is shown.
	 */
	public setCollapsed(collapsed: boolean): void {
		if (this._isCollapsed === collapsed) {
			return;
		}

		this._isCollapsed = collapsed;
		this.element.classList.toggle('collapsed', collapsed);

		if (this.collapsedContainer && this.expandedContainer) {
			if (collapsed && this._selectedType) {
				this.collapsedContainer.style.display = 'flex';
				this.expandedContainer.style.display = 'none';
			} else {
				this.collapsedContainer.style.display = 'none';
				this.expandedContainer.style.display = 'flex';
			}
		}
	}

	/**
	 * Gets the collapsed state.
	 */
	public isCollapsed(): boolean {
		return this._isCollapsed;
	}

	/**
	 * Result of intent-based matching for a quick-start option.
	 */
	private _intentScores: Map<QuickStartType, number> = new Map();

	/**
	 * Filters quick-start options by search text using intent-based matching.
	 * Uses semantic patterns to understand user intent rather than just text matching.
	 * Returns the matching options sorted by relevance.
	 * @param text The search text to filter by
	 */
	public filterByText(text: string): IQuickStartOption[] {
		this._currentFilterText = text;
		const normalizedText = text.toLowerCase().trim();

		// Find matching options
		if (normalizedText.length === 0) {
			// No filter - all options match with equal score
			this._matchingTypes = new Set(this._options.map(o => o.type));
			this._intentScores.clear();
		} else {
			// Calculate intent scores for each option
			this._intentScores = this.calculateIntentScores(normalizedText);

			// Options with score > 0 are matches
			this._matchingTypes = new Set(
				Array.from(this._intentScores.entries())
					.filter(([_, score]) => score > 0)
					.map(([type, _]) => type)
			);

			// If no intent matches, fall back to simple text matching
			if (this._matchingTypes.size === 0) {
				this._matchingTypes = new Set(
					this._options
						.filter(option =>
							option.label.toLowerCase().includes(normalizedText) ||
							option.description.toLowerCase().includes(normalizedText) ||
							option.type.toLowerCase().includes(normalizedText)
						)
						.map(o => o.type)
				);
			}
		}

		// Update button visual states
		this.updateFilteredState();

		// Return matching options sorted by score (highest first)
		return this._options
			.filter(o => this._matchingTypes.has(o.type))
			.sort((a, b) => (this._intentScores.get(b.type) ?? 0) - (this._intentScores.get(a.type) ?? 0));
	}

	/**
	 * Calculates intent scores for all options based on the input text.
	 */
	private calculateIntentScores(input: string): Map<QuickStartType, number> {
		const scores = new Map<QuickStartType, number>();
		const isQuestion = input.includes('?') || /^(what|how|why|where|when|which|who|can you|could you|would you|is there|are there)\b/i.test(input);
		const isCommand = /^(do|make|create|build|fix|implement|refactor|write|run|test|deploy|send)\b/i.test(input);

		for (const option of this._options) {
			let totalScore = 0;

			// Check intent patterns if defined
			if (option.intentPatterns) {
				for (const pattern of option.intentPatterns) {
					// Check input style requirement
					if (pattern.inputStyle === 'question' && !isQuestion) {
						continue;
					}
					if (pattern.inputStyle === 'command' && !isCommand) {
						continue;
					}

					// Check keywords
					const weight = pattern.weight ?? 1;
					for (const keyword of pattern.keywords) {
						const keywordLower = keyword.toLowerCase();
						if (input.includes(keywordLower)) {
							// Bonus for exact word match vs substring
							const wordBoundaryMatch = new RegExp(`\\b${this.escapeRegex(keywordLower)}\\b`, 'i').test(input);
							totalScore += wordBoundaryMatch ? weight * 1.5 : weight;
						}
					}
				}
			}

			// Also check basic label/type matching as a fallback
			if (input.includes(option.type.toLowerCase())) {
				totalScore += 2;
			}
			if (input.includes(option.label.toLowerCase())) {
				totalScore += 1.5;
			}

			if (totalScore > 0) {
				scores.set(option.type, totalScore);
			}
		}

		return scores;
	}

	/**
	 * Escapes special regex characters in a string.
	 */
	private escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	/**
	 * Gets the intent score for a specific option type.
	 * Returns 0 if not scored or not matching.
	 */
	public getIntentScore(type: QuickStartType): number {
		return this._intentScores.get(type) ?? 0;
	}

	/**
	 * Gets the best matching option (highest intent score).
	 * Returns undefined if no options match.
	 */
	public getBestMatch(): IQuickStartOption | undefined {
		if (this._matchingTypes.size === 0) {
			return undefined;
		}

		let bestOption: IQuickStartOption | undefined;
		let bestScore = -1;

		for (const option of this._options) {
			if (this._matchingTypes.has(option.type)) {
				const score = this._intentScores.get(option.type) ?? 0;
				if (score > bestScore) {
					bestScore = score;
					bestOption = option;
				}
			}
		}

		return bestOption;
	}

	/**
	 * Clears any active filter, restoring all options to visible state.
	 */
	public clearFilter(): void {
		this._currentFilterText = '';
		this._matchingTypes = new Set(this._options.map(o => o.type));
		this.updateFilteredState();
	}

	/**
	 * Gets the current filter text.
	 */
	public getFilterText(): string {
		return this._currentFilterText;
	}

	/**
	 * Gets the currently matching option types.
	 */
	public getMatchingTypes(): Set<QuickStartType> {
		return this._matchingTypes;
	}

	/**
	 * Updates the visual state of buttons based on current filter.
	 * Never dims buttons - only highlights the best match when confident.
	 */
	private updateFilteredState(): void {
		const hasFilter = this._currentFilterText.trim().length > 0;
		const bestMatch = hasFilter ? this.getBestMatch() : undefined;

		for (const [type, button] of this.buttons) {
			const isMatching = this._matchingTypes.has(type);
			const isBestMatch = bestMatch?.type === type;

			// Never dim buttons - just highlight matches
			button.classList.remove('dimmed');
			button.classList.toggle('matching', hasFilter && isMatching);
			button.classList.toggle('best-match', hasFilter && isBestMatch);
		}

		// Toggle filtering class on container
		this.element.classList.toggle('filtering', hasFilter);
	}

	/**
	 * Updates the collapsed view to show the selected option's icon.
	 */
	private updateCollapsedView(): void {
		if (!this.collapsedContainer) {
			return;
		}

		clearNode(this.collapsedContainer);

		const selectedOption = this._selectedType ? this._options.find(o => o.type === this._selectedType) : undefined;
		if (!selectedOption) {
			return;
		}

		// Create the collapsed button that shows only the icon
		const collapsedButton = append(this.collapsedContainer, $('button.chat-full-welcome-quickStart-collapsed-button'));
		collapsedButton.setAttribute('type', 'button');
		collapsedButton.setAttribute('aria-label', localize('quickStart.changeMode', "Change mode: {0}", selectedOption.label));
		collapsedButton.title = selectedOption.label;

		const iconElement = append(collapsedButton, $('.chat-full-welcome-quickStart-icon'));
		iconElement.appendChild(renderIcon(selectedOption.icon));

		// Clicking expands back to show all options
		this.buttonDisposables.add({
			dispose: () => {
				collapsedButton.onclick = null;
			}
		});

		collapsedButton.onclick = () => {
			this._onDidRequestExpand.fire();
		};
	}
}
