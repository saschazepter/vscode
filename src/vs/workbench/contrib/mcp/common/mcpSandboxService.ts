/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { dirname, posix, win32 } from '../../../../base/common/path.js';
import { OperatingSystem, OS } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { InstallMcpServerResult } from '../../../../platform/mcp/common/mcpManagement.js';
import { IRemoteAgentEnvironment } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
import { IMcpSandboxConfiguration, McpServerType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { IWorkbenchMcpManagementService } from '../../../services/mcp/common/mcpWorkbenchManagementService.js';
import { McpServerDefinition, McpServerLaunch, McpServerTransportType } from './mcpTypes.js';

export const IMcpSandboxService = createDecorator<IMcpSandboxService>('mcpSandboxService');

export interface IMcpSandboxService {
	readonly _serviceBrand: undefined;
	launchInSandboxIfEnabled(serverDef: McpServerDefinition, launch: McpServerLaunch): Promise<McpServerLaunch>;
	isEnabled(serverDef: McpServerDefinition): Promise<boolean>;
}

export class McpSandboxService extends Disposable implements IMcpSandboxService {
	readonly _serviceBrand: undefined;


	private _srtPath: string | undefined;
	private _srtPathResolved = false;
	private _sandboxConfigPath: string | undefined;
	private _sandboxConfig: IMcpSandboxConfiguration | undefined;
	private _tempDir: URI | undefined;
	private _sandboxSettingsId: string | undefined;
	private _remoteEnvDetailsPromise: Promise<IRemoteAgentEnvironment | null>;
	private _remoteEnvDetails: IRemoteAgentEnvironment | null = null;
	private _appRoot: string;
	private _os: OperatingSystem = OS;
	private _sandboxEnabledMcpServers: Set<string> = new Set();

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
		@IWorkbenchMcpManagementService private readonly _mcpManagementService: IWorkbenchMcpManagementService,
	) {
		super();
		this._appRoot = dirname(FileAccess.asFileUri('').path);
		this._sandboxSettingsId = generateUuid();
		this._remoteEnvDetailsPromise = this._remoteAgentService.getEnvironment();
		this._register(this._mcpManagementService.onDidUpdateMcpServers(e => {
			void this._refreshSandboxConfigFromUpdates(e);
		}));

		this._register(this._mcpManagementService.onDidInstallMcpServers(e => {
			this._populateSandboxConfigFromInstallResults(e);
		}));
	}

	public async isEnabled(serverDef: McpServerDefinition): Promise<boolean> {
		this._remoteEnvDetails = await this._remoteEnvDetailsPromise;
		this._os = this._remoteEnvDetails ? this._remoteEnvDetails.os : OS;

		if (this._os === OperatingSystem.Windows) {
			return false;
		}
		return this._sandboxEnabledMcpServers.has(serverDef.label);
	}

	public async getSandboxRuntimePath(): Promise<string | undefined> {
		await this._resolveSrtPath();
		return this._srtPath;
	}

	public getSandboxEnvVariables(): Record<string, string> | undefined {
		if (this._tempDir) {
			return { TMPDIR: this._tempDir.path, SRT_DEBUG: 'true' };
		}
		return undefined;
	}

	public async getSandboxCommandArgs(command: string, args: readonly string[]): Promise<string[] | undefined> {
		const result: string[] = [];
		this._sandboxConfigPath = await this.getSandboxConfigPath();
		if (this._sandboxConfigPath) {
			result.push('--settings', this._sandboxConfigPath);
		}
		result.push(command, ...args);
		return result;
	}

	public async launchInSandboxIfEnabled(serverDef: McpServerDefinition, launch: McpServerLaunch): Promise<McpServerLaunch> {
		if (launch.type !== McpServerTransportType.Stdio) {
			return launch;
		}
		if (await this.isEnabled(serverDef)) {
			const srtPath = await this.getSandboxRuntimePath();
			const sandboxArgs = await this.getSandboxCommandArgs(launch.command, launch.args);
			const sandboxEnv = this.getSandboxEnvVariables();
			if (srtPath && sandboxArgs) {
				return {
					...launch,
					command: srtPath,
					args: sandboxArgs,
					env: sandboxEnv ? { ...launch.env, ...sandboxEnv } : launch.env,
					type: McpServerTransportType.Stdio,
				};
			}
		}
		return launch;
	}

	private async getSandboxConfigPath(sandboxConfig?: IMcpSandboxConfiguration): Promise<string | undefined> {
		if (this._os === OperatingSystem.Windows) {
			return undefined;
		}
		if (!this._tempDir) {
			await this._initTempDir();
		}
		this._sandboxConfigPath = await this._updateSandboxConfig(sandboxConfig ?? this._sandboxConfig);
		return this._sandboxConfigPath;
	}

	private _populateSandboxConfigFromInstallResults(results: readonly InstallMcpServerResult[]): void {
		//updating sandbox config based on the first local server config we find in the results.
		// single server config is supported for all installed servers, so we can break after the first match.
		for (const result of results) {
			const config = result.local?.config;
			if (config?.type === McpServerType.LOCAL) {
				this._sandboxConfig = config.sandbox;
				break;
			}
		}
		this._updateSandboxEnabledServersFromInstallResults(results);
	}

	private _updateSandboxEnabledServersFromInstallResults(results: readonly InstallMcpServerResult[]): void {
		// Update sandbox enablement set for local servers.
		for (const result of results) {
			const config = result.local?.config;
			if (config?.type === McpServerType.LOCAL) {
				if (config.sandboxEnabled) {
					this._sandboxEnabledMcpServers.add(result.name);
				} else {
					this._sandboxEnabledMcpServers.delete(result.name);
				}
			}
		}
	}

	private async _resolveSrtPath(): Promise<void> {
		if (this._srtPathResolved) {
			return;
		}
		this._srtPathResolved = true;
		const remoteEnv = this._remoteEnvDetails || await this._remoteEnvDetailsPromise;
		if (!remoteEnv) {
			this._srtPath = this._pathJoin(this._appRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'cli.js');
			return;
		}
		this._appRoot = remoteEnv.appRoot.path;
		this._srtPath = this._pathJoin(this._appRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'cli.js');
	}

	private async _updateSandboxConfig(sandboxConfig?: IMcpSandboxConfiguration): Promise<string | undefined> {
		if (!this._tempDir) {
			return undefined;
		}
		if (this._sandboxConfigPath && this._areSandboxConfigsEqual(this._sandboxConfig, sandboxConfig)) {
			return this._sandboxConfigPath;
		}
		this._sandboxConfig = sandboxConfig;
		const configFileUri = URI.joinPath(this._tempDir, `vscode-mcp-sandbox-settings-${this._sandboxSettingsId}.json`);
		this._sandboxConfigPath = configFileUri.path;
		await this._fileService.createFile(configFileUri, VSBuffer.fromString(JSON.stringify(this._sandboxConfig, null, '\t')), { overwrite: true });
		return this._sandboxConfigPath;
	}

	// TODO: this should not be registered if there is no sandboxing enabled.
	private async _refreshSandboxConfigFromUpdates(results: readonly InstallMcpServerResult[]): Promise<void> {

		this._updateSandboxEnabledServersFromInstallResults(results);

		this._os = this._remoteEnvDetails ? this._remoteEnvDetails.os : OS;
		if (this._os === OperatingSystem.Windows) {
			return;
		}
		let sandboxConfig: IMcpSandboxConfiguration | undefined;
		for (const result of results) {
			const config = result.local?.config;
			if (config?.type === McpServerType.LOCAL) {
				sandboxConfig = config.sandbox;
				break;
			}
		}
		if (!sandboxConfig) {
			return;
		}
		if (!this._tempDir) {
			await this._initTempDir();
		}
		if (!this._tempDir) {
			return;
		}
		await this._updateSandboxConfig(sandboxConfig);
	}

	private _areSandboxConfigsEqual(left: IMcpSandboxConfiguration | undefined, right: IMcpSandboxConfiguration | undefined): boolean {
		if (left === right) {
			return true;
		}
		if (!left || !right) {
			return false;
		}
		return JSON.stringify(left) === JSON.stringify(right);
	}

	private _pathJoin = (...segments: string[]) => {
		const path = this._os === OperatingSystem.Windows ? win32 : posix;
		return path.join(...segments);
	};

	private async _initTempDir(): Promise<void> {
		const remoteEnv = this._remoteEnvDetails || await this._remoteEnvDetailsPromise;
		if (remoteEnv) {
			this._tempDir = remoteEnv.tmpDir;
		} else {
			const environmentService = this._environmentService as IEnvironmentService & { tmpDir?: URI };
			this._tempDir = environmentService.tmpDir;
		}
		if (!this._tempDir) {
			this._logService.warn('McpSandboxService: Cannot create sandbox settings file because no tmpDir is available in this environment');
		}
	}

}
