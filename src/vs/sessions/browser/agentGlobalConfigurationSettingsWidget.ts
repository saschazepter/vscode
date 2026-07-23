/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentGlobalConfigurationSettings.css';
import * as DOM from '../../base/browser/dom.js';
import { Button } from '../../base/browser/ui/button/button.js';
import { Checkbox } from '../../base/browser/ui/toggle/toggle.js';
import { ISelectOptionItem, SelectBox } from '../../base/browser/ui/selectBox/selectBox.js';
import { Codicon } from '../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../base/common/lifecycle.js';
import { autorun, type IObservable } from '../../base/common/observable.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { URI } from '../../base/common/uri.js';
import { localize } from '../../nls.js';
import { IAgentHostService } from '../../platform/agentHost/common/agentService.js';
import type { AgentGlobalConfigurationEdit, AgentGlobalConfigurationState, AgentGlobalConfigurationValue } from '../../platform/agentHost/common/state/protocol/commands.js';
import type { AgentGlobalConfigurationCapability, AgentGlobalConfigurationSetting, AgentInfo } from '../../platform/agentHost/common/state/protocol/state.js';
import { IContextViewService } from '../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { IHoverService } from '../../platform/hover/browser/hover.js';
import { Link } from '../../platform/opener/browser/link.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultSelectBoxStyles } from '../../platform/theme/browser/defaultStyles.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../workbench/services/environment/common/environmentService.js';
import { isAgentHostProvider, type IAgentHostSessionsProvider } from '../common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../services/sessions/browser/sessionsProvidersService.js';

interface IAgentGlobalConfigurationTarget {
	readonly onDidChange: (listener: () => void) => { dispose(): void };
	getAgentInfo(provider: string): AgentInfo | undefined;
	readAgentGlobalConfiguration(provider: string, keyPaths: readonly string[]): Promise<AgentGlobalConfigurationState>;
	writeAgentGlobalConfiguration(provider: string, edits: readonly AgentGlobalConfigurationEdit[], expectedVersion?: string): Promise<AgentGlobalConfigurationState>;
}

export class AHPAgentSettingsWidget extends Disposable {
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly targetListener = this._register(new MutableDisposable());
	private readonly container: HTMLElement;
	private configurationBusy = false;
	private configurationLoadId = 0;
	private configuration: AgentGlobalConfigurationState | undefined;
	private configurationError: Error | undefined;
	private target: IAgentGlobalConfigurationTarget | undefined;
	private capability: AgentGlobalConfigurationCapability | undefined;
	private focusTarget: HTMLElement | undefined;

	constructor(
		parent: HTMLElement,
		private readonly agentProvider: string,
		private readonly sessionsProviderId: IObservable<string | undefined> | undefined,
		@IAgentHostService private readonly agentHostService: IAgentHostService,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
		@IHoverService private readonly hoverService: IHoverService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super();
		this.container = DOM.append(parent, DOM.$('.agent-global-configuration-settings'));
		this._register(autorun(reader => {
			const providerId = this.sessionsProviderId?.read(reader);
			this.connect(this.getTarget(providerId));
		}));
		this._register(this.agentHostService.rootState.onDidChange(() => {
			if (!this.environmentService.isSessionsWindow) {
				this.connect(this.getTarget(undefined));
			}
		}));
	}

	layout(): void {
		this.container.classList.toggle('narrow', this.container.clientWidth < 560);
	}

	focus(): void {
		this.focusTarget?.focus();
	}

	private getTarget(providerId: string | undefined): IAgentGlobalConfigurationTarget | undefined {
		if (!this.environmentService.isSessionsWindow) {
			if (!this.agentHostService.readAgentGlobalConfiguration || !this.agentHostService.writeAgentGlobalConfiguration) {
				return undefined;
			}
			return {
				onDidChange: listener => this.agentHostService.rootState.onDidChange(listener),
				getAgentInfo: provider => {
					const rootState = this.agentHostService.rootState.value;
					return rootState && !(rootState instanceof Error) ? rootState.agents.find(agent => agent.provider === provider) : undefined;
				},
				readAgentGlobalConfiguration: (provider, keyPaths) => this.agentHostService.readAgentGlobalConfiguration!(provider, keyPaths),
				writeAgentGlobalConfiguration: (provider, edits, expectedVersion) => this.agentHostService.writeAgentGlobalConfiguration!(provider, edits, expectedVersion),
			};
		}
		if (providerId) {
			const provider = this.sessionsProvidersService.getProvider(providerId);
			if (provider && isAgentHostProvider(provider)) {
				return this.asTarget(provider);
			}
		}
		const provider = this.sessionsProvidersService.getProviders().find(isAgentHostProvider);
		return provider ? this.asTarget(provider) : undefined;
	}

