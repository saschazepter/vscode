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
import { IGitRepository } from '../../../../workbench/contrib/git/common/gitService.js';
import { INewSession } from './newSession.js';

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

// #region --- Session Target Picker ---

/**
 * A self-contained widget for selecting the session target (Local vs Cloud).
 * Encapsulates state, events, and rendering. Can be placed anywhere in the view.
 */
export class SessionTargetPicker extends Disposable {

	private _selectedTarget: AgentSessionProviders;
	private _allowedTargets: AgentSessionProviders[];

	private readonly _onDidChangeTarget = this._register(new Emitter<AgentSessionProviders>());
	readonly onDidChangeTarget: Event<AgentSessionProviders> = this._onDidChangeTarget.event;

	private readonly _renderDisposables = this._register(new DisposableStore());
	private _container: HTMLElement | undefined;

	get selectedTarget(): AgentSessionProviders {
		return this._selectedTarget;
	}

	constructor(
		allowedTargets: AgentSessionProviders[],
		defaultTarget: AgentSessionProviders,
	) {
		super();
		this._allowedTargets = allowedTargets;
		this._selectedTarget = allowedTargets.includes(defaultTarget)
			? defaultTarget
			: allowedTargets[0];
	}

	/**
	 * Renders the target radio (Local / Cloud) into the given container.
	 */
	render(container: HTMLElement): void {
		this._container = container;
		this._renderRadio();
	}

	updateAllowedTargets(targets: AgentSessionProviders[]): void {
		this._allowedTargets = targets;
		if (!targets.includes(this._selectedTarget)) {
			this._selectedTarget = targets[0];
			this._onDidChangeTarget.fire(this._selectedTarget);
		}
		if (this._container) {
			this._renderRadio();
		}
	}

	private _renderRadio(): void {
		if (!this._container) {
			return;
		}

		this._renderDisposables.clear();
		dom.clearNode(this._container);

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
		this._renderDisposables.add(radio);
		this._container.appendChild(radio.domNode);

		if (activeIndex >= 0) {
			radio.setActiveItem(activeIndex);
		}

		this._renderDisposables.add(radio.onDidSelect(index => {
			const target = targets[index];
			if (this._selectedTarget !== target) {
				this._selectedTarget = target;
				this._onDidChangeTarget.fire(target);
			}
		}));
	}
}

function getTargetLabel(provider: AgentSessionProviders): string {
	switch (provider) {
		case AgentSessionProviders.Local:
		case AgentSessionProviders.Background:
			return localize('chat.session.providerLabel.local', "Local");
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

// #endregion

// #region --- Isolation Mode Picker ---

export type IsolationMode = 'worktree' | 'folder';

/**
 * A self-contained widget for selecting the isolation mode (Worktree vs Folder).
 * Encapsulates state, events, and rendering. Can be placed anywhere in the view.
 */
export class IsolationModePicker extends Disposable {

	private _isolationMode: IsolationMode = 'worktree';
	private _newSession: INewSession | undefined;
	private _repository: IGitRepository | undefined;

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
	 * Sets the pending session that this picker writes to.
	 */
	setNewSession(session: INewSession | undefined): void {
		this._newSession = session;
	}

	/**
	 * Sets the git repository. When undefined, worktree option is hidden
	 * and isolation mode falls back to 'folder'.
	 */
	setRepository(repository: IGitRepository | undefined): void {
		this._repository = repository;
		if (!repository && this._isolationMode === 'worktree') {
			this._setMode('folder');
		}
		this._renderDropdown();
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

		// If no repository, only show "Folder" without a dropdown
		if (!this._repository) {
			const label = dom.append(this._dropdownContainer, dom.$('span.sessions-chat-dropdown-label'));
			label.textContent = localize('isolationMode.folder', "Folder");
			return;
		}

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
			this._newSession?.setIsolationMode(mode);
			this._onDidChange.fire(mode);
			this._renderDropdown();
		}
	}
}

// #endregion

// #region --- Branch Picker ---

/**
 * A self-contained widget for selecting a git branch.
 * Uses `IGitRepository.getRefs` to list local branches.
 * Writes the selected branch to the new session object.
 */
export class BranchPicker extends Disposable {

	private _selectedBranch: string | undefined;
	private _newSession: INewSession | undefined;
	private _repository: IGitRepository | undefined;
	private _branches: string[] = [];

	private readonly _onDidChange = this._register(new Emitter<string | undefined>());
	readonly onDidChange: Event<string | undefined> = this._onDidChange.event;

	private readonly _renderDisposables = this._register(new DisposableStore());
	private _container: HTMLElement | undefined;
	private _dropdownContainer: HTMLElement | undefined;

	get selectedBranch(): string | undefined {
		return this._selectedBranch;
	}

	constructor(
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super();
	}

	/**
	 * Sets the new session that this picker writes to.
	 */
	setNewSession(session: INewSession | undefined): void {
		this._newSession = session;
	}

	/**
	 * Sets the git repository and loads its branches.
	 * When undefined, the picker is hidden.
	 */
	async setRepository(repository: IGitRepository | undefined): Promise<void> {
		this._repository = repository;
		this._branches = [];
		this._selectedBranch = undefined;

		if (repository) {
			const refs = await repository.getRefs({ pattern: 'refs/heads' });
			this._branches = refs
				.map(ref => ref.name)
				.filter((name): name is string => !!name);
		}

		this.setVisible(!!repository && this._branches.length > 0);
		this._renderDropdown();
	}

	/**
	 * Renders the branch picker dropdown into the given container.
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

		if (!this._repository || this._branches.length === 0) {
			return;
		}

		const currentLabel = this._selectedBranch ?? localize('branchPicker.select', "Branch");
		const branchAction = toAction({ id: 'branchPicker', label: currentLabel, run: () => { } });
		const branchDropdown = this._renderDisposables.add(new LabeledDropdownMenuActionViewItem(
			branchAction,
			{
				getActions: () => this._branches.map(branch => toAction({
					id: `branch.${branch}`,
					label: branch,
					checked: this._selectedBranch === branch,
					run: () => this._selectBranch(branch),
				})),
			},
			this.contextMenuService,
			{ classNames: [...ThemeIcon.asClassNameArray(Codicon.gitBranch)] }
		));
		const slot = dom.append(this._dropdownContainer, dom.$('.sessions-chat-picker-slot'));
		branchDropdown.render(slot);
	}

	private _selectBranch(branch: string): void {
		if (this._selectedBranch !== branch) {
			this._selectedBranch = branch;
			this._newSession?.setBranch(branch);
			this._onDidChange.fire(branch);
			this._renderDropdown();
		}
	}
}

// #endregion
