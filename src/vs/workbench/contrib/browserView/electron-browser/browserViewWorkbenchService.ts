/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserViewCommandId, BrowserViewStorageScope, IBrowserViewCreatedEvent, IBrowserViewOwner, IBrowserViewService, IBrowserViewState, ipcBrowserViewChannelName } from '../../../../platform/browserView/common/browserView.js';
import { IBrowserViewWorkbenchService, IBrowserViewModel, IKnownBrowserView, BrowserViewModel } from '../common/browserView.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { AUX_WINDOW_GROUP, IEditorService } from '../../../services/editor/common/editorService.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { BrowserEditorInput } from '../common/browserEditorInput.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';

/** Command IDs whose accelerators are shown in browser view context menus. */
const browserViewContextMenuCommands = [
	BrowserViewCommandId.GoBack,
	BrowserViewCommandId.GoForward,
	BrowserViewCommandId.Reload,
];

export class BrowserViewWorkbenchService extends Disposable implements IBrowserViewWorkbenchService {
	declare readonly _serviceBrand: undefined;

	private readonly _browserViewService: IBrowserViewService;
	private readonly _models = new Map<string, IBrowserViewModel>();
	private readonly _mainWindowId: number;

	private readonly _onDidChangeBrowserViews = this._register(new Emitter<void>());
	readonly onDidChangeBrowserViews: Event<void> = this._onDidChangeBrowserViews.event;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService
	) {
		super();
		const channel = mainProcessService.getChannel(ipcBrowserViewChannelName);
		this._browserViewService = ProxyChannel.toService<IBrowserViewService>(channel);
		this._mainWindowId = mainWindow.vscodeWindowId;

		this.sendKeybindings();
		this._register(this.keybindingService.onDidUpdateKeybindings(() => this.sendKeybindings()));

		// Eagerly create models for all views we already own.
		this._initializeExistingViews();

		// Listen for new browser views
		this._register(this._browserViewService.onDidCreateBrowserView(e => {
			if (e.info.owner.mainWindowId !== this._mainWindowId) {
				return; // Not for this window
			}

			// Eagerly create the model from the state we already have
			this._createModel(e.info.id, e.info.owner, e.info.state);

			this._openEditorForCreatedView(e);
		}));

		// Fire when browser editor inputs are opened or closed
		this._register(this.editorService.onDidEditorsChange((e) => {
			if (e.event.editor instanceof BrowserEditorInput) {
				this._onDidChangeBrowserViews.fire();
			}
		}));
	}

	getKnownBrowserViews(): IKnownBrowserView[] {
		const entries = new Map<string, IKnownBrowserView>();

		// Add editor inputs
		for (const editor of this.editorService.editors) {
			if (editor instanceof BrowserEditorInput) {
				entries.set(editor.id, { id: editor.id, editor: editor });
			}
		}

		// Add models
		for (const [id, model] of this._models) {
			const entry = entries.get(id);
			if (entry) {
				entries.set(id, { ...entry, model });
			}
		}

		return [...entries.values()];
	}

	async getOrCreateBrowserViewModel(id: string, initialState?: Partial<IBrowserViewState>): Promise<IBrowserViewModel> {
		const existing = this._models.get(id);
		if (existing) {
			return existing;
		}

		// View doesn't exist yet — create it via IPC and initialize the model
		const state = await this._browserViewService.getOrCreateBrowserView(
			id,
			{
				owner: this._getDefaultOwner(),
				scope: await this._resolveStorageScope(),
				initialState
			}
		);

		// Check again — the create event handler may have already created the model
		const existingAfterCreate = this._models.get(id);
		if (existingAfterCreate) {
			return existingAfterCreate;
		}

		return this._createModel(id, this._getDefaultOwner(), state);
	}

	getBrowserViewModel(id: string): IBrowserViewModel | undefined {
		return this._models.get(id);
	}

	async clearGlobalStorage(): Promise<void> {
		return this._browserViewService.clearGlobalStorage();
	}

	async clearWorkspaceStorage(): Promise<void> {
		const workspaceId = this.workspaceContextService.getWorkspace().id;
		return this._browserViewService.clearWorkspaceStorage(workspaceId);
	}

	private _getDefaultOwner(): IBrowserViewOwner {
		return { mainWindowId: this._mainWindowId };
	}

	private async _resolveStorageScope(): Promise<BrowserViewStorageScope> {
		const dataStorageSetting = this.configurationService.getValue<BrowserViewStorageScope>(
			'workbench.browser.dataStorage'
		) ?? BrowserViewStorageScope.Global;

		await this.workspaceTrustManagementService.workspaceTrustInitialized;

		const isWorkspaceUntrusted =
			this.workspaceContextService.getWorkbenchState() !== WorkbenchState.EMPTY &&
			!this.workspaceTrustManagementService.isWorkspaceTrusted();

		return isWorkspaceUntrusted ? BrowserViewStorageScope.Ephemeral : dataStorageSetting;
	}

	/**
	 * Fetch all views owned by this window from the main service and create
	 * models for them so they are available synchronously.
	 */
	private async _initializeExistingViews(): Promise<void> {
		const views = await this._browserViewService.getBrowserViews(this._mainWindowId);
		for (const info of views) {
			if (!this._models.has(info.id)) {
				this._createModel(info.id, info.owner, info.state);
			}
		}
	}

	private _createModel(id: string, owner: IBrowserViewOwner, state: IBrowserViewState): IBrowserViewModel {
		// Don't double-create
		const existing = this._models.get(id);
		if (existing) {
			return existing;
		}

		const model = this.instantiationService.createInstance(BrowserViewModel, id, owner, state, this._browserViewService);
		this._models.set(id, model);

		// Clean up model when disposed
		Event.once(model.onWillDispose)(() => {
			this._models.delete(id);
			this._onDidChangeBrowserViews.fire();
		});

		this._onDidChangeBrowserViews.fire();

		return model;
	}

	/**
	 * Open an editor tab for a newly created browser view.
	 */
	private _openEditorForCreatedView(e: IBrowserViewCreatedEvent): void {
		const opts = e.openOptions;
		const resource = BrowserViewUri.forId(e.info.id);

		// Resolve target group: auxiliary window, parent's group, or default
		let targetGroup: number | typeof AUX_WINDOW_GROUP | undefined;
		if (opts.auxiliaryWindow) {
			targetGroup = AUX_WINDOW_GROUP;
		} else if (opts.parentViewId) {
			targetGroup = this._findEditorGroupForView(opts.parentViewId);
		}

		void this.editorService.openEditor({
			resource,
			options: {
				inactive: opts.background,
				preserveFocus: opts.preserveFocus,
				pinned: opts.pinned,
				auxiliary: opts.auxiliaryWindow
					? { bounds: opts.auxiliaryWindow, compact: true }
					: undefined,
			}
		}, targetGroup);
	}

	/**
	 * Find the editor group that currently contains a browser view with the
	 * given ID, or undefined if not open in any group.
	 */
	private _findEditorGroupForView(viewId: string): number | undefined {
		for (const group of this.editorGroupsService.groups) {
			for (const editor of group.editors) {
				if (editor instanceof BrowserEditorInput && editor.id === viewId) {
					return group.id;
				}
			}
		}
		return undefined;
	}

	private sendKeybindings(): void {
		const keybindings: { [commandId: string]: string } = Object.create(null);
		for (const commandId of browserViewContextMenuCommands) {
			const binding = this.keybindingService.lookupKeybinding(commandId);
			const accelerator = binding?.getElectronAccelerator();
			if (accelerator) {
				keybindings[commandId] = accelerator;
			}
		}
		void this._browserViewService.updateKeybindings(keybindings);
	}
}
