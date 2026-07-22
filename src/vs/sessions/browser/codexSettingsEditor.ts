/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/codexSettingsEditor.css';
import * as DOM from '../../base/browser/dom.js';
import { Button } from '../../base/browser/ui/button/button.js';
import { renderIcon } from '../../base/browser/ui/iconLabel/iconLabels.js';
import { ISelectOptionItem, SelectBox } from '../../base/browser/ui/selectBox/selectBox.js';
import { Codicon } from '../../base/common/codicons.js';
import { CancellationToken } from '../../base/common/cancellation.js';
import { Dimension } from '../../base/browser/dom.js';
import { DisposableStore, MutableDisposable } from '../../base/common/lifecycle.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { URI } from '../../base/common/uri.js';
import { localize } from '../../nls.js';
import { AgentHostCodexAgentBinaryArgsSettingId, AgentHostCodexAgentCodexHomeSettingId, AgentHostCodexAgentEnabledSettingId, AgentHostCodexAgentSdkRootSettingId, AgentHostCodexAgentUsageSourceSettingId, CodexPreferAgentHostEditorSettingId, CODEX_AGENT_PROVIDER_ID } from '../../platform/agentHost/common/agentService.js';
import type { AgentAccountState } from '../../platform/agentHost/common/state/protocol/state.js';
import { IContextViewService } from '../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { defaultButtonStyles, defaultSelectBoxStyles } from '../../platform/theme/browser/defaultStyles.js';
import { IEditorGroup } from '../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../platform/editor/common/editor.js';
import { IStorageService } from '../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../platform/theme/common/themeService.js';
import { EditorPane } from '../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../workbench/common/editor.js';
import { IPreferencesService } from '../../workbench/services/preferences/common/preferences.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import type { AgentGlobalConfigurationState } from '../../platform/agentHost/common/state/protocol/commands.js';
import { CodexAccountManager, codexPlanLabel, type ICodexAccountTarget } from './codexAccountManager.js';
import { CodexSettingsEditorInput } from './codexSettingsEditorInput.js';

const codexAdvancedSettingsQuery = [
	AgentHostCodexAgentEnabledSettingId,
	AgentHostCodexAgentUsageSourceSettingId,
	AgentHostCodexAgentSdkRootSettingId,
	AgentHostCodexAgentCodexHomeSettingId,
	AgentHostCodexAgentBinaryArgsSettingId,
	CodexPreferAgentHostEditorSettingId,
].map(setting => `@id:${setting}`).join(' ');

