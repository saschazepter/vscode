/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/hostFilter.css';
import * as dom from '../../../../base/browser/dom.js';
import { renderLabelWithIcons } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { BaseActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Action, IAction, Separator } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { AgentHostFilterConnectionStatus, ALL_HOSTS_FILTER, IAgentHostFilterEntry, IAgentHostFilterService } from '../common/agentHostFilter.js';

/**
 * Dropdown button shown in the Agent Sessions titlebar (next to the toggle
 * sidebar button) that indicates the host the workbench is currently
 * scoped to, and lets the user pick a different host or "All Hosts".
 *
 * The pill also surfaces connection status for the selected host via a
 * leading indicator icon:
 *  - Connected    → green `debug-connected`
 *  - Connecting   → non-interactive `debug-connected` in muted state
 *  - Disconnected → clickable `debug-disconnect` that triggers a connect
 */
export class HostFilterActionViewItem extends BaseActionViewItem {

	private _statusElement: HTMLElement | undefined;
	private _labelElement: HTMLElement | undefined;
	private _statusHoverDisposable: { dispose(): void } | undefined;

	constructor(
		action: IAction,
		@IAgentHostFilterService private readonly _filterService: IAgentHostFilterService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		super(undefined, action);

		this._register(this._filterService.onDidChange(() => this._update()));
	}