	private asTarget(provider: IAgentHostSessionsProvider): IAgentGlobalConfigurationTarget {
		return {
			onDidChange: provider.onDidChangeAgentAccounts,
			getAgentInfo: agentProvider => provider.getAgentInfo(agentProvider),
			readAgentGlobalConfiguration: (agentProvider, keyPaths) => provider.readAgentGlobalConfiguration(agentProvider, keyPaths),
			writeAgentGlobalConfiguration: (agentProvider, edits, expectedVersion) => provider.writeAgentGlobalConfiguration(agentProvider, edits, expectedVersion),
		};
	}

	private connect(target: IAgentGlobalConfigurationTarget | undefined): void {
		const capability = target?.getAgentInfo(this.agentProvider)?.capabilities?.globalConfiguration;
		if (target === this.target && capability === this.capability) {
			return;
		}
		this.target = target;
		this.capability = capability;
		this.configurationLoadId++;
		this.configuration = undefined;
		this.configurationError = undefined;
		this.targetListener.value = target?.onDidChange(() => this.refreshTarget(target));
		this.render();
		void this.loadConfiguration(target, capability);
	}

	private refreshTarget(target: IAgentGlobalConfigurationTarget): void {
		if (target !== this.target) {
			return;
		}
		const capability = target.getAgentInfo(this.agentProvider)?.capabilities?.globalConfiguration;
		if (capability !== this.capability) {
			this.capability = capability;
			this.configuration = undefined;
			this.configurationError = undefined;
			this.render();
		}
		void this.loadConfiguration(target, capability);
	}

	private get keyPaths(): readonly string[] {
		return this.capability?.groups.flatMap(group => group.settings.map(setting => setting.keyPath)) ?? [];
	}

	private render(): void {
		this.renderDisposables.clear();
		this.focusTarget = undefined;
		DOM.clearNode(this.container);
		const content = DOM.append(this.container, DOM.$('.agent-global-configuration-settings-content'));
		const capability = this.capability;
		DOM.append(content, DOM.$('h1')).textContent = capability?.title ?? localize('agentGlobalConfigurationSettings.title', "Agent settings");
		if (capability) {
			DOM.append(content, DOM.$('p.agent-global-configuration-settings-intro')).textContent = capability.description;
		}
		if (this.target && capability && this.configuration) {
			for (const group of capability.groups) {
				const card = this.renderSection(content, group.title, group.description ?? '');
				for (const setting of group.settings) {
					this.renderSetting(card, setting, this.target);
				}
			}
			this.renderConfigurationFile(content, capability, this.configuration);
		} else {
			this.renderStatus(content);
		}
	}

	private renderSection(content: HTMLElement, title: string, description: string): HTMLElement {
		const section = DOM.append(content, DOM.$('section.agent-global-configuration-settings-section'));
		DOM.append(section, DOM.$('h2')).textContent = title;
		DOM.append(section, DOM.$('p.agent-global-configuration-settings-section-description')).textContent = description;
		return DOM.append(section, DOM.$('.agent-global-configuration-settings-card'));
	}

