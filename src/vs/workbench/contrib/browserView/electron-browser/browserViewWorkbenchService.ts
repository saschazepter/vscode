/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserViewCommandId, IBrowserViewService, ipcBrowserViewChannelName } from '../../../../platform/browserView/common/browserView.js';
import { IBrowserViewWorkbenchService, IBrowserViewModel, BrowserViewModel } from '../common/browserView.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { Event } from '../../../../base/common/event.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { ISharedProcessTunnelProxyService } from '../../../../platform/tunnel/common/sharedProcessTunnelProxyService.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { ILogService } from '../../../../platform/log/common/log.js';

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
	private _remoteProxyPromise: Promise<string | undefined> | undefined;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ISharedProcessTunnelProxyService private readonly tunnelProxyService: ISharedProcessTunnelProxyService,
		@IRemoteAuthorityResolverService private readonly remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		const channel = mainProcessService.getChannel(ipcBrowserViewChannelName);
		this._browserViewService = ProxyChannel.toService<IBrowserViewService>(channel);

		this.sendKeybindings();
		this._register(this.keybindingService.onDidUpdateKeybindings(() => this.sendKeybindings()));
		this._register(toDisposable(() => {
			const authority = this.environmentService.remoteAuthority;
			if (this._remoteProxyPromise && authority) {
				void this.tunnelProxyService.stop(authority).catch(err => this.logService.error('[BrowserViewWorkbenchService] Failed to stop tunnel proxy:', err));
			}
		}));
	}

	private _getRemoteProxy(): Promise<string | undefined> {
		if (!this._remoteProxyPromise) {
			this._remoteProxyPromise = this._startRemoteProxy();
		}
		return this._remoteProxyPromise;
	}

	private async _startRemoteProxy(): Promise<string | undefined> {
		const remoteAuthority = this.environmentService.remoteAuthority;
		if (!remoteAuthority) {
			return undefined;
		}

		try {
			const proxyUrl = await this.tunnelProxyService.start(remoteAuthority);
			this.logService.info(`[BrowserViewWorkbenchService] Tunnel proxy started for remote authority '${remoteAuthority}'`);

			// Push the resolved address to the proxy
			const connectionData = this.remoteAuthorityResolverService.getConnectionData(remoteAuthority);
			if (connectionData) {
				await this.tunnelProxyService.setAddress(remoteAuthority, {
					connectTo: connectionData.connectTo,
					connectionToken: connectionData.connectionToken
				});
			}

			// Keep address up to date on reconnections
			this._register(this.remoteAuthorityResolverService.onDidChangeConnectionData(() => {
				const data = this.remoteAuthorityResolverService.getConnectionData(remoteAuthority);
				if (data) {
					void this.tunnelProxyService.setAddress(remoteAuthority, {
						connectTo: data.connectTo,
						connectionToken: data.connectionToken
					}).catch(err => this.logService.error('[BrowserViewWorkbenchService] Failed to update tunnel proxy address:', err));
				}
			}));

			return proxyUrl;
		} catch (err) {
			this.logService.error('[BrowserViewWorkbenchService] Failed to start tunnel proxy:', err);
			return undefined;
		}
	}

	async getOrCreateBrowserViewModel(id: string): Promise<IBrowserViewModel> {
		return this._getBrowserViewModel(id, true);
	}

	async getBrowserViewModel(id: string): Promise<IBrowserViewModel> {
		return this._getBrowserViewModel(id, false);
	}

	async clearGlobalStorage(): Promise<void> {
		return this._browserViewService.clearGlobalStorage();
	}

	async clearWorkspaceStorage(): Promise<void> {
		const workspaceId = this.workspaceContextService.getWorkspace().id;
		return this._browserViewService.clearWorkspaceStorage(workspaceId);
	}

	private async _getBrowserViewModel(id: string, create: boolean): Promise<IBrowserViewModel> {
		let model = this._models.get(id);
		if (model) {
			return model;
		}

		model = this.instantiationService.createInstance(BrowserViewModel, id, this._browserViewService);
		this._models.set(id, model);

		// Initialize the model with current state
		try {
			const proxyUrl = create ? await this._getRemoteProxy() : undefined;
			await model.initialize(create, proxyUrl);
		} catch (e) {
			this._models.delete(id);
			throw e;
		}

		// Clean up model when disposed
		Event.once(model.onWillDispose)(() => {
			this._models.delete(id);
		});

		return model;
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
