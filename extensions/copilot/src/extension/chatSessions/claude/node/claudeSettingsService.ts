/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Settings as ClaudeSettings } from '@anthropic-ai/claude-agent-sdk';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { Emitter } from '../../../../util/vs/base/common/event';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { ClaudeSettingsFile, ClaudeSettingsLocationType, IClaudeSettingsService } from '../common/claudeSettingsService';
import { extUriBiasedIgnorePathCase } from '../../../../util/vs/base/common/resources';

export class ClaudeSettingsService extends Disposable implements IClaudeSettingsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _settingsCache: Readonly<ClaudeSettingsFile[]> | undefined;
	private _settingsUris: URI[] = [];

	constructor(
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@INativeEnvService private readonly envService: INativeEnvService,
	) {
		super();

		const onSettingsChanged = () => {
			this._settingsCache = undefined;
			this._onDidChange.fire();
		};

		const setupWatchers = () => {
			this._settingsUris = [];
			for (const location of Object.values(ClaudeSettingsLocationType)) {
				const uris = this.getUris(location);
				this._settingsUris.push(...uris);
				for (const uri of uris) {
					const settingsWatcher = this._register(this.fileSystemService.createFileSystemWatcher(uri.fsPath));
					this._register(settingsWatcher.onDidChange(onSettingsChanged));
					this._register(settingsWatcher.onDidCreate(onSettingsChanged));
					this._register(settingsWatcher.onDidDelete(onSettingsChanged));
				}
			}
		};

		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			setupWatchers();
			onSettingsChanged();
		}));

		setupWatchers();
	}

	private getUrisByLocation(location: ClaudeSettingsLocationType): URI[] {
		switch (location) {
			case ClaudeSettingsLocationType.User:
				return [URI.joinPath(this.envService.userHome, '.claude', 'settings.json')];
			case ClaudeSettingsLocationType.Workspace: {
				const folders = this.workspaceService.getWorkspaceFolders();
				const uris: URI[] = [];
				for (const folder of folders) {
					uris.push(URI.joinPath(folder, '.claude', 'settings.json'));
				}
				return uris;
			}
			case ClaudeSettingsLocationType.WorkspaceLocal: {
				const folders = this.workspaceService.getWorkspaceFolders();
				const uris: URI[] = [];
				for (const folder of folders) {
					uris.push(URI.joinPath(folder, '.claude', 'settings.local.json'));
				}
				return uris;
			}
		}
	}

	getUris(location?: ClaudeSettingsLocationType): URI[] {
		if (location) {
			return this.getUrisByLocation(location);
		} else {
			let uris: URI[] = [];
			for (const loc of Object.values(ClaudeSettingsLocationType)) {
				uris = uris.concat(this.getUrisByLocation(loc));
			}
			return uris;
		}
	}

	getUri(location: ClaudeSettingsLocationType, uri: URI): URI {
		const uris = this.getUris(location);
		if (uris.length === 1) {
			return uris[0];
		}
		const workspaceFolders = this.workspaceService.getWorkspaceFolders();
		// Multiple workspace folders — find the one that matches the item's URI
		for (const workspaceFolder of workspaceFolders) {
			if (extUriBiasedIgnorePathCase.isEqualOrParent(uri, workspaceFolder)) {
				const settingsUri = uris.find(u => extUriBiasedIgnorePathCase.isEqual(u, workspaceFolder));
				if (settingsUri) {
					return settingsUri;
				}
			}
		}
		throw new Error(`Could not find a matching settings URI for ${uri.toString()}`);
	}

	async readSettingsFile(uri: URI): Promise<ClaudeSettings> {
		try {
			const bytes = await this.fileSystemService.readFile(uri);
			const parsed = JSON.parse(new TextDecoder().decode(bytes));
			return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
		} catch {
			return {};
		}
	}

	async readAllSettings(): Promise<Readonly<ClaudeSettingsFile[]>> {
		if (this._settingsCache) {
			return this._settingsCache;
		}

		const settingsFiles = await Promise.all(
			this._settingsUris.map(uri => this.readSettingsFile(uri))
		);

		this._settingsCache = settingsFiles.map((settings, index) => ({
			type: Object.values(ClaudeSettingsLocationType)[index],
			settings,
			uri: this._settingsUris[index],
		}));

		return this._settingsCache;
	}

	async writeSettingsFile(uri: URI, settings: ClaudeSettings): Promise<void> {
		const content = new TextEncoder().encode(JSON.stringify(settings, null, 4));
		await this.fileSystemService.writeFile(uri, content);
		// Cache will be invalidated by the file watcher
	}
}