	private renderSetting(card: HTMLElement, setting: AgentGlobalConfigurationSetting, target: IAgentGlobalConfigurationTarget): void {
		if (setting.multiline) {
			this.renderTextSetting(card, setting, target, true);
			return;
		}
		const row = DOM.append(card, DOM.$('.agent-global-configuration-settings-row'));
		const labels = DOM.append(row, DOM.$('.agent-global-configuration-settings-labels'));
		DOM.append(labels, DOM.$('.agent-global-configuration-settings-label')).textContent = setting.title;
		DOM.append(labels, DOM.$('.agent-global-configuration-settings-description')).textContent = setting.description;
		if (setting.options?.length) {
			const current = this.readValue(setting);
			const selected = Math.max(0, setting.options.findIndex(option => option.value === current));
			const options: ISelectOptionItem[] = setting.options.map(option => ({ text: option.label }));
			const select = this.renderDisposables.add(new SelectBox(options, selected, this.contextViewService, defaultSelectBoxStyles, { ariaLabel: setting.title, useCustomDrawn: true }));
			const selectContainer = DOM.append(row, DOM.$('.agent-global-configuration-settings-select'));
			select.render(selectContainer);
			select.setEnabled(!this.configurationBusy);
			this.focusTarget ??= DOM.isHTMLElement(selectContainer.firstElementChild) ? selectContainer.firstElementChild : undefined;
			this.renderDisposables.add(select.onDidSelect(event => void this.writeConfiguration(target, [{ keyPath: setting.keyPath, value: setting.options![event.index].value }])));
		} else if (setting.type === 'boolean') {
			const checkbox = this.renderDisposables.add(new Checkbox(setting.title, this.readValue(setting) === true, defaultCheckboxStyles));
			if (this.configurationBusy) { checkbox.disable(); }
			const checkboxContainer = DOM.append(row, DOM.$('.agent-global-configuration-settings-checkbox'));
			checkboxContainer.appendChild(checkbox.domNode);
			this.focusTarget ??= checkbox.domNode;
			this.renderDisposables.add(checkbox.onChange(() => void this.writeConfiguration(target, [{ keyPath: setting.keyPath, value: checkbox.checked }])));
		} else {
			this.renderInlineTextInput(row, setting, target);
		}
	}

	private renderInlineTextInput(row: HTMLElement, setting: AgentGlobalConfigurationSetting, target: IAgentGlobalConfigurationTarget): void {
		const input = DOM.append(row, DOM.$('input.agent-global-configuration-settings-input')) as HTMLInputElement;
		const initialValue = String(this.readValue(setting) ?? '');
		input.value = initialValue;
		input.placeholder = setting.placeholder ?? '';
		input.disabled = this.configurationBusy;
		this.focusTarget ??= input;
		const save = this.renderDisposables.add(new Button(DOM.append(row, DOM.$('.agent-global-configuration-settings-action')), { ...defaultButtonStyles, secondary: true }));
		save.label = setting.saveLabel ?? localize('agentGlobalConfigurationSettings.save', "Save");
		save.enabled = false;
		this.renderDisposables.add(DOM.addDisposableListener(input, DOM.EventType.INPUT, () => save.enabled = !this.configurationBusy && input.value !== initialValue));
		this.renderDisposables.add(save.onDidClick(() => void this.saveStringSetting(target, setting, input.value)));
	}

