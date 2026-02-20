/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { toAction } from '../../../../base/common/actions.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownActionViewItem.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';

/**
 * A dropdown menu action item that shows an icon, a text label, and a chevron.
 */
class LabeledDropdownMenuActionViewItem extends DropdownMenuActionViewItem {
	protected override renderLabel(element: HTMLElement): null {
		const classNames = typeof this.options.classNames === 'string'
			? this.options.classNames.split(/\s+/g).filter(s => !!s)
			: (this.options.classNames ?? []);
		if (classNames.length > 0) {
			const icon = dom.append(element, dom.$('span'));
			icon.classList.add('codicon', ...classNames);
		}

		const label = dom.append(element, dom.$('span.sessions-chat-dropdown-label'));
		label.textContent = this._action.label;

		dom.append(element, renderIcon(Codicon.chevronDown));

		return null;
	}
}

export type IsolationMode = 'worktree' | 'folder';

/**
 * A self-contained widget for selecting the isolation mode (Worktree vs Folder).
 * Encapsulates state, events, and rendering. Can be placed anywhere in the view.
 */
export class IsolationModePicker extends Disposable {

	private _isolationMode: IsolationMode = 'worktree';

	private readonly _onDidChange = this._register(new Emitter<IsolationMode>());
	readonly onDidChange: Event<IsolationMode> = this._onDidChange.event;

	private readonly _renderDisposables = this._register(new DisposableStore());
	private _container: HTMLElement | undefined;
	private _dropdownContainer: HTMLElement | undefined;

	get isolationMode(): IsolationMode {
		return this._isolationMode;
	}

	constructor(
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super();
	}

	/**
	 * Renders the isolation mode dropdown into the given container.
	 */
	render(container: HTMLElement): void {
		this._container = container;
		this._dropdownContainer = dom.append(container, dom.$('.sessions-chat-local-mode-left'));
		this._renderDropdown();
	}

	/**
	 * Shows or hides the picker.
	 */
	setVisible(visible: boolean): void {
		if (this._container) {
			this._container.style.visibility = visible ? '' : 'hidden';
		}
	}

	private _renderDropdown(): void {
		if (!this._dropdownContainer) {
			return;
		}

		this._renderDisposables.clear();
		dom.clearNode(this._dropdownContainer);

		const modeLabel = this._isolationMode === 'worktree'
			? localize('isolationMode.worktree', "Worktree")
			: localize('isolationMode.folder', "Folder");
		const modeIcon = this._isolationMode === 'worktree' ? Codicon.worktree : Codicon.folder;

		const modeAction = toAction({ id: 'isolationMode', label: modeLabel, run: () => { } });
		const modeDropdown = this._renderDisposables.add(new LabeledDropdownMenuActionViewItem(
			modeAction,
			{
				getActions: () => [
					toAction({
						id: 'isolationMode.worktree',
						label: localize('isolationMode.worktree', "Worktree"),
						checked: this._isolationMode === 'worktree',
						run: () => this._setMode('worktree'),
					}),
					toAction({
						id: 'isolationMode.folder',
						label: localize('isolationMode.folder', "Folder"),
						checked: this._isolationMode === 'folder',
						run: () => this._setMode('folder'),
					}),
				],
			},
			this.contextMenuService,
			{ classNames: [...ThemeIcon.asClassNameArray(modeIcon)] }
		));
		const modeSlot = dom.append(this._dropdownContainer, dom.$('.sessions-chat-picker-slot'));
		modeDropdown.render(modeSlot);
	}

	private _setMode(mode: IsolationMode): void {
		if (this._isolationMode !== mode) {
			this._isolationMode = mode;
			this._onDidChange.fire(mode);
			this._renderDropdown();
		}
	}
}
