/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IBrowserViewService, ipcBrowserViewChannelName, IBrowserViewOpenRequest, IBrowserViewDebugInfo } from '../../../../platform/browserView/common/browserView.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { IBrowserViewWorkbenchService, IBrowserViewModel, BrowserViewModel } from '../common/browserView.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { Event } from '../../../../base/common/event.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';

interface IBrowserViewDebugProxyServiceProxy {
	ensureStarted(): Promise<IBrowserViewDebugInfo>;
	getDebugInfo(targetId?: string): Promise<IBrowserViewDebugInfo | undefined>;
}

export class BrowserViewWorkbenchService extends Disposable implements IBrowserViewWorkbenchService {
	declare readonly _serviceBrand: undefined;

	private readonly _browserViewService: IBrowserViewService;
	private readonly _debugProxyService: IBrowserViewDebugProxyServiceProxy;
	private readonly _models = new Map<string, IBrowserViewModel>();

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
		@IConfigurationResolverService configurationResolverService: IConfigurationResolverService
	) {
		super();
		const channel = mainProcessService.getChannel(ipcBrowserViewChannelName);
		this._browserViewService = ProxyChannel.toService<IBrowserViewService>(channel);

		const debugProxyChannel = mainProcessService.getChannel('browserViewDebugProxy');
		this._debugProxyService = ProxyChannel.toService<IBrowserViewDebugProxyServiceProxy>(debugProxyChannel);

		// Listen for requests to open new browser views (e.g., from CDP Target.createTarget)
		this._register(this._browserViewService.onDidRequestOpenBrowser((request) => {
			this.handleOpenBrowserRequest(request);
		}));

		// Contribute the browserDebugPort variable for use in launch.json
		configurationResolverService.contributeVariable('browserDebugPort', async () => {
			const debugInfo = await this._debugProxyService.ensureStarted();
			return debugInfo?.port.toString();
		});
	}

	/**
	 * Handle a request to open a new browser view (e.g., from CDP Target.createTarget).
	 * Opens an editor for the already-created browser view target.
	 */
	private async handleOpenBrowserRequest(request: IBrowserViewOpenRequest): Promise<void> {
		// Create a browser view URI with the target ID that was already created in the main process
		const resource = BrowserViewUri.forUrl(request.url, request.targetId);
		await this.editorService.openEditor({ resource });
	}

	async getOrCreateBrowserViewModel(id: string): Promise<IBrowserViewModel> {
		let model = this._models.get(id);
		if (model) {
			return model;
		}

		model = this.instantiationService.createInstance(BrowserViewModel, id, this._browserViewService);
		this._models.set(id, model);

		// Initialize the model with current state
		await model.initialize();

		// Clean up model when disposed
		Event.once(model.onWillDispose)(() => {
			this._models.delete(id);
		});

		return model;
	}

	async clearGlobalStorage(): Promise<void> {
		return this._browserViewService.clearGlobalStorage();
	}

	async clearWorkspaceStorage(): Promise<void> {
		const workspaceId = this.workspaceContextService.getWorkspace().id;
		return this._browserViewService.clearWorkspaceStorage(workspaceId);
	}
}