export class CodexSettingsEditor extends EditorPane {
	static readonly ID = 'workbench.editor.codexSettings';

	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly accountListener = this._register(new MutableDisposable());
	private readonly accountManager: CodexAccountManager;
	private container: HTMLElement | undefined;
	private dimension: Dimension | undefined;
	private busy = false;
	private configurationBusy = false;
	private configurationLoadId = 0;
	private globalConfiguration: AgentGlobalConfigurationState | undefined;
	private globalConfigurationError: Error | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@INotificationService private readonly notificationService: INotificationService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(CodexSettingsEditor.ID, group, telemetryService, themeService, storageService);
		this.accountManager = instantiationService.createInstance(CodexAccountManager);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = DOM.append(parent, DOM.$('.codex-settings-editor'));
	}

	override async setInput(input: CodexSettingsEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.configurationLoadId++;
		this.globalConfiguration = undefined;
		this.globalConfigurationError = undefined;
		const target = this.accountManager.getTarget(input.providerId);
		this.accountListener.value = target?.onDidChangeAgentAccounts(() => {
			this.render();
			if (this.globalConfigurationError) {
				void this.loadGlobalConfiguration(target);
			}
		});
		this.render();
		void this.loadGlobalConfiguration(target);
	}

	override clearInput(): void {
		this.configurationLoadId++;
		this.accountListener.clear();
		this.renderDisposables.clear();
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		if (this.container) {
			this.container.classList.toggle('narrow', dimension.width < 560);
		}
	}

	private render(): void {
		if (!this.container || !(this.input instanceof CodexSettingsEditorInput)) {
			return;
		}
		this.renderDisposables.clear();
		DOM.clearNode(this.container);
		this.container.classList.toggle('narrow', !!this.dimension && this.dimension.width < 560);

		const content = DOM.append(this.container, DOM.$('.codex-settings-content'));
		DOM.append(content, DOM.$('h1')).textContent = localize('codexSettings.title', "Codex Settings");
		DOM.append(content, DOM.$('p.codex-settings-intro')).textContent = localize('codexSettings.intro', "Account selection applies across this agent host. Codex configuration defaults are loaded when a session starts.");

		const target = this.accountManager.getTarget(this.input.providerId);
		this.renderUsageSection(content, target);
		if (target && this.globalConfiguration) {
			this.renderPersonalizationSection(content, target);
			this.renderAutoReviewSection(content, target);
		} else {
			this.renderGlobalConfigurationStatus(content, target);
		}
		this.renderConfigurationSection(content, target);
	}

	private renderUsageSection(content: HTMLElement, target: ICodexAccountTarget | undefined): void {
		const section = DOM.append(content, DOM.$('section.codex-settings-section'));
		DOM.append(section, DOM.$('h2')).textContent = localize('codexSettings.usageTitle', "Usage and account");
		DOM.append(section, DOM.$('p.codex-settings-section-description')).textContent = localize('codexSettings.usageDescription', "Choose which subscription provides quota for Codex requests.");
		const card = DOM.append(section, DOM.$('.codex-settings-card'));
		card.setAttribute('role', 'radiogroup');
		card.setAttribute('aria-label', localize('codexSettings.usageTitle', "Usage and account"));
		if (!target) {
			const unavailable = DOM.append(card, DOM.$('.codex-settings-unavailable'));
			unavailable.appendChild(renderIcon(Codicon.warning));
			DOM.append(unavailable, DOM.$('span')).textContent = localize('codexSettings.unavailable', "The Codex agent host is not connected. Reopen this page after Codex becomes available.");
			return;
		}

		const account = target.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.account;
		const source = account?.usageSource === 'openai' && account.status === 'signedIn' ? 'openai' : 'copilot';
		this.renderAccountOption(card, {
			icon: Codicon.copilot,
			label: localize('codexSettings.copilotLabel', "GitHub Copilot account"),
			description: localize('codexSettings.copilotDescription', "Uses quota and authentication from your GitHub Copilot subscription."),
			selected: source === 'copilot',
			disabled: this.busy,
			onSelect: () => this.runAccountAction(() => this.accountManager.useCopilot(target)),
		});
		this.renderAccountOption(card, {
			icon: Codicon.openai,
			label: localize('codexSettings.openAILabel', "OpenAI account"),
			description: this.getOpenAIDescription(account),
			selected: source === 'openai',
			disabled: this.busy || account?.status === 'signingIn',
			onSelect: () => this.runAccountAction(() => this.accountManager.useOpenAI(target)),
			actionLabel: account?.status === 'signedIn' ? localize('codexSettings.signOut', "Sign Out") : localize('codexSettings.signIn', "Sign In"),
			onAction: account?.status === 'signedIn'
				? () => this.runAccountAction(() => this.accountManager.signOut(target))
				: () => this.runAccountAction(() => this.accountManager.useOpenAI(target)),
		});
	}

	private renderAccountOption(card: HTMLElement, options: {
		icon: ThemeIcon;
		label: string;
		description: string;
		selected: boolean;
		disabled: boolean;
		onSelect: () => void;
		actionLabel?: string;
		onAction?: () => void;
	}): void {
		const row = DOM.append(card, DOM.$('.codex-settings-account-row'));
		row.classList.toggle('selected', options.selected);
		const selector = DOM.append(row, DOM.$('button.codex-settings-account-selector')) as HTMLButtonElement;
		selector.type = 'button';
		selector.disabled = options.disabled;
		selector.setAttribute('role', 'radio');
		selector.setAttribute('aria-checked', String(options.selected));
		selector.appendChild(renderIcon(options.icon));
		const labels = DOM.append(selector, DOM.$('.codex-settings-account-labels'));
		DOM.append(labels, DOM.$('.codex-settings-account-label')).textContent = options.label;
		DOM.append(labels, DOM.$('.codex-settings-account-description')).textContent = options.description;
		const radio = DOM.append(selector, DOM.$('.codex-settings-radio'));
		radio.classList.toggle('checked', options.selected);
		this.renderDisposables.add(DOM.addDisposableListener(selector, DOM.EventType.CLICK, options.onSelect));

		if (options.actionLabel && options.onAction) {
			const actionContainer = DOM.append(row, DOM.$('.codex-settings-account-action'));
			const action = this.renderDisposables.add(new Button(actionContainer, { ...defaultButtonStyles, secondary: true }));
			action.label = options.actionLabel;
			action.enabled = !options.disabled;
			this.renderDisposables.add(action.onDidClick(options.onAction));
		}
	}

	private renderPersonalizationSection(content: HTMLElement, target: ICodexAccountTarget): void {
		const section = DOM.append(content, DOM.$('section.codex-settings-section'));
		DOM.append(section, DOM.$('h2')).textContent = localize('codexSettings.personalizationTitle', "Personalization");
		DOM.append(section, DOM.$('p.codex-settings-section-description')).textContent = localize('codexSettings.personalizationDescription', "Choose Codex's default communication style. Existing sessions keep the personality they started with.");
		const card = DOM.append(section, DOM.$('.codex-settings-card'));
		const row = DOM.append(card, DOM.$('.codex-settings-configuration-row'));
		const labels = DOM.append(row, DOM.$('.codex-settings-configuration-labels'));
		DOM.append(labels, DOM.$('.codex-settings-configuration-label')).textContent = localize('codexSettings.personalityLabel', "Personality");
		DOM.append(labels, DOM.$('.codex-settings-configuration-description')).textContent = localize('codexSettings.personalityDescription', "Controls the tone Codex uses when responding in newly started sessions.");
		const personalities = [
			{ value: 'none', label: localize('codexSettings.personalityDefault', "Default") },
			{ value: 'friendly', label: localize('codexSettings.personalityFriendly', "Friendly") },
			{ value: 'pragmatic', label: localize('codexSettings.personalityPragmatic', "Pragmatic") },
		];
		const selectedPersonality = this.readStringConfiguration('personality', 'none');
		const selectedIndex = Math.max(0, personalities.findIndex(personality => personality.value === selectedPersonality));
		const selectOptions: ISelectOptionItem[] = personalities.map(personality => ({ text: personality.label }));
		const selectContainer = DOM.append(row, DOM.$('.codex-settings-select-container'));
		const select = this.renderDisposables.add(new SelectBox(selectOptions, selectedIndex, this.contextViewService, defaultSelectBoxStyles, {
			ariaLabel: localize('codexSettings.personalityLabel', "Personality"),
			useCustomDrawn: true,
		}));
		select.render(selectContainer);
		select.setEnabled(!this.configurationBusy);
		this.renderDisposables.add(select.onDidSelect(event => {
			void this.writeGlobalConfiguration(target, [{ keyPath: 'personality', value: personalities[event.index].value }]);
		}));
	}

	private renderAutoReviewSection(content: HTMLElement, target: ICodexAccountTarget): void {
		const section = DOM.append(content, DOM.$('section.codex-settings-section'));
		DOM.append(section, DOM.$('h2')).textContent = localize('codexSettings.autoReviewTitle', "Auto-review policy");
		DOM.append(section, DOM.$('p.codex-settings-section-description')).textContent = localize('codexSettings.autoReviewDescription', "Optional guidance used when Auto-Review is selected in the permissions picker. This does not expand sandbox access.");
		const card = DOM.append(section, DOM.$('.codex-settings-card'));
		const policyRow = DOM.append(card, DOM.$('.codex-settings-configuration-row.codex-settings-policy-row'));
		const policyLabels = DOM.append(policyRow, DOM.$('.codex-settings-configuration-labels'));
		DOM.append(policyLabels, DOM.$('.codex-settings-configuration-label')).textContent = localize('codexSettings.autoReviewPolicyLabel', "Review policy");
		DOM.append(policyLabels, DOM.$('.codex-settings-configuration-description')).textContent = localize('codexSettings.autoReviewPolicyDescription', "Optional guidance for the reviewer, such as actions it should always deny or require you to review.");
		const textarea = DOM.append(policyLabels, DOM.$('textarea.codex-settings-policy-input')) as HTMLTextAreaElement;
		const initialPolicy = this.readStringConfiguration('auto_review.policy', '');
		textarea.value = initialPolicy;
		textarea.placeholder = localize('codexSettings.autoReviewPolicyPlaceholder', "Example: Never approve commands that publish packages or change cloud infrastructure.");
		textarea.disabled = this.configurationBusy;
		const policyActionContainer = DOM.append(policyRow, DOM.$('.codex-settings-policy-actions'));
		const savePolicy = this.renderDisposables.add(new Button(policyActionContainer, { ...defaultButtonStyles, secondary: true }));
		savePolicy.label = localize('codexSettings.savePolicy', "Save Policy");
		savePolicy.enabled = false;
		this.renderDisposables.add(DOM.addDisposableListener(textarea, DOM.EventType.INPUT, () => {
			savePolicy.enabled = !this.configurationBusy && textarea.value !== initialPolicy;
		}));
		this.renderDisposables.add(savePolicy.onDidClick(() => {
			void this.writeGlobalConfiguration(target, [{ keyPath: 'auto_review.policy', value: textarea.value }]);
		}));
	}

	private renderGlobalConfigurationStatus(content: HTMLElement, target: ICodexAccountTarget | undefined): void {
		const section = DOM.append(content, DOM.$('section.codex-settings-section'));
		DOM.append(section, DOM.$('h2')).textContent = localize('codexSettings.codexConfigurationTitle', "Codex configuration");
		const card = DOM.append(section, DOM.$('.codex-settings-card'));
		const unavailable = DOM.append(card, DOM.$('.codex-settings-unavailable'));
		const hasError = !target || !!this.globalConfigurationError;
		unavailable.classList.toggle('error', hasError);
		unavailable.setAttribute('role', hasError ? 'alert' : 'status');
		unavailable.appendChild(renderIcon(hasError ? Codicon.error : ThemeIcon.modify(Codicon.loading, 'spin')));
		DOM.append(unavailable, DOM.$('span')).textContent = !target
			? localize('codexSettings.configurationUnavailable', "The Codex agent host is not connected.")
			: this.globalConfigurationError
				? localize('codexSettings.configurationLoadError', "Codex configuration could not be loaded: {0}", this.globalConfigurationError.message)
				: localize('codexSettings.configurationLoading', "Loading Codex configuration…");
	}

	private renderConfigurationSection(content: HTMLElement, target: ICodexAccountTarget | undefined): void {
		const section = DOM.append(content, DOM.$('section.codex-settings-section'));
		DOM.append(section, DOM.$('h2')).textContent = localize('codexSettings.configurationTitle', "Configuration");
		DOM.append(section, DOM.$('p.codex-settings-section-description')).textContent = localize('codexSettings.configurationDescription', "Open advanced Codex and VS Code integration settings.");
		const card = DOM.append(section, DOM.$('.codex-settings-card'));

		if (target && this.globalConfiguration) {
			const configRow = DOM.append(card, DOM.$('.codex-settings-configuration-row'));
			const configLabels = DOM.append(configRow, DOM.$('.codex-settings-configuration-labels'));
			DOM.append(configLabels, DOM.$('.codex-settings-configuration-label')).textContent = localize('codexSettings.configTomlLabel', "Codex config.toml");
			DOM.append(configLabels, DOM.$('.codex-settings-configuration-description')).textContent = localize('codexSettings.configTomlDescription', "Open the agent host's Codex configuration file to customize additional agent behavior.");
			const configActionContainer = DOM.append(configRow, DOM.$('.codex-settings-configuration-action'));
			const configAction = this.renderDisposables.add(new Button(configActionContainer, { ...defaultButtonStyles, secondary: true }));
			configAction.label = localize('codexSettings.openConfigToml', "Open config.toml");
			this.renderDisposables.add(configAction.onDidClick(() => this.editorService.openEditor({ resource: URI.parse(this.globalConfiguration!.file), options: { pinned: true } })));
		}

		const advancedRow = DOM.append(card, DOM.$('.codex-settings-configuration-row'));
		const advancedLabels = DOM.append(advancedRow, DOM.$('.codex-settings-configuration-labels'));
		DOM.append(advancedLabels, DOM.$('.codex-settings-configuration-label')).textContent = localize('codexSettings.advancedLabel', "Advanced Codex settings");
		DOM.append(advancedLabels, DOM.$('.codex-settings-configuration-description')).textContent = localize('codexSettings.advancedDescription', "Open VS Code Settings for editor integration, Codex home, SDK, and app-server options.");
		const advancedActionContainer = DOM.append(advancedRow, DOM.$('.codex-settings-configuration-action'));
		const advancedAction = this.renderDisposables.add(new Button(advancedActionContainer, { ...defaultButtonStyles, secondary: true }));
		advancedAction.label = localize('codexSettings.openSettings', "Open Settings");
		this.renderDisposables.add(advancedAction.onDidClick(() => {
			void this.preferencesService.openSettings({ query: codexAdvancedSettingsQuery });
		}));
	}

	private readStringConfiguration(keyPath: string, fallback: string): string {
		const value = this.globalConfiguration?.values[keyPath];
		return typeof value === 'string' ? value : fallback;
	}

	private async loadGlobalConfiguration(target: ICodexAccountTarget | undefined): Promise<void> {
		const loadId = ++this.configurationLoadId;
		this.globalConfiguration = undefined;
		this.globalConfigurationError = undefined;
		if (!target) {
			this.render();
			return;
		}
		try {
			const globalConfiguration = await target.readAgentGlobalConfiguration(CODEX_AGENT_PROVIDER_ID, ['personality', 'auto_review.policy']);
			if (loadId !== this.configurationLoadId) {
				return;
			}
			this.globalConfiguration = globalConfiguration;
		} catch (error) {
			if (loadId !== this.configurationLoadId) {
				return;
			}
			this.globalConfigurationError = error instanceof Error ? error : new Error(String(error));
		}
		this.render();
	}

	private async writeGlobalConfiguration(target: ICodexAccountTarget, edits: { keyPath: string; value: string }[]): Promise<void> {
		if (this.configurationBusy) {
			return;
		}
		this.configurationBusy = true;
		this.render();
		try {
			const previousValues = this.globalConfiguration?.values ?? {};
			const result = await target.writeAgentGlobalConfiguration(CODEX_AGENT_PROVIDER_ID, edits, this.globalConfiguration?.version);
			this.globalConfiguration = { ...result, values: { ...previousValues, ...result.values } };
			this.globalConfigurationError = undefined;
		} catch (error) {
			this.notificationService.error(error);
			await this.loadGlobalConfiguration(target);
		} finally {
			this.configurationBusy = false;
			this.render();
		}
	}

	private getOpenAIDescription(account: AgentAccountState | undefined): string {
		if (account?.status === 'signingIn') {
			return localize('codexSettings.openAISigningIn', "Waiting for ChatGPT sign-in…");
		}
		if (account?.authType === 'apiKey') {
			return localize('codexSettings.openAIAPIKey', "Signed in with an API key. Usage is billed to your OpenAI API account.");
		}
		if (account?.authType === 'chatgpt' && account.status === 'signedIn') {
			return account.planType && account.planType !== 'unknown'
				? localize('codexSettings.openAIChatGPTPlan', "Signed in with ChatGPT · {0} plan.", codexPlanLabel(account.planType))
				: localize('codexSettings.openAIChatGPT', "Signed in with ChatGPT. Uses quota from your OpenAI subscription.");
		}
		return localize('codexSettings.openAISignedOut', "Sign in with ChatGPT to use quota from your OpenAI subscription.");
	}

	private async runAccountAction(action: () => Promise<void>): Promise<void> {
		if (this.busy) {
			return;
		}
		this.busy = true;
		this.render();
		try {
			await action();
		} catch (error) {
			this.notificationService.error(error);
		} finally {
			this.busy = false;
			this.render();
		}
	}
}
