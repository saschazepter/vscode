/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentHostSessionConfigPicker.css';
import * as dom from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { ActionListItemKind, IActionListDelegate, IActionListItem } from '../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { BaseActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Delayer } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AgentHostSessionConfigBranchNameHintKey } from '../../../../platform/agentHost/common/agentService.js';
import type { ISessionConfigPropertySchema, ISessionConfigValueItem } from '../../../../platform/agentHost/common/state/protocol/commands.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Menus } from '../../../browser/menus.js';
import { ActiveSessionProviderIdContext } from '../../../common/contextkeys.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { ISessionsProvider } from '../../../services/sessions/common/sessionsProvider.js';

const IsActiveSessionRemoteAgentHost = ContextKeyExpr.regex(ActiveSessionProviderIdContext.key, /^agenthost-/);
const IsActiveSessionLocalAgentHost = ContextKeyExpr.equals(ActiveSessionProviderIdContext.key, 'local-agent-host');

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.agentHost.sessionConfigPicker',
			title: localize2('agentHostSessionConfigPicker', "Session Configuration"),
			f1: false,
			menu: [{
				id: Menus.NewSessionRepositoryConfig,
				group: 'navigation',
				order: 3,
				when: ContextKeyExpr.or(IsActiveSessionLocalAgentHost, IsActiveSessionRemoteAgentHost),
			}],
		});
	}

	override async run(): Promise<void> { }
});

interface IConfigPickerItem {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
	readonly icon?: string;
}

function toActionItems(items: readonly IConfigPickerItem[], currentValue: string | undefined): IActionListItem<IConfigPickerItem>[] {
	return items.map(item => ({
		kind: ActionListItemKind.Action,
		label: item.label,
		description: item.description,
		group: { title: '', icon: item.icon ? ThemeIcon.fromId(item.icon) : undefined },
		item: { ...item, label: item.value === currentValue ? `${item.label} ${localize('selected', "(Selected)")}` : item.label },
	}));
}

function renderPickerTrigger(slot: HTMLElement, disabled: boolean, disposables: DisposableStore, onOpen: () => void): HTMLElement {
	const trigger = dom.append(slot, disabled ? dom.$('span.action-label') : dom.$('a.action-label'));
	if (disabled) {
		trigger.setAttribute('aria-readonly', 'true');
	} else {
		trigger.role = 'button';
		trigger.tabIndex = 0;
		trigger.setAttribute('aria-haspopup', 'listbox');
		disposables.add(dom.addDisposableListener(trigger, dom.EventType.CLICK, e => {
			dom.EventHelper.stop(e, true);
			onOpen();
		}));
		disposables.add(dom.addDisposableListener(trigger, dom.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				dom.EventHelper.stop(e, true);
				onOpen();
			}
		}));
	}
	slot.classList.toggle('disabled', disabled);

	return trigger;
}

class AgentHostSessionConfigPicker extends Disposable {

	private readonly _renderDisposables = this._register(new DisposableStore());
	private readonly _providerListeners = this._register(new DisposableMap<string>());
	private readonly _filterDelayer = this._register(new Delayer<readonly IActionListItem<IConfigPickerItem>[]>(200));
	private _container: HTMLElement | undefined;

	constructor(
		@IActionWidgetService private readonly _actionWidgetService: IActionWidgetService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
	) {
		super();

		this._register(autorun(reader => {
			const session = this._sessionsManagementService.activeSession.read(reader);
			if (session) {
				session.loading.read(reader);
			}
			this._renderConfigPickers();
		}));

		this._register(this._sessionsProvidersService.onDidChangeProviders(e => {
			for (const provider of e.removed) {
				this._providerListeners.deleteAndDispose(provider.id);
			}
			this._watchProviders(e.added);
			this._renderConfigPickers();
		}));
		this._watchProviders(this._sessionsProvidersService.getProviders());
	}

	private _watchProviders(providers: readonly ISessionsProvider[]): void {
		for (const provider of providers) {
			if (!provider.onDidChangeSessionConfig || this._providerListeners.has(provider.id)) {
				continue;
			}
			this._providerListeners.set(provider.id, provider.onDidChangeSessionConfig(() => this._renderConfigPickers()));
		}
	}

	render(container: HTMLElement): void {
		this._container = dom.append(container, dom.$('.sessions-chat-agent-host-config'));
		this._renderConfigPickers();
	}

	private _renderConfigPickers(): void {
		if (!this._container) {
			return;
		}

		this._renderDisposables.clear();
		dom.clearNode(this._container);

		const session = this._sessionsManagementService.activeSession.get();
		const provider = session ? this._getProvider(session.providerId) : undefined;
		const resolvedConfig = session && provider?.getSessionConfig?.(session.sessionId);
		if (!session || !provider || !resolvedConfig) {
			return;
		}

		for (const [property, schema] of Object.entries(resolvedConfig.schema.properties)) {
			if (property === AgentHostSessionConfigBranchNameHintKey) {
				continue;
			}
			const value = resolvedConfig.values[property] ?? schema.default;
			const slot = dom.append(this._container, dom.$('.sessions-chat-picker-slot'));
			const trigger = renderPickerTrigger(slot, !!schema.readOnly, this._renderDisposables, () => this._showPicker(provider, session.sessionId, property, schema, trigger));
			this._renderTrigger(trigger, schema, value);
		}
	}

