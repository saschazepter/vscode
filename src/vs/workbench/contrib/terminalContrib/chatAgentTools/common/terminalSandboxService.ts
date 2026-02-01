/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { dirname, posix, win32 } from '../../../../../base/common/path.js';
import { OperatingSystem, OS } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ITerminalSandboxSettings } from './terminalSandbox.js';
import { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { TerminalChatAgentToolsSettingId } from './terminalChatAgentToolsConfiguration.js';
import { IRemoteAgentEnvironment } from '../../../../../platform/remote/common/remoteAgentEnvironment.js';

export const ITerminalSandboxService = createDecorator<ITerminalSandboxService>('terminalSandboxService');

export interface ITerminalSandboxService {
	readonly _serviceBrand: undefined;
	isEnabled(): Promise<boolean>;
	wrapCommand(command: string): string;
	getSandboxConfigPath(forceRefresh?: boolean): Promise<string | undefined>;
	getTempDir(): URI | undefined;
	setNeedsForceUpdateConfigFile(): void;
	cleanupSandboxConfigFiles(): Promise<void>;
}

export class TerminalSandboxService extends Disposable implements ITerminalSandboxService {
	readonly _serviceBrand: undefined;
	private _srtPath: string | undefined;
	private _srtPathResolved = false;
	private _execPath?: string;
	private _sandboxConfigPath: string | undefined;
	private _needsForceUpdateConfigFile = true;
	private _tempDir: URI | undefined;
	private _sandboxSettingsId: string | undefined;
	private _sandboxConfigResource: URI | undefined;
	private _remoteEnvDetailsPromise: Promise<IRemoteAgentEnvironment | null>;
	private _remoteEnvDetails: IRemoteAgentEnvironment | null = null;
	private _appRoot: string;
	private _os: OperatingSystem = OS;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFileService private readonly _fileService: IFileService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
	) {
		super();
		this._appRoot = dirname(FileAccess.asFileUri('').fsPath);
		// Get the node executable path from native environment service if available (Electron's execPath with ELECTRON_RUN_AS_NODE)
		const nativeEnv = this._environmentService as IEnvironmentService & { execPath?: string };
		this._execPath = nativeEnv.execPath;
		this._sandboxSettingsId = generateUuid();
		this._remoteEnvDetailsPromise = this._remoteAgentService.getEnvironment();

		this._register(Event.runAndSubscribe(this._configurationService.onDidChangeConfiguration, (e: IConfigurationChangeEvent | undefined) => {
			// If terminal sandbox settings changed, update sandbox config.
			if (
				e?.affectsConfiguration(TerminalChatAgentToolsSettingId.TerminalSandboxEnabled) ||
				e?.affectsConfiguration(TerminalChatAgentToolsSettingId.TerminalSandboxNetwork) ||
				e?.affectsConfiguration(TerminalChatAgentToolsSettingId.TerminalSandboxLinuxFileSystem) ||
				e?.affectsConfiguration(TerminalChatAgentToolsSettingId.TerminalSandboxMacFileSystem)
			) {
				this.setNeedsForceUpdateConfigFile();
			}
		}));
	}

	public async isEnabled(): Promise<boolean> {
		this._remoteEnvDetails = await this._remoteEnvDetailsPromise;
		this._os = this._remoteEnvDetails ? this._remoteEnvDetails.os : OS;
		if (this._os === OperatingSystem.Windows) {
			return false;
		}
		return this._configurationService.getValue<boolean>(TerminalChatAgentToolsSettingId.TerminalSandboxEnabled);
	}

	public wrapCommand(command: string): string {
		if (!this._sandboxConfigPath || !this._tempDir) {
			throw new Error('Sandbox config path or temp dir not initialized');
		}
		if (!this._execPath) {
			throw new Error('Executable path not set to run sandbox commands');
		}
		if (!this._srtPath) {
			throw new Error('Sandbox runtime path not resolved');
		}
		// Use ELECTRON_RUN_AS_NODE=1 to make Electron executable behave as Node.js
		// TMPDIR must be set as environment variable before the command
		// Use -c to pass the command string directly (like sh -c), avoiding argument parsing issues
		const wrappedCommand = `"${this._execPath}" "${this._srtPath}" TMPDIR=${this._tempDir.fsPath} --settings "${this._sandboxConfigPath}" -c "${command}"`;
		if (this._remoteEnvDetails) {
			return `${wrappedCommand}`;
		}
		return `ELECTRON_RUN_AS_NODE=1 ${wrappedCommand}`;
	}

	public getTempDir(): URI | undefined {
		return this._tempDir;
	}

	public setNeedsForceUpdateConfigFile(): void {
		this._needsForceUpdateConfigFile = true;
	}

	public async cleanupSandboxConfigFiles(): Promise<void> {
		if (!this._sandboxConfigResource) {
			return;
		}

		const resource = this._sandboxConfigResource;
		this._sandboxConfigResource = undefined;
		this._sandboxConfigPath = undefined;
		try {
			await this._fileService.del(resource);
		} catch (error) {
			this._logService.warn(`TerminalSandboxService: Failed to delete sandbox settings file ${resource.toString()}: ${error}`);
		}
	}

	public async getSandboxConfigPath(forceRefresh: boolean = false): Promise<string | undefined> {
		await this._resolveSrtPath();
		if (!this._sandboxConfigPath || forceRefresh || this._needsForceUpdateConfigFile) {
			this._sandboxConfigPath = await this._createSandboxConfig();
			this._needsForceUpdateConfigFile = false;
		}
		return this._sandboxConfigPath;
	}

	private async _resolveSrtPath(): Promise<void> {
		// srt path is dist/cli.js inside the sandbox-runtime package.
		this._srtPath = this._pathJoin(this._appRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'cli.js');
		if (this._srtPathResolved) {
			return;
		}
		this._srtPathResolved = true;
		const remoteEnv = this._remoteEnvDetails;
		if (!remoteEnv) {
			return;
		}
		this._execPath = this._pathJoin(remoteEnv.appRoot.fsPath, 'node');
		this._srtPath = this._pathJoin(remoteEnv.appRoot.fsPath, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'cli.js');
	}

	private async _createSandboxConfig(): Promise<string | undefined> {

		if (await this.isEnabled() && !this._tempDir) {
			await this._initTempDir();
		}
		if (this._tempDir) {
			const os = this._os;
			const networkSetting = this._configurationService.getValue<ITerminalSandboxSettings['network']>(TerminalChatAgentToolsSettingId.TerminalSandboxNetwork) ?? {};
			const linuxFileSystemSetting = os === OperatingSystem.Linux
				? this._configurationService.getValue<ITerminalSandboxSettings['filesystem']>(TerminalChatAgentToolsSettingId.TerminalSandboxLinuxFileSystem) ?? {}
				: {};
			const macFileSystemSetting = os === OperatingSystem.Macintosh
				? this._configurationService.getValue<ITerminalSandboxSettings['filesystem']>(TerminalChatAgentToolsSettingId.TerminalSandboxMacFileSystem) ?? {}
				: {};
			const configFilePath = this._pathJoin(this._tempDir.fsPath, `vscode-sandbox-settings-${this._sandboxSettingsId}.json`);
			const configFileResource = URI.file(configFilePath);
			const sandboxSettings = {
				network: {
					allowedDomains: networkSetting.allowedDomains ?? [],
					deniedDomains: networkSetting.deniedDomains ?? []
				},
				filesystem: {
					denyRead: os === OperatingSystem.Macintosh ? macFileSystemSetting.denyRead : linuxFileSystemSetting.denyRead,
					allowWrite: os === OperatingSystem.Macintosh ? macFileSystemSetting.allowWrite : linuxFileSystemSetting.allowWrite,
					denyWrite: os === OperatingSystem.Macintosh ? macFileSystemSetting.denyWrite : linuxFileSystemSetting.denyWrite,
				}
			};
			this._sandboxConfigPath = configFilePath;
			this._sandboxConfigResource = configFileResource;
			await this._fileService.createFile(configFileResource, VSBuffer.fromString(JSON.stringify(sandboxSettings, null, '\t')), { overwrite: true });
			return this._sandboxConfigPath;
		}
		return undefined;
	}

	private _pathJoin = (...segments: string[]) => {
		const path = this._os === OperatingSystem.Windows ? win32 : posix;
		return path.join(...segments);
	};

	private async _initTempDir(): Promise<void> {
		if (await this.isEnabled()) {
			this._needsForceUpdateConfigFile = true;
			const remoteEnv = this._remoteEnvDetails;
			if (remoteEnv) {
				this._tempDir = URI.file(this._pathJoin(this._appRoot, 'vscode-sandbox-tmp'));
			} else {
				const environmentService = this._environmentService as IEnvironmentService & { tmpDir?: URI };
				this._tempDir = environmentService.tmpDir;
			}
			if (!this._tempDir) {
				this._logService.warn('TerminalSandboxService: Cannot create sandbox settings file because no tmpDir is available in this environment');
			}
		}
	}
}
