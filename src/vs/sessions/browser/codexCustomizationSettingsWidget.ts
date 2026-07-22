/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/codexCustomizationSettings.css';
import * as DOM from '../../base/browser/dom.js';
import { Button } from '../../base/browser/ui/button/button.js';
import { renderIcon } from '../../base/browser/ui/iconLabel/iconLabels.js';
import { Radio } from '../../base/browser/ui/radio/radio.js';
import { ISelectOptionItem, SelectBox } from '../../base/browser/ui/selectBox/selectBox.js';
import { Codicon } from '../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../base/common/lifecycle.js';
import { autorun, type IObservable } from '../../base/common/observable.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { URI } from '../../base/common/uri.js';
import { localize } from '../../nls.js';
import { CODEX_AGENT_PROVIDER_ID } from '../../platform/agentHost/common/agentService.js';
import type { AgentGlobalConfigurationState } from '../../platform/agentHost/common/state/protocol/commands.js';
import type { AgentAccountState } from '../../platform/agentHost/common/state/protocol/state.js';
import { IContextViewService } from '../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { IHoverService } from '../../platform/hover/browser/hover.js';
import { Link } from '../../platform/opener/browser/link.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { defaultButtonStyles, defaultSelectBoxStyles } from '../../platform/theme/browser/defaultStyles.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { CodexAccountManager, codexPlanLabel, type ICodexAccountTarget } from './codexAccountManager.js';

const CODEX_CONFIGURATION_KEY_PATHS = ['personality', 'auto_review.policy'] as const;
const CODEX_CONFIGURATION_DOCUMENTATION = 'https://learn.chatgpt.com/docs/config-file/config-basic';

export class CodexCustomizationSettingsWidget extends Disposable {
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly accountListener = this._register(new MutableDisposable());
	private readonly accountManager: CodexAccountManager;
	private readonly container: HTMLElement;
	private busy = false;
	private configurationBusy = false;
	private configurationLoadId = 0;
	private globalConfiguration: AgentGlobalConfigurationState | undefined;
	private globalConfigurationError: Error | undefined;
	private target: ICodexAccountTarget | undefined;
	private focusTarget: HTMLElement | undefined;

	constructor(
		parent: HTMLElement,
		private readonly providerId: IObservable<string | undefined> | undefined,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
		@IHoverService private readonly hoverService: IHoverService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this.accountManager = instantiationService.createInstance(CodexAccountManager);
		this.container = DOM.append(parent, DOM.$('.codex-customization-settings'));
		this._register(autorun(reader => {
			this.connect(this.providerId?.read(reader));
		}));
	}

	layout(): void {
		this.container.classList.toggle('narrow', this.container.clientWidth < 560);
	}

	focus(): void {
		this.focusTarget?.focus();
	}

	private connect(providerId: string | undefined): void {
		const target = this.accountManager.getTarget(providerId);
		if (target === this.target) {
			return;
		}
		this.target = target;
		this.configurationLoadId++;
		this.globalConfiguration = undefined;
		this.globalConfigurationError = undefined;
		this.accountListener.value = target?.onDidChangeAgentAccounts(() => {
			this.render();
			if (this.globalConfigurationError) {
				void this.loadGlobalConfiguration(target);
			}
		});
		this.render();
		void this.loadGlobalConfiguration(target);
	}

	private render(): void {
		this.renderDisposables.clear();
		this.focusTarget = undefined;
		DOM.clearNode(this.container);
		const content = DOM.append(this.container, DOM.$('.codex-customization-settings-content'));
		DOM.append(content, DOM.$('h1')).textContent = localize('codexCustomizationSettings.title', "Codex settings");
		DOM.append(content, DOM.$('p.codex-customization-settings-intro')).textContent = localize('codexCustomizationSettings.intro', "Configure the account and defaults used by Codex. New sessions use the updated personality and auto-review policy; existing sessions retain their session-scoped values. Some advanced config.toml changes may require restarting the Codex App Server.");

		const target = this.target;
		this.renderUsageSection(content, target);
		if (target && this.globalConfiguration) {
			this.renderPersonalizationSection(content, target);
			this.renderAutoReviewSection(content, target);
			this.renderConfigurationSection(content);
		} else {
			this.renderGlobalConfigurationStatus(content, target);
		}
	}

