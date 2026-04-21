/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IStorage, Storage, MigratingStorage } from '../../../../base/parts/storage/common/storage.js';
import { RemoteStorageService } from '../../../../platform/storage/common/storageService.js';
import { FallbackApplicationStorageDatabaseClient, ApplicationSharedStorageDatabaseClient } from '../../../../platform/storage/common/storageIpc.js';
import { StorageScope } from '../../../../platform/storage/common/storage.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IAnyWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';

export class NativeWorkbenchStorageService extends RemoteStorageService {

	constructor(
		workspace: IAnyWorkspaceIdentifier | undefined,
		private readonly userDataProfileService: IUserDataProfileService,
		userDataProfilesService: IUserDataProfilesService,
		mainProcessService: IMainProcessService,
		private readonly workbenchEnvironmentService: IWorkbenchEnvironmentService,
	) {
		super(workspace, { currentProfile: userDataProfileService.currentProfile, defaultProfile: userDataProfilesService.defaultProfile }, mainProcessService, workbenchEnvironmentService);

		this.registerListeners();
	}

	protected override createApplicationSharedStorage(): IStorage {
		const channel = this.remoteService.getChannel('storage');
		const storageDataBaseClient = this._register(new ApplicationSharedStorageDatabaseClient(channel));

		let applicationSharedStorage;
		if (this.workbenchEnvironmentService.isSessionsWindow) {
			const applicationSharedFallbackStorage = this._register(new Storage(this._register(new FallbackApplicationStorageDatabaseClient(channel))));
			applicationSharedStorage = this._register(new MigratingStorage(storageDataBaseClient, {}, applicationSharedFallbackStorage));
		} else {
			// In VS Code windows, fall back to APPLICATION storage for transparent
			// migration of keys moved to APPLICATION_SHARED scope. On hit, values
			// are automatically written through to the shared storage.
			// In sessions windows, fallback data is already merged into the IPC
			// response by the main process, so no window-side fallback is needed.
			applicationSharedStorage = this._register(new MigratingStorage(storageDataBaseClient, {}, this.applicationStorage));
		}

		this._register(applicationSharedStorage.onDidChangeStorage(e => this.emitDidChangeValue(StorageScope.APPLICATION_SHARED, e)));
		return applicationSharedStorage;
	}

	private registerListeners(): void {
		this._register(this.userDataProfileService.onDidChangeCurrentProfile(e => e.join(this.switchToProfile(e.profile))));
	}
}

