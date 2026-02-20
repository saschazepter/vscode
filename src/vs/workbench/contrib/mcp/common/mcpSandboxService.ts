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
import { ConfigurationTarget, ConfigurationTargetToString } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRemoteAgentEnvironment } from '../../../../platform/remote/common/remoteAgentEnvironment.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
import { IMcpSandboxConfiguration } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { mcpSandboxedLaunchEnvironmentKey, McpServerDefinition, McpServerLaunch, McpServerTransportType } from './mcpTypes.js';

export const IMcpSandboxService = createDecorator<IMcpSandboxService>('mcpSandboxService');

export interface IMcpSandboxService {
	readonly _serviceBrand: undefined;
	launchInSandboxIfEnabled(serverDef: McpServerDefinition, launch: McpServerLaunch, remoteAuthority: string | undefined, configTarget: ConfigurationTarget): Promise<McpServerLaunch>;
	isEnabled(serverDef: McpServerDefinition, serverLabel?: string): Promise<boolean>;
}

type SandboxLaunchDetails = {
	srtPath: string | undefined;
	sandboxConfigPath: string | undefined;
	tempDir: URI | undefined;
};

export class McpSandboxService extends Disposable implements IMcpSandboxService {
	readonly _serviceBrand: undefined;

	private _sandboxSettingsId: string | undefined;
	private _remoteEnvDetailsPromise: Promise<IRemoteAgentEnvironment | null>;
	private readonly _defaultAllowedDomains: readonly string[] = ['*.npmjs.org'];
	private _sandboxConfigPerConfigurationTarget: Map<string, string> = new Map();

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
	) {
		super();
		this._sandboxSettingsId = generateUuid();
		this._remoteEnvDetailsPromise = this._remoteAgentService.getEnvironment();

	}

	public async isEnabled(serverDef: McpServerDefinition, remoteAuthority?: string): Promise<boolean> {
		const os = await this._getOperatingSystem(remoteAuthority);
		if (os === OperatingSystem.Windows) {
			return false;
		}
		return !!serverDef.sandboxEnabled;
	}

	public async launchInSandboxIfEnabled(serverDef: McpServerDefinition, launch: McpServerLaunch, remoteAuthority: string | undefined, configTarget: ConfigurationTarget): Promise<McpServerLaunch> {
		if (launch.type !== McpServerTransportType.Stdio) {
			return launch;
		}
		if (await this.isEnabled(serverDef, remoteAuthority)) {
			this._logService.trace(`McpSandboxService: Launching with config target ${configTarget}`);
			const launchDetails = await this._resolveSandboxLaunchDetails(configTarget, remoteAuthority, serverDef.sandbox);
			const sandboxArgs = this._getSandboxCommandArgs(launch.command, launch.args, launchDetails.sandboxConfigPath);
			const sandboxEnv = this._getSandboxEnvVariables(launchDetails.tempDir);
			if (launchDetails.srtPath) {
				return {
					...launch,
					command: launchDetails.srtPath,
					args: sandboxArgs,
					env: sandboxEnv ? { ...launch.env, ...sandboxEnv } : launch.env,
					type: McpServerTransportType.Stdio,
				};
			}
			this._logService.debug(`McpSandboxService: launch details for server ${serverDef.label} - command: ${launch.command}, args: ${launch.args.join(' ')}`);
		}
		return launch;
	}

	private async _resolveSandboxLaunchDetails(configTarget: ConfigurationTarget, remoteAuthority?: string, sandboxConfig?: IMcpSandboxConfiguration): Promise<SandboxLaunchDetails> {
		const os = await this._getOperatingSystem(remoteAuthority);
		if (os === OperatingSystem.Windows) {
			return { srtPath: undefined, sandboxConfigPath: undefined, tempDir: undefined };
		}

		const appRoot = await this._getAppRoot(remoteAuthority);
		const tempDir = await this._getTempDir(remoteAuthority);
		const srtPath = this._pathJoin(os, appRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'cli.js');
		const sandboxConfigPath = tempDir ? await this._updateSandboxConfig(tempDir, configTarget, sandboxConfig) : undefined;
		this._logService.debug(`McpSandboxService: Updated sandbox config path: ${sandboxConfigPath}`);
		return { srtPath, sandboxConfigPath, tempDir };
	}

	private _getSandboxEnvVariables(tempDir: URI | undefined): Record<string, string> | undefined {
		if (tempDir) {
			return { TMPDIR: tempDir.path, SRT_DEBUG: 'true', [mcpSandboxedLaunchEnvironmentKey]: 'true' };
		}
		return undefined;
	}

	private _getSandboxCommandArgs(command: string, args: readonly string[], sandboxConfigPath: string | undefined): string[] {
		const result: string[] = [];
		if (sandboxConfigPath) {
			result.push('--settings', sandboxConfigPath);
		}
		result.push(command, ...args);
		return result;
	}

	private async _getRemoteEnv(remoteAuthority?: string): Promise<IRemoteAgentEnvironment | null> {
		if (!remoteAuthority) {
			return null;
		}
		return this._remoteEnvDetailsPromise;
	}

	private async _getOperatingSystem(remoteAuthority?: string): Promise<OperatingSystem> {
		const remoteEnv = await this._getRemoteEnv(remoteAuthority);
		if (remoteEnv) {
			return remoteEnv.os;
		}
		return OS;
	}

	private async _getAppRoot(remoteAuthority?: string): Promise<string> {
		const remoteEnv = await this._getRemoteEnv(remoteAuthority);
		if (remoteEnv) {
			return remoteEnv.appRoot.path;
		}
		return dirname(FileAccess.asFileUri('').path);
	}

	private async _getTempDir(remoteAuthority?: string): Promise<URI | undefined> {
		const remoteEnv = await this._getRemoteEnv(remoteAuthority);
		if (remoteEnv) {
			return remoteEnv.tmpDir;
		}
		const environmentService = this._environmentService as IEnvironmentService & { tmpDir?: URI };
		const tempDir = environmentService.tmpDir;
		if (!tempDir) {
			this._logService.warn('McpSandboxService: Cannot create sandbox settings file because no tmpDir is available in this environment');
		}
		return tempDir;
	}

	private async _updateSandboxConfig(tempDir: URI, configTarget: ConfigurationTarget, sandboxConfig?: IMcpSandboxConfiguration): Promise<string> {
		const normalizedSandboxConfig = this._withDefaultSandboxConfig(sandboxConfig);
		let configFileUri: URI;
		const configTargetKey = ConfigurationTargetToString(configTarget);
		if (this._sandboxConfigPerConfigurationTarget.has(configTargetKey)) {
			configFileUri = URI.parse(this._sandboxConfigPerConfigurationTarget.get(configTargetKey)!);
		} else {
			configFileUri = URI.joinPath(tempDir, `vscode-${configTargetKey}-mcp-sandbox-settings-${this._sandboxSettingsId}.json`);
			this._sandboxConfigPerConfigurationTarget.set(configTargetKey, configFileUri.toString());
		}
		await this._fileService.createFile(configFileUri, VSBuffer.fromString(JSON.stringify(normalizedSandboxConfig, null, '\t')), { overwrite: true });
		return configFileUri.path;
	}

	// this method merges the default allowWrite paths and allowedDomains with the ones provided in the sandbox config, to ensure that the default necessary paths and domains are always included in the sandbox config used for launching,
	//  even if they are not explicitly specified in the config provided by the user or the MCP server config.
	private _withDefaultSandboxConfig(sandboxConfig?: IMcpSandboxConfiguration): IMcpSandboxConfiguration {
		const mergedAllowWrite = new Set(sandboxConfig?.filesystem?.allowWrite ?? []);
		for (const defaultAllowWrite of this._getDefaultAllowWrite()) {
			if (defaultAllowWrite) {
				mergedAllowWrite.add(defaultAllowWrite);
			}
		}

		const mergedAllowedDomains = new Set(sandboxConfig?.network?.allowedDomains ?? []);
		for (const defaultAllowedDomain of this._defaultAllowedDomains) {
			if (defaultAllowedDomain) {
				mergedAllowedDomains.add(defaultAllowedDomain);
			}
		}

		return {
			...sandboxConfig,
			network: {
				allowedDomains: [...mergedAllowedDomains],
				deniedDomains: sandboxConfig?.network?.deniedDomains ?? [],
			},
			filesystem: {
				allowWrite: [...mergedAllowWrite],
				denyRead: sandboxConfig?.filesystem?.denyRead ?? [],
				denyWrite: sandboxConfig?.filesystem?.denyWrite ?? [],
			},
		};
	}

	private _getDefaultAllowWrite(): readonly string[] {
		return [
			'~/.npm'
		];
	}

	private _pathJoin = (os: OperatingSystem, ...segments: string[]) => {
		const path = os === OperatingSystem.Windows ? win32 : posix;
		return path.join(...segments);
	};

}