	private renderSection(content: HTMLElement, title: string, description: string): HTMLElement {
		const section = DOM.append(content, DOM.$('section.codex-customization-settings-section'));
		DOM.append(section, DOM.$('h2')).textContent = title;
		DOM.append(section, DOM.$('p.codex-customization-settings-section-description')).textContent = description;
		return DOM.append(section, DOM.$('.codex-customization-settings-card'));
	}

	private renderUsageSection(content: HTMLElement, target: ICodexAccountTarget | undefined): void {
		const card = this.renderSection(content, localize('codexCustomizationSettings.usageTitle', "Usage and account"), localize('codexCustomizationSettings.usageDescription', "Choose which subscription provides quota for Codex requests."));
		if (!target) {
			this.renderUnavailable(card, localize('codexCustomizationSettings.unavailable', "The Codex agent host is not connected."), true);
			return;
		}
		const account = target.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.account;
		const source = account?.usageSource === 'openai' && account.status !== 'signedOut' ? 'openai' : 'copilot';
		const row = DOM.append(card, DOM.$('.codex-customization-settings-row'));
		const labels = DOM.append(row, DOM.$('.codex-customization-settings-labels'));
		DOM.append(labels, DOM.$('.codex-customization-settings-label')).textContent = localize('codexCustomizationSettings.subscriptionLabel', "Subscription");
		DOM.append(labels, DOM.$('.codex-customization-settings-description')).textContent = localize('codexCustomizationSettings.subscriptionDescription', "Select the account whose quota Codex should use.");
		const radio = this.renderDisposables.add(new Radio({
			items: [
				{ text: `$(${Codicon.copilot.id}) ${localize('codexCustomizationSettings.copilotLabel', "GitHub Copilot")}`, isActive: source === 'copilot' },
				{ text: `$(${Codicon.openai.id}) ${localize('codexCustomizationSettings.openAILabel', "OpenAI")}`, isActive: source === 'openai' },
			],
		}));
		radio.setEnabled(!this.busy && account?.status !== 'signingIn');
		const radioContainer = DOM.append(row, DOM.$('.codex-customization-settings-account-options'));
		radioContainer.appendChild(radio.domNode);
		this.focusTarget = DOM.isHTMLElement(radio.domNode.firstElementChild) ? radio.domNode.firstElementChild : undefined;
		this.renderDisposables.add(radio.onDidSelect(index => void this.runAccountAction(() => index === 0 ? this.accountManager.useCopilot(target) : this.accountManager.useOpenAI(target))));

		const statusRow = DOM.append(card, DOM.$('.codex-customization-settings-account-status'));
		statusRow.appendChild(renderIcon(source === 'openai' ? Codicon.openai : Codicon.copilot));
		DOM.append(statusRow, DOM.$('.codex-customization-settings-description')).textContent = source === 'openai' ? this.getOpenAIDescription(account) : localize('codexCustomizationSettings.copilotDescription', "Uses quota and authentication from your GitHub Copilot subscription.");
		if (source === 'openai') {
			const action = this.renderDisposables.add(new Button(DOM.append(statusRow, DOM.$('.codex-customization-settings-action')), { ...defaultButtonStyles, secondary: true }));
			action.label = account?.status === 'signedIn' ? localize('codexCustomizationSettings.signOut', "Sign Out") : localize('codexCustomizationSettings.signIn', "Sign In");
			action.enabled = !this.busy && account?.status !== 'signingIn';
			this.renderDisposables.add(action.onDidClick(() => void this.runAccountAction(() => account?.status === 'signedIn' ? this.accountManager.signOut(target) : this.accountManager.useOpenAI(target))));
		}
	}