	override render(container: HTMLElement): void {
		super.render(container);

		if (!this.element) {
			return;
		}

		this.element.classList.add('agent-host-filter');
		this.element.tabIndex = 0;
		this.element.role = 'button';
		this.element.setAttribute('aria-haspopup', 'menu');

		// Connection status indicator — shown only when a specific host is selected.
		this._statusElement = dom.append(this.element, dom.$('span.agent-host-filter-status'));

		// Leading icon (generic remote glyph)
		const iconEl = dom.append(this.element, dom.$('span.agent-host-filter-icon'));
		iconEl.append(...renderLabelWithIcons(`$(${Codicon.remote.id})`));

		// Label
		this._labelElement = dom.append(this.element, dom.$('span.agent-host-filter-label'));

		// Chevron
		const chevronEl = dom.append(this.element, dom.$('span.agent-host-filter-chevron'));
		chevronEl.append(...renderLabelWithIcons(`$(${Codicon.chevronDown.id})`));

		const hoverDelegate = getDefaultHoverDelegate('element');
		this._register(this._hoverService.setupManagedHover(hoverDelegate, this.element,
			() => localize('agentHostFilter.hover', "Change the host the sessions list is scoped to")));

		this._register(dom.addDisposableListener(this.element, dom.EventType.CLICK, e => {
			// Clicks on the status indicator are handled separately.
			if (this._statusElement && dom.isHTMLElement(e.target) && this._statusElement.contains(e.target)) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this._showMenu(e);
		}));

		this._register(dom.addDisposableListener(this.element, dom.EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				e.preventDefault();
				e.stopPropagation();
				this._showMenu(e);
			}
		}));

		this._register(dom.addDisposableListener(this._statusElement, dom.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this._onStatusClick();
		}));

		this._update();
	}

	private _update(): void {
		if (!this._labelElement || !this.element || !this._statusElement) {
			return;
		}

		const selectedId = this._filterService.selectedProviderId;
		const selected = selectedId === ALL_HOSTS_FILTER
			? undefined
			: this._filterService.hosts.find(h => h.providerId === selectedId);

		const text = selected ? selected.label : localize('agentHostFilter.all', "All Hosts");
		this._labelElement.textContent = text;

		this.element.setAttribute('aria-label', selected
			? localize('agentHostFilter.aria.selected', "Sessions scoped to host {0}", selected.label)
			: localize('agentHostFilter.aria.all', "Sessions from all hosts"));

		this.element.classList.toggle('all-hosts', !selected);

		this._updateStatus(selected);
	}

	private _updateStatus(selected: IAgentHostFilterEntry | undefined): void {
		if (!this._statusElement) {
			return;
		}

		// Reset
		dom.clearNode(this._statusElement);
		this._statusElement.classList.remove('connected', 'connecting', 'disconnected', 'clickable');
		this._statusElement.removeAttribute('aria-disabled');
		this._statusElement.removeAttribute('role');
		this._statusElement.removeAttribute('tabindex');
		this._statusHoverDisposable?.dispose();
		this._statusHoverDisposable = undefined;

		if (!selected) {
			this._statusElement.style.display = 'none';
			return;
		}
		this._statusElement.style.display = '';

		let iconId: string;
		let hoverText: string;
		switch (selected.status) {
			case AgentHostFilterConnectionStatus.Connected:
				iconId = Codicon.debugConnected.id;
				this._statusElement.classList.add('connected');
				hoverText = localize('agentHostFilter.status.connected', "Connected to {0}", selected.label);
				break;
			case AgentHostFilterConnectionStatus.Connecting:
				iconId = Codicon.debugConnected.id;
				this._statusElement.classList.add('connecting');
				this._statusElement.setAttribute('aria-disabled', 'true');
				hoverText = localize('agentHostFilter.status.connecting', "Connecting to {0}…", selected.label);
				break;
			case AgentHostFilterConnectionStatus.Disconnected:
			default:
				iconId = Codicon.debugDisconnect.id;
				this._statusElement.classList.add('disconnected', 'clickable');
				this._statusElement.setAttribute('role', 'button');
				this._statusElement.setAttribute('tabindex', '0');
				hoverText = localize('agentHostFilter.status.disconnected', "Disconnected from {0}. Click to connect.", selected.label);
				break;
		}
		this._statusElement.append(...renderLabelWithIcons(`$(${iconId})`));
		this._statusElement.setAttribute('aria-label', hoverText);

		const hoverDelegate = getDefaultHoverDelegate('element');
		this._statusHoverDisposable = this._hoverService.setupManagedHover(hoverDelegate, this._statusElement, () => hoverText);
		this._register(this._statusHoverDisposable);
	}

	private _onStatusClick(): void {
		const selectedId = this._filterService.selectedProviderId;
		if (selectedId === ALL_HOSTS_FILTER) {
			return;
		}
		const host = this._filterService.hosts.find(h => h.providerId === selectedId);
		if (!host || host.status !== AgentHostFilterConnectionStatus.Disconnected) {
			return;
		}
		this._filterService.reconnect(selectedId);
	}

	private _showMenu(e: MouseEvent | KeyboardEvent): void {
		if (!this.element) {
			return;
		}

		const hosts = this._filterService.hosts;
		const selectedId = this._filterService.selectedProviderId;

		const actions: IAction[] = [];

		const allAction = new Action(
			'agentHostFilter.all',
			localize('agentHostFilter.all', "All Hosts"),
			selectedId === ALL_HOSTS_FILTER ? 'codicon codicon-check' : undefined,
			true,
			async () => this._filterService.setSelectedProviderId(ALL_HOSTS_FILTER),
		);
		actions.push(allAction);

		if (hosts.length > 0) {
			actions.push(new Separator());
			for (const host of hosts) {
				const label = host.status === AgentHostFilterConnectionStatus.Connected
					? host.label
					: host.status === AgentHostFilterConnectionStatus.Connecting
						? localize('agentHostFilter.hostConnecting', "{0} (connecting…)", host.label)
						: localize('agentHostFilter.hostDisconnected', "{0} (disconnected)", host.label);
				actions.push(new Action(
					`agentHostFilter.host.${host.providerId}`,
					label,
					selectedId === host.providerId ? 'codicon codicon-check' : undefined,
					true,
					async () => this._filterService.setSelectedProviderId(host.providerId),
				));
			}
		}

		const anchor = dom.isMouseEvent(e)
			? new StandardMouseEvent(dom.getWindow(this.element), e)
			: this.element;

		this._contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
			domForShadowRoot: this.element,
		});
	}
}