	private _renderTrigger(trigger: HTMLElement, schema: ISessionConfigPropertySchema, value: string | undefined): void {
		dom.clearNode(trigger);
		const icon = this._getIcon(schema, value);
		if (icon) {
			dom.append(trigger, renderIcon(ThemeIcon.fromId(icon)));
		}
		const labelSpan = dom.append(trigger, dom.$('span.sessions-chat-dropdown-label'));
		const label = this._getLabel(schema, value);
		labelSpan.textContent = label;
		trigger.setAttribute('aria-label', schema.readOnly
			? localize('agentHostSessionConfig.triggerAriaReadOnly', "{0}: {1}, Read-Only", schema.title, label)
			: localize('agentHostSessionConfig.triggerAria', "{0}: {1}", schema.title, label));
		if (!schema.readOnly) {
			dom.append(trigger, renderIcon(Codicon.chevronDown));
		}
	}

	private async _showPicker(provider: ISessionsProvider, sessionId: string, property: string, schema: ISessionConfigPropertySchema, trigger: HTMLElement): Promise<void> {
		if (schema.readOnly || this._actionWidgetService.isVisible) {
			return;
		}
		const items = await this._getItems(provider, sessionId, property, schema);
		if (items.length === 0) {
			return;
		}

		const currentValue = provider.getSessionConfig?.(sessionId)?.values[property];
		const actionItems = toActionItems(items, currentValue);

		const delegate: IActionListDelegate<IConfigPickerItem> = {
			onSelect: item => {
				this._actionWidgetService.hide();
				provider.setSessionConfigValue?.(sessionId, property, item.value).catch(() => { /* best-effort */ });
			},
			onFilter: schema.enumDynamic && provider.getSessionConfigCompletions
				? query => this._filterDelayer.trigger(async () => toActionItems(await this._getItems(provider, sessionId, property, schema, query), provider.getSessionConfig?.(sessionId)?.values[property]))
				: undefined,
			onHide: () => trigger.focus(),
		};

		this._actionWidgetService.show<IConfigPickerItem>(
			`agentHostSessionConfig.${property}`,
			false,
			actionItems,
			delegate,
			trigger,
			undefined,
			[],
			{
				getAriaLabel: item => item.label ?? '',
				getWidgetAriaLabel: () => localize('agentHostSessionConfig.ariaLabel', "{0} Picker", schema.title),
			},
			actionItems.length > 10 ? { showFilter: true, filterPlaceholder: localize('agentHostSessionConfig.filter', "Filter options...") } : undefined,
		);
	}

	private async _getItems(provider: ISessionsProvider, sessionId: string, property: string, schema: ISessionConfigPropertySchema, query?: string): Promise<readonly IConfigPickerItem[]> {
		const dynamicItems = schema.enumDynamic && provider.getSessionConfigCompletions
			? await provider.getSessionConfigCompletions(sessionId, property, query)
			: undefined;
		if (dynamicItems?.length) {
			return dynamicItems.map(item => this._fromCompletionItem(item));
		}

		return (schema.enum ?? []).map((value, index) => ({
			value,
			label: schema.enumLabels?.[index] ?? value,
			description: schema.enumDescriptions?.[index],
			icon: schema.enumIcons?.[index],
		}));
	}

	private _fromCompletionItem(item: ISessionConfigValueItem): IConfigPickerItem {
		return {
			value: item.value,
			label: item.label,
			description: item.description,
			icon: item.icon,
		};
	}

	private _getLabel(schema: ISessionConfigPropertySchema, value: string | undefined): string {
		if (typeof value === 'string') {
			const index = schema.enum?.indexOf(value) ?? -1;
			return index >= 0 ? schema.enumLabels?.[index] ?? value : value;
		}
		return schema.title;
	}

	private _getIcon(schema: ISessionConfigPropertySchema, value: string | undefined): string | undefined {
		if (typeof value !== 'string') {
			return undefined;
		}
		const index = schema.enum?.indexOf(value) ?? -1;
		return index >= 0 ? schema.enumIcons?.[index] : undefined;
	}

	private _getProvider(providerId: string): ISessionsProvider | undefined {
		return this._sessionsProvidersService.getProvider(providerId);
	}
}

class PickerActionViewItem extends BaseActionViewItem {
	constructor(private readonly _picker: AgentHostSessionConfigPicker) {
		super(undefined, { id: '', label: '', enabled: true, class: undefined, tooltip: '', run: () => { } });
	}

	override render(container: HTMLElement): void {
		this._picker.render(container);
	}

	override dispose(): void {
		this._picker.dispose();
		super.dispose();
	}
}

class AgentHostSessionConfigPickerContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.contrib.agentHostSessionConfigPicker';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(actionViewItemService.register(
			Menus.NewSessionRepositoryConfig,
			'sessions.agentHost.sessionConfigPicker',
			() => new PickerActionViewItem(instantiationService.createInstance(AgentHostSessionConfigPicker)),
		));
	}
}

registerWorkbenchContribution2(AgentHostSessionConfigPickerContribution.ID, AgentHostSessionConfigPickerContribution, WorkbenchPhase.AfterRestored);