	private renderPersonalizationSection(content: HTMLElement, target: ICodexAccountTarget): void {
		const card = this.renderSection(content, localize('codexCustomizationSettings.personalizationTitle', "Personalization"), localize('codexCustomizationSettings.personalizationDescription', "Choose Codex's default communication style."));
		const row = DOM.append(card, DOM.$('.codex-customization-settings-row'));
		const labels = DOM.append(row, DOM.$('.codex-customization-settings-labels'));
		DOM.append(labels, DOM.$('.codex-customization-settings-label')).textContent = localize('codexCustomizationSettings.personalityLabel', "Personality");
		DOM.append(labels, DOM.$('.codex-customization-settings-description')).textContent = localize('codexCustomizationSettings.personalityDescription', "Controls the tone Codex uses in newly started sessions.");
		const personalities = [
			{ value: 'none', label: localize('codexCustomizationSettings.personalityDefault', "Default") },
			{ value: 'friendly', label: localize('codexCustomizationSettings.personalityFriendly', "Friendly") },
			{ value: 'pragmatic', label: localize('codexCustomizationSettings.personalityPragmatic', "Pragmatic") },
		];
		const current = this.readStringConfiguration('personality', 'none');
		const selected = Math.max(0, personalities.findIndex(personality => personality.value === current));
		const options: ISelectOptionItem[] = personalities.map(personality => ({ text: personality.label }));
		const select = this.renderDisposables.add(new SelectBox(options, selected, this.contextViewService, defaultSelectBoxStyles, { ariaLabel: localize('codexCustomizationSettings.personalityLabel', "Personality"), useCustomDrawn: true }));
		select.render(DOM.append(row, DOM.$('.codex-customization-settings-select')));
		select.setEnabled(!this.configurationBusy);
		this.renderDisposables.add(select.onDidSelect(event => void this.writeGlobalConfiguration(target, [{ keyPath: 'personality', value: personalities[event.index].value }])));
	}

	private renderAutoReviewSection(content: HTMLElement, target: ICodexAccountTarget): void {
		const card = this.renderSection(content, localize('codexCustomizationSettings.autoReviewTitle', "Auto-review policy"), localize('codexCustomizationSettings.autoReviewDescription', "Optional guidance used when Auto-Review is selected in the permissions picker."));
		const row = DOM.append(card, DOM.$('.codex-customization-settings-policy-row'));
		DOM.append(row, DOM.$('.codex-customization-settings-label')).textContent = localize('codexCustomizationSettings.policyLabel', "Review policy");
		DOM.append(row, DOM.$('.codex-customization-settings-description')).textContent = localize('codexCustomizationSettings.policyDescription', "Saved as auto_review.policy in config.toml. Describe actions the reviewer should deny or require you to review. This does not expand sandbox access.");
		const textarea = DOM.append(row, DOM.$('textarea.codex-customization-settings-policy')) as HTMLTextAreaElement;
		const initialPolicy = this.readStringConfiguration('auto_review.policy', '');
		textarea.value = initialPolicy;
		textarea.placeholder = localize('codexCustomizationSettings.policyPlaceholder', "Example: Never approve commands that publish packages or change cloud infrastructure.");
		textarea.disabled = this.configurationBusy;
		const actions = DOM.append(row, DOM.$('.codex-customization-settings-policy-actions'));
		const save = this.renderDisposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		save.label = localize('codexCustomizationSettings.savePolicy', "Save Policy");
		save.enabled = false;
		this.renderDisposables.add(DOM.addDisposableListener(textarea, DOM.EventType.INPUT, () => save.enabled = !this.configurationBusy && textarea.value !== initialPolicy));
		this.renderDisposables.add(save.onDidClick(() => {
			const policy = textarea.value.trim();
			void this.writeGlobalConfiguration(target, [policy ? { keyPath: 'auto_review.policy', value: policy } : { keyPath: 'auto_review', value: null }]);
		}));
	}

	private renderConfigurationSection(content: HTMLElement): void {
		const card = this.renderSection(content, localize('codexCustomizationSettings.configurationTitle', "Configuration"), localize('codexCustomizationSettings.configurationDescription', "Customize additional Codex behavior in the Codex configuration file."));
		const row = DOM.append(card, DOM.$('.codex-customization-settings-row'));
		const labels = DOM.append(row, DOM.$('.codex-customization-settings-labels'));
		DOM.append(labels, DOM.$('.codex-customization-settings-label')).textContent = localize('codexCustomizationSettings.configLabel', "Codex config.toml");
		const description = DOM.append(labels, DOM.$('.codex-customization-settings-description'));
		DOM.append(description, DOM.$('span')).textContent = localize('codexCustomizationSettings.configDescription', "Open the Codex configuration file to customize additional agent behavior. ");
		this.renderDisposables.add(new Link(description, {
			label: localize('codexCustomizationSettings.configDocumentation', "View Codex configuration documentation"),
			href: CODEX_CONFIGURATION_DOCUMENTATION,
		}, {}, this.hoverService, this.openerService));
		const action = this.renderDisposables.add(new Button(DOM.append(row, DOM.$('.codex-customization-settings-action')), { ...defaultButtonStyles, secondary: true }));
		action.label = localize('codexCustomizationSettings.openConfig', "Open config.toml");
		this.renderDisposables.add(action.onDidClick(() => this.editorService.openEditor({ resource: URI.parse(this.globalConfiguration!.file), options: { pinned: true } })));
	}

