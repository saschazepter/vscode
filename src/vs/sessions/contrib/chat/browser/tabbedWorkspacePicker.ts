/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Radio } from '../../../../base/browser/ui/radio/radio.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { IRemoteAgentHostService } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { isAgentHostProvider } from '../../../common/agentHostSessionsProvider.js';
import { GITHUB_REMOTE_FILE_SCHEME, ISessionWorkspaceBrowseAction } from '../../../services/sessions/common/session.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { IWorkspaceSelection, WorkspacePicker } from './sessionWorkspacePicker.js';

type WorkspaceCategory = 'folders' | 'repositories' | 'remote';

interface ITabDescriptor {
	readonly id: WorkspaceCategory;
	readonly label: string;
}

const TABS: readonly ITabDescriptor[] = [
	{ id: 'folders', label: localize('tabbedPicker.folders', "Folders") },
	{ id: 'repositories', label: localize('tabbedPicker.repositories', "Repositories") },
	{ id: 'remote', label: localize('tabbedPicker.remote', "Remote") },
];

/**
 * Experimental tabbed variant of {@link WorkspacePicker}. Renders a Radio tab
 * bar above the picker list with three fixed categories: Folders,
 * Repositories and Tunnels. Each tab scopes the recents and browse actions
 * to its category so that the different sources stay visually separated,
 * mirroring the look of the agent quick input.
 *
 * Categorization rules:
 *   - **Remote**: any workspace whose owning provider is a remote agent host
 *     (tunnels, SSH hosts, etc.) plus that provider's browse actions.
 *   - **Repositories**: GitHub-backed workspaces (e.g.
 *     `github-remote-file://`) plus browse actions in the `repositories`
 *     group (or labelled "Repositories" when ungrouped).
 *   - **Folders**: anything else — local file:// folders and the providers'
 *     "Folders" browse actions.
 */
export class TabbedWorkspacePicker extends WorkspacePicker {

	private readonly _tabDisposables = this._register(new DisposableStore());
	private _activeTab: WorkspaceCategory = 'folders';
	private _userPickedTab = false;

	constructor(
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@IStorageService storageService: IStorageService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@ISessionsProvidersService sessionsProvidersService: ISessionsProvidersService,
		@IRemoteAgentHostService remoteAgentHostService: IRemoteAgentHostService,
		@IConfigurationService configurationService: IConfigurationService,
		@ICommandService commandService: ICommandService,
		@IWorkspacesService workspacesService: IWorkspacesService,
		@IMenuService menuService: IMenuService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(
			actionWidgetService,
			storageService,
			uriIdentityService,
			sessionsProvidersService,
			remoteAgentHostService,
			configurationService,
			commandService,
			workspacesService,
			menuService,
			contextKeyService,
			instantiationService,
		);
	}

	override showPicker(force = false): void {
		// Default the active tab to the category of the currently selected
		// workspace, but only until the user explicitly picks a tab — after
		// that, preserve their choice across re-shows (e.g. when switching
		// tabs hides and re-shows the widget).
		if (!this._userPickedTab && this.selectedProject) {
			this._activeTab = this._categorizeWorkspace(this.selectedProject) ?? this._activeTab;
		}
		this._applyTabFilter(this._activeTab);
		super.showPicker(force);
	}

	protected override _getPickerHeader(): HTMLElement | undefined {
		this._tabDisposables.clear();

		const header = dom.$('.sessions-workspace-picker-tabbar');
		const radio = this._tabDisposables.add(new Radio({
			items: TABS.map(t => ({ text: t.label, tooltip: t.label, isActive: t.id === this._activeTab })),
		}));
		header.appendChild(radio.domNode);

		this._tabDisposables.add(radio.onDidSelect(index => {
			const next = TABS[index];
			if (!next || next.id === this._activeTab) {
				return;
			}
			this._activeTab = next.id;
			this._userPickedTab = true;
			// Re-show in place. The underlying context view replaces its
			// content when `show()` is called while visible, so we avoid the
			// flicker that hide()+setTimeout(show) caused.
			this.showPicker(true);
		}));

		return header;
	}

	protected override _getPickerMinWidth(): number | undefined {
		// Fixed width across all tabs so switching doesn't shift the popup.
		return 360;
	}

	protected override _getPickerMaxWidth(): number | undefined {
		// Cap at the same value so long item labels truncate instead of
		// growing the popup.
		return 360;
	}

	protected override _includeManageSubmenu(): boolean {
		// Manage entries (remote provider list, Tunnels..., SSH..., etc.) are
		// only relevant when looking at remote agent hosts. Hide them in the
		// Folders and Repositories tabs.
		return this._activeTab === 'remote';
	}

	private _applyTabFilter(category: WorkspaceCategory): void {
		this._includeWorkspace = (selection: IWorkspaceSelection) => this._categorizeWorkspace(selection) === category;
		this._includeBrowseAction = (action: ISessionWorkspaceBrowseAction) => this._categorizeBrowseAction(action) === category;
	}

	private _categorizeWorkspace(selection: IWorkspaceSelection): WorkspaceCategory | undefined {
		if (this._isRemoteProvider(selection.providerId)) {
			return 'remote';
		}
		const uri = selection.workspace.repositories[0]?.uri;
		if (uri?.scheme === GITHUB_REMOTE_FILE_SCHEME) {
			return 'repositories';
		}
		if (uri?.scheme === Schemas.file) {
			return 'folders';
		}
		return 'folders';
	}

	private _categorizeBrowseAction(action: ISessionWorkspaceBrowseAction): WorkspaceCategory | undefined {
		if (this._isRemoteProvider(action.providerId)) {
			return 'remote';
		}
		if (action.group === 'repositories' || (!action.group && /^repositor/i.test(action.label))) {
			return 'repositories';
		}
		return 'folders';
	}

	private _isRemoteProvider(providerId: string): boolean {
		const provider = this.sessionsProvidersService.getProvider(providerId);
		return !!(provider && isAgentHostProvider(provider) && typeof provider.remoteAddress === 'string');
	}
}
