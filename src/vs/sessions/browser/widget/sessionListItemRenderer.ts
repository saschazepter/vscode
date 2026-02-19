/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../base/browser/dom.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { formatRelativeTime } from '../../common/sessionTimeFormatting.js';
import { type ISessionListItem } from '../../common/sessionListItem.js';

const $ = DOM.$;

export interface IRenderedSessionListItem {
	readonly element: HTMLElement;
	readonly disposables: DisposableStore;
}

/**
 * Render a single {@link ISessionListItem} as a DOM element in the unified sessions list.
 *
 * @param container Parent element to append the item to.
 * @param item The unified list item to render.
 * @param isSelected Whether this item is currently selected.
 * @param onSelect Callback invoked when the item is clicked/activated.
 * @returns The rendered element and its disposables.
 */
export function renderSessionListItem(
	container: HTMLElement,
	item: ISessionListItem,
	isSelected: boolean,
	onSelect: () => void,
): IRenderedSessionListItem {
	const disposables = new DisposableStore();

	const el = DOM.append(container, $('.sdk-session-item'));
	el.tabIndex = 0;
	el.setAttribute('role', 'listitem');
	el.setAttribute('data-item-id', item.id);
	el.setAttribute('data-item-kind', String(item.kind));
	if (isSelected) {
		el.classList.add('selected');
	}

	// Status icon
	const icon = DOM.append(el, $('span.sdk-session-icon'));
	icon.classList.add(...ThemeIcon.asClassNameArray(item.status.icon));

	// Details (label + description)
	const details = DOM.append(el, $('span.sdk-session-details'));
	const label = DOM.append(details, $('span.sdk-session-label'));
	label.textContent = item.label;

	if (item.description) {
		const pathEl = DOM.append(details, $('span.sdk-session-path'));
		pathEl.textContent = item.description;
	}

	// Timestamp
	if (item.timestamp > 0) {
		const timeEl = DOM.append(el, $('span.sdk-session-time'));
		timeEl.textContent = formatRelativeTime(new Date(item.timestamp));
	}

	// Status badge (only for items that have a status label)
	if (item.status.label) {
		const badge = DOM.append(el, $('span'));
		badge.style.cssText = 'font-size:10px;padding:1px 6px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);white-space:nowrap;flex-shrink:0;';
		badge.textContent = item.status.label;
	}

	// Action button (delete for SDK sessions, archive for cloud tasks)
	if (item.action) {
		const actions = DOM.append(el, $('span.sdk-session-actions'));
		const actionBtn = DOM.append(actions, $('button.sdk-session-action-btn')) as HTMLButtonElement;
		actionBtn.title = item.action.tooltip;
		DOM.append(actionBtn, $('span')).classList.add(...ThemeIcon.asClassNameArray(item.action.icon));
		const action = item.action;
		disposables.add(DOM.addDisposableListener(actionBtn, 'click', (e) => {
			DOM.EventHelper.stop(e);
			action.execute();
		}));
	}

	// Click/keyboard handlers
	disposables.add(DOM.addDisposableListener(el, 'click', onSelect));
	disposables.add(DOM.addDisposableListener(el, 'keydown', (e: KeyboardEvent) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onSelect();
		}
	}));

	return { element: el, disposables };
}