	private renderTextSetting(card: HTMLElement, setting: AgentGlobalConfigurationSetting, target: IAgentGlobalConfigurationTarget, multiline: boolean): void {
		const row = DOM.append(card, DOM.$('.agent-global-configuration-settings-text-row'));
		DOM.append(row, DOM.$('.agent-global-configuration-settings-label')).textContent = setting.title;
		DOM.append(row, DOM.$('.agent-global-configuration-settings-description')).textContent = setting.description;
		const input = multiline
			? DOM.append(row, DOM.$('textarea.agent-global-configuration-settings-text')) as HTMLTextAreaElement
			: DOM.append(row, DOM.$('input.agent-global-configuration-settings-input')) as HTMLInputElement;
		const initialValue = String(this.readValue(setting) ?? '');
		input.value = initialValue;
		input.placeholder = setting.placeholder ?? '';
		input.disabled = this.configurationBusy;
		this.focusTarget ??= input;
		const actions = DOM.append(row, DOM.$('.agent-global-configuration-settings-actions'));
		const save = this.renderDisposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true }));
		save.label = setting.saveLabel ?? localize('agentGlobalConfigurationSettings.save', "Save");
		save.enabled = false;
		this.renderDisposables.add(DOM.addDisposableListener(input, DOM.EventType.INPUT, () => save.enabled = !this.configurationBusy && input.value !== initialValue));
		this.renderDisposables.add(save.onDidClick(() => void this.saveStringSetting(target, setting, input.value)));
	}

	private saveStringSetting(target: IAgentGlobalConfigurationTarget, setting: AgentGlobalConfigurationSetting, value: string): void {
		const normalized = value.trim();
		void this.writeConfiguration(target, [normalized
			? { keyPath: setting.keyPath, value: normalized }
			: { keyPath: setting.clearKeyPath ?? setting.keyPath, value: null }]);
	}

	private renderConfigurationFile(content: HTMLElement, capability: AgentGlobalConfigurationCapability, configuration: AgentGlobalConfigurationState): void {
		const file = capability.configurationFile;
		if (!file) { return; }
		const card = this.renderSection(content, file.title, file.description);
		const row = DOM.append(card, DOM.$('.agent-global-configuration-settings-row'));
		const labels = DOM.append(row, DOM.$('.agent-global-configuration-settings-labels'));
		DOM.append(labels, DOM.$('.agent-global-configuration-settings-label')).textContent = file.openLabel;
		if (file.documentationUrl && file.documentationLabel) {
			const description = DOM.append(labels, DOM.$('.agent-global-configuration-settings-description'));
			this.renderDisposables.add(new Link(description, { label: file.documentationLabel, href: file.documentationUrl }, {}, this.hoverService, this.openerService));
		}
		const action = this.renderDisposables.add(new Button(DOM.append(row, DOM.$('.agent-global-configuration-settings-action')), { ...defaultButtonStyles, secondary: true }));
		action.label = file.openLabel;
		this.renderDisposables.add(action.onDidClick(() => this.editorService.openEditor({ resource: URI.parse(configuration.file), options: { pinned: true } })));
	}

	private renderStatus(content: HTMLElement): void {
		const card = this.renderSection(content, localize('agentGlobalConfigurationSettings.statusTitle', "Agent configuration"), '');
		const unavailable = !this.target || !this.capability;
		const error = unavailable || !!this.configurationError;
		const message = !this.target
			? localize('agentGlobalConfigurationSettings.disconnected', "The agent host is not connected.")
			: !this.capability
				? localize('agentGlobalConfigurationSettings.unsupported', "This agent does not expose configurable global settings.")
				: this.configurationError
					? localize('agentGlobalConfigurationSettings.error', "Agent configuration could not be loaded: {0}", this.configurationError.message)
					: localize('agentGlobalConfigurationSettings.loading', "Loading agent configuration…");
		const status = DOM.append(card, DOM.$('.agent-global-configuration-settings-status'));
		status.classList.toggle('error', error);
		status.setAttribute('role', error ? 'alert' : 'status');
		status.appendChild(DOM.$(`span${ThemeIcon.asCSSSelector(error ? Codicon.error : ThemeIcon.modify(Codicon.loading, 'spin'))}`));
		DOM.append(status, DOM.$('span')).textContent = message;
	}

	private readValue(setting: AgentGlobalConfigurationSetting): AgentGlobalConfigurationValue | undefined {
		return this.configuration?.values[setting.keyPath] ?? setting.default;
	}

	private async loadConfiguration(target: IAgentGlobalConfigurationTarget | undefined, capability: AgentGlobalConfigurationCapability | undefined): Promise<void> {
		const loadId = ++this.configurationLoadId;
		if (!target || !capability) {
			this.render();
			return;
		}
		try {
			const configuration = await target.readAgentGlobalConfiguration(this.agentProvider, this.keyPaths);
			if (loadId !== this.configurationLoadId) { return; }
			this.configuration = configuration;
			this.configurationError = undefined;
		} catch (error) {
			if (loadId !== this.configurationLoadId) { return; }
			this.configurationError = error instanceof Error ? error : new Error(String(error));
		}
		this.render();
	}

	private async writeConfiguration(target: IAgentGlobalConfigurationTarget, edits: readonly AgentGlobalConfigurationEdit[]): Promise<void> {
		if (this.configurationBusy) { return; }
		this.configurationBusy = true;
		this.render();
		try {
			await target.writeAgentGlobalConfiguration(this.agentProvider, edits, this.configuration?.version);
			this.configuration = await target.readAgentGlobalConfiguration(this.agentProvider, this.keyPaths);
		} catch (error) {
			this.notificationService.error(error);
			await this.loadConfiguration(target, this.capability);
		} finally {
			this.configurationBusy = false;
			this.render();
		}
	}
}
