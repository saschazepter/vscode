/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { toAction } from '../../../../base/common/actions.js';
import { Radio } from '../../../../base/browser/ui/radio/radio.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownActionViewItem.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { AgentSessionProviders } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';

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
 * A self-contained widget that manages the session target (Folder vs Cloud)
 * and isolation mode (Worktree vs Folder) selection. Similar to FolderPicker,
 * it encapsulates all state, events, and rendering.
 */
export class SessionTargetPicker extends Disposable {

	private _selectedTarget: AgentSessionProviders;
	private _allowedTargets: AgentSessionProviders[];
	private _isolationMode: IsolationMode = 'worktree';

	private readonly _onDidChangeTarget = this._register(new Emitter<AgentSessionProviders>());
	readonly onDidChangeTarget: Event<AgentSessionProviders> = this._onDidChangeTarget.event;

	private readonly _onDidChangeIsolationMode = this._register(new Emitter<IsolationMode>());
	readonly onDidChangeIsolationMode: Event<IsolationMode> = this._onDidChangeIsolationMode.event;

	// Target radio rendering
	private readonly _targetDisposables = this._register(new DisposableStore());
	private _targetContainer: HTMLElement | undefined;

	// Isolation mode rendering
	private readonly _isolationDisposables = this._register(new DisposableStore());
	private _isolationContainer: HTMLElement | undefined;
	private _isolationDropdownContainer: HTMLElement | undefined;
	private _isolationPickersContainer: HTMLElement | undefined;

	get selectedTarget(): AgentSessionProviders {
		return this._selectedTarget;
	}

	get isolationMode(): IsolationMode {
		return this._isolationMode;
	}

	constructor(
		allowedTargets: AgentSessionProviders[],
		defaultTarget: AgentSessionProviders,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super();
		this._allowedTargets = allowedTargets;
		this._selectedTarget = allowedTargets.includes(defaultTarget)
			? defaultTarget
			: allowedTargets[0];
	}

	/**
	 * Renders the target radio (Folder / Cloud) into the given container.
	 */
	renderTargetRadio(container: HTMLElement): void {
		this._targetContainer = container;
		this._renderTargetRadio();
	}

	/**
	 * Renders the isolation mode picker (Worktree / Folder) into the given container.
	 * Returns the pickers sub-container where callers can append additional picker widgets.
	 */
	renderIsolationMode(container: HTMLElement): HTMLElement {
		this._isolationContainer = container;
		this._isolationDropdownContainer = dom.append(container, dom.$('.sessions-chat-local-mode-left'));
		dom.append(container, dom.$('.sessions-chat-local-mode-spacer'));
		this._isolationPickersContainer = dom.append(container, dom.$('.sessions-chat-local-mode-right'));
		this._renderIsolationMode();
		return this._isolationPickersContainer;
	}

	updateAllowedTargets(targets: AgentSessionProviders[]): void {
		this._allowedTargets = targets;
		if (!targets.includes(this._selectedTarget)) {
			this._selectedTarget = targets[0];
			this._onDidChangeTarget.fire(this._selectedTarget);
		}
		if (this._targetContainer) {
			this._renderTargetRadio();
		}
	}

	private _renderTargetRadio(): void {
		if (!this._targetContainer) {
			return;
		}

		this._targetDisposables.clear();
		dom.clearNode(this._targetContainer);

		if (this._allowedTargets.length === 0) {
			return;
		}

		const targets = [AgentSessionProviders.Background, AgentSessionProviders.Cloud].filter(t => this._allowedTargets.includes(t));
		const activeIndex = targets.indexOf(this._selectedTarget);

		const radio = new Radio({
			items: targets.map(target => ({
				text: getTargetLabel(target),
				isActive: target === this._selectedTarget,
			})),
		});
		this._targetDisposables.add(radio);
		this._targetContainer.appendChild(radio.domNode);

		if (activeIndex >= 0) {
			radio.setActiveItem(activeIndex);
		}

		this._targetDisposables.add(radio.onDidSelect(index => {
			const target = targets[index];
			if (this._selectedTarget !== target) {
				this._selectedTarget = target;
				this._onDidChangeTarget.fire(target);
				this._renderIsolationMode();
			}
		}));
	}

	private _renderIsolationMode(): void {
		if (!this._isolationContainer || !this._isolationDropdownContainer || !this._isolationPickersContainer) {
			return;
		}

		this._isolationDisposables.clear();
		dom.clearNode(this._isolationDropdownContainer);
		dom.clearNode(this._isolationPickersContainer);

		if (this._selectedTarget !== AgentSessionProviders.Background) {
			this._isolationContainer.style.visibility = 'hidden';
			return;
		}

		this._isolationContainer.style.visibility = '';

		const modeLabel = this._isolationMode === 'worktree'
			? localize('isolationMode.worktree', "Worktree")
			: localize('isolationMode.folder', "Folder");
		const modeIcon = this._isolationMode === 'worktree' ? Codicon.worktree : Codicon.folder;

		const modeAction = toAction({ id: 'isolationMode', label: modeLabel, run: () => { } });
		const modeDropdown = this._isolationDisposables.add(new LabeledDropdownMenuActionViewItem(
			modeAction,
			{
				getActions: () => [
					toAction({
						id: 'isolationMode.worktree',
						label: localize('isolationMode.worktree', "Worktree"),
						checked: this._isolationMode === 'worktree',
						run: () => this._setIsolationMode('worktree'),
					}),
					toAction({
						id: 'isolationMode.folder',
						label: localize('isolationMode.folder', "Folder"),
						checked: this._isolationMode === 'folder',
						run: () => this._setIsolationMode('folder'),
					}),
				],
			},
			this.contextMenuService,
			{ classNames: [...ThemeIcon.asClassNameArray(modeIcon)] }
		));
		const modeSlot = dom.append(this._isolationDropdownContainer, dom.$('.sessions-chat-picker-slot'));
		modeDropdown.render(modeSlot);
	}

	private _setIsolationMode(mode: IsolationMode): void {
		if (this._isolationMode !== mode) {
			this._isolationMode = mode;
			this._onDidChangeIsolationMode.fire(mode);
			this._renderIsolationMode();
		}
	}
}

function getTargetLabel(provider: AgentSessionProviders): string {
	switch (provider) {
		case AgentSessionProviders.Local:
		case AgentSessionProviders.Background:
			return localize('chat.session.providerLabel.folder', "Folder");
		case AgentSessionProviders.Cloud:
			return localize('chat.session.providerLabel.cloud', "Cloud");
		case AgentSessionProviders.Claude:
			return 'Claude';
		case AgentSessionProviders.Codex:
			return 'Codex';
		case AgentSessionProviders.Growth:
			return 'Growth';
	}
}