	private renderGlobalConfigurationStatus(content: HTMLElement, target: ICodexAccountTarget | undefined): void {
		const card = this.renderSection(content, localize('codexCustomizationSettings.configurationStatusTitle', "Codex configuration"), '');
		const hasError = !target || !!this.globalConfigurationError;
		this.renderUnavailable(card, !target ? localize('codexCustomizationSettings.configurationUnavailable', "The Codex agent host is not connected.") : this.globalConfigurationError ? localize('codexCustomizationSettings.configurationError', "Codex configuration could not be loaded: {0}", this.globalConfigurationError.message) : localize('codexCustomizationSettings.configurationLoading', "Loading Codex configuration…"), hasError);
	}

	private renderUnavailable(card: HTMLElement, message: string, error: boolean): void {
		const status = DOM.append(card, DOM.$('.codex-customization-settings-status'));
		status.classList.toggle('error', error);
		status.setAttribute('role', error ? 'alert' : 'status');
		status.appendChild(renderIcon(error ? Codicon.error : ThemeIcon.modify(Codicon.loading, 'spin')));
		DOM.append(status, DOM.$('span')).textContent = message;
	}

	private readStringConfiguration(keyPath: string, fallback: string): string {
		const value = this.globalConfiguration?.values[keyPath];
		return typeof value === 'string' ? value : fallback;
	}

	private async loadGlobalConfiguration(target: ICodexAccountTarget | undefined): Promise<void> {
		const loadId = ++this.configurationLoadId;
		if (!target) {
			this.render();
			return;
		}
		try {
			const configuration = await target.readAgentGlobalConfiguration(CODEX_AGENT_PROVIDER_ID, CODEX_CONFIGURATION_KEY_PATHS);
			if (loadId !== this.configurationLoadId) { return; }
			this.globalConfiguration = configuration;
			this.globalConfigurationError = undefined;
		} catch (error) {
			if (loadId !== this.configurationLoadId) { return; }
			this.globalConfigurationError = error instanceof Error ? error : new Error(String(error));
		}
		this.render();
	}

	private async writeGlobalConfiguration(target: ICodexAccountTarget, edits: { keyPath: string; value: string | null }[]): Promise<void> {
		if (this.configurationBusy) { return; }
		this.configurationBusy = true;
		this.render();
		try {
			await target.writeAgentGlobalConfiguration(CODEX_AGENT_PROVIDER_ID, edits, this.globalConfiguration?.version);
			this.globalConfiguration = await target.readAgentGlobalConfiguration(CODEX_AGENT_PROVIDER_ID, CODEX_CONFIGURATION_KEY_PATHS);
		} catch (error) {
			this.notificationService.error(error);
			await this.loadGlobalConfiguration(target);
		} finally {
			this.configurationBusy = false;
			this.render();
		}
	}

	private getOpenAIDescription(account: AgentAccountState | undefined): string {
		if (account?.status === 'signingIn') { return localize('codexCustomizationSettings.openAISigningIn', "Waiting for ChatGPT sign-in…"); }
		if (account?.authType === 'apiKey') { return localize('codexCustomizationSettings.openAIAPIKey', "Signed in with an API key. Usage is billed to your OpenAI API account."); }
		if (account?.authType === 'chatgpt' && account.status === 'signedIn') {
			return account.planType && account.planType !== 'unknown' ? localize('codexCustomizationSettings.openAIPlan', "Signed in with ChatGPT · {0} plan.", codexPlanLabel(account.planType)) : localize('codexCustomizationSettings.openAIChatGPT', "Signed in with ChatGPT. Uses quota from your OpenAI subscription.");
		}
		return localize('codexCustomizationSettings.openAISignedOut', "Sign in with ChatGPT to use quota from your OpenAI subscription.");
	}

	private async runAccountAction(action: () => Promise<void>): Promise<void> {
		if (this.busy) { return; }
		this.busy = true;
		this.render();
		try { await action(); } catch (error) { this.notificationService.error(error); } finally { this.busy = false; this.render(); }
	}
}
