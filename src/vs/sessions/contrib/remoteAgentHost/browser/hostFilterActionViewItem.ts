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
import { ALL_HOSTS_FILTER, IAgentHostFilterService } from '../common/agentHostFilter.js';

/**
 * Dropdown button shown in the Agent Sessions titlebar (next to the toggle
 * sidebar button) that indicates the host the workbench is currently
 * scoped to, and lets the user pick a different host or "All Hosts".
 */
export class HostFilterActionViewItem extends BaseActionViewItem {

	private _labelElement: HTMLElement | undefined;

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

		// Leading icon
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

		this._update();
	}

	private _update(): void {
		if (!this._labelElement || !this.element) {
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
				const label = host.connected
					? host.label
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
