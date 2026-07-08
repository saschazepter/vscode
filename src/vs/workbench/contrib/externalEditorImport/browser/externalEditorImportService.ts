/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { parse } from '../../../../base/common/json.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isLinux, isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IExtensionGalleryService, IExtensionManagementService, IExtensionIdentifier, InstallExtensionInfo, EXTENSION_INSTALL_SKIP_WALKTHROUGH_CONTEXT } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { areSameExtensions } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IJSONEditingService, IJSONValue } from '../../../services/configuration/common/jsonEditing.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { IExternalEditorImportPreview, IExternalEditorImportResult, IExternalEditorImportSelection, IExternalEditorImportService, IExternalEditorSource } from '../common/externalEditorImport.js';

/**
 * Describes how to locate a known source editor's user data. Source editors that
 * are VS Code forks (e.g. Cursor) share the same on-disk layout, so a single
 * descriptor with the product folder name is enough.
 */
interface IKnownEditorDescriptor {
	readonly id: string;
	readonly label: string;
	/** Product folder name under the platform application-data directory, e.g. `Cursor`. */
	readonly appDataFolder: string;
	/** Home-relative segments of the extensions directory, e.g. `.cursor/extensions`. */
	readonly extensionsDirSegments: readonly string[];
}

const KNOWN_EDITORS: readonly IKnownEditorDescriptor[] = [
	{
		id: 'cursor',
		label: 'Cursor',
		appDataFolder: 'Cursor',
		extensionsDirSegments: ['.cursor', 'extensions'],
	},
];

/**
 * Settings keys (or prefixes) that should never be imported because they are
 * specific to the source editor and have no meaning in VS Code.
 */
const SETTINGS_KEY_BLOCKLIST_PREFIXES: readonly string[] = [
	'cursor.',
	'cursorai.',
	'aicontext.',
];

export class ExternalEditorImportService extends Disposable implements IExternalEditorImportService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IJSONEditingService private readonly jsonEditingService: IJSONEditingService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async detectSources(token?: CancellationToken): Promise<IExternalEditorSource[]> {
		const home = await this.pathService.userHome();
		const appDataHome = this.getApplicationDataHome(home);
		if (!appDataHome) {
			return [];
		}

		const sources: IExternalEditorSource[] = [];
		for (const editor of KNOWN_EDITORS) {
			if (token?.isCancellationRequested) {
				break;
			}

			const userDataUri = URI.joinPath(appDataHome, editor.appDataFolder, 'User');
			const settingsUri = URI.joinPath(userDataUri, 'settings.json');
			const keybindingsUri = URI.joinPath(userDataUri, 'keybindings.json');
			const snippetsUri = URI.joinPath(userDataUri, 'snippets');
			const extensionsManifestUri = URI.joinPath(home, ...editor.extensionsDirSegments, 'extensions.json');

			const [hasSettings, hasKeybindings, hasSnippets, hasExtensions] = await Promise.all([
				this.safeExists(settingsUri),
				this.safeExists(keybindingsUri),
				this.safeHasChildren(snippetsUri),
				this.safeExists(extensionsManifestUri),
			]);

			if (hasSettings || hasKeybindings || hasSnippets || hasExtensions) {
				sources.push({
					id: editor.id,
					label: editor.label,
					userDataUri,
					extensionsManifestUri: hasExtensions ? extensionsManifestUri : undefined,
					hasSettings,
					hasKeybindings,
					hasSnippets,
					hasExtensions,
				});
			}
		}

		return sources;
	}

	async import(source: IExternalEditorSource, selection: IExternalEditorImportSelection, token?: CancellationToken): Promise<IExternalEditorImportResult> {
		let settingsImported = 0;
		let keybindingsImported = false;
		let snippetsImported = 0;
		let extensionsInstalled = 0;
		let extensionsFailed = 0;

		if (selection.settings && source.hasSettings) {
			settingsImported = await this.importSettings(source);
		}

		if (selection.keybindings && source.hasKeybindings) {
			keybindingsImported = await this.importKeybindings(source);
		}

		if (selection.snippets && source.hasSnippets) {
			snippetsImported = await this.importSnippets(source);
		}

		if (selection.extensions && source.hasExtensions) {
			const result = await this.importExtensions(source, token);
			extensionsInstalled = result.installed;
			extensionsFailed = result.failed;
		}

		return { settingsImported, keybindingsImported, snippetsImported, extensionsInstalled, extensionsFailed };
	}

	// =====================================================================
	// Preview
	// =====================================================================

	async preview(source: IExternalEditorSource, token?: CancellationToken): Promise<IExternalEditorImportPreview> {
		const [settings, keybindings, snippets, extensions] = await Promise.all([
			source.hasSettings ? this.previewSettings(source) : Promise.resolve([]),
			source.hasKeybindings ? this.previewKeybindings(source) : Promise.resolve([]),
			source.hasSnippets ? this.previewSnippets(source) : Promise.resolve([]),
			source.hasExtensions ? this.previewExtensions(source, token) : Promise.resolve([]),
		]);
		return { settings, keybindings, snippets, extensions };
	}

	async hasImportableChanges(source: IExternalEditorSource): Promise<boolean> {
		const [settings, keybindings, snippets, extensions] = await Promise.all([
			source.hasSettings ? this.previewSettings(source) : Promise.resolve([]),
			source.hasKeybindings ? this.previewKeybindings(source) : Promise.resolve([]),
			source.hasSnippets ? this.previewSnippets(source) : Promise.resolve([]),
			source.hasExtensions ? this.hasNewExtensions(source) : Promise.resolve(false),
		]);
		return settings.length > 0 || keybindings.length > 0 || snippets.length > 0 || extensions;
	}

	private async hasNewExtensions(source: IExternalEditorSource): Promise<boolean> {
		if (!source.extensionsManifestUri) {
			return false;
		}

		const identifiers = await this.readExtensionIdentifiers(source.extensionsManifestUri);
		if (identifiers.length === 0) {
			return false;
		}

		const installed = await this.extensionManagementService.getInstalled();
		return identifiers.some(identifier => !installed.some(local => areSameExtensions(local.identifier, identifier)));
	}

	private async previewSettings(source: IExternalEditorSource): Promise<string[]> {
		const sourceSettings = await this.readJsonObject(URI.joinPath(source.userDataUri, 'settings.json'));
		if (!sourceSettings) {
			return [];
		}

		const existingSettings = await this.readJsonObject(this.userDataProfileService.currentProfile.settingsResource) ?? {};
		const keys: string[] = [];
		for (const key of Object.keys(sourceSettings)) {
			if (Object.prototype.hasOwnProperty.call(existingSettings, key) || this.isBlockedSettingKey(key)) {
				continue;
			}
			keys.push(key);
		}
		return keys;
	}

	private async previewKeybindings(source: IExternalEditorSource): Promise<string[]> {
		const sourceKeybindings = await this.readJsonArray(URI.joinPath(source.userDataUri, 'keybindings.json'));
		if (!sourceKeybindings || sourceKeybindings.length === 0) {
			return [];
		}

		const existingKeybindings = await this.readJsonArray(this.userDataProfileService.currentProfile.keybindingsResource) ?? [];
		const labels: string[] = [];
		for (const entry of sourceKeybindings) {
			if (existingKeybindings.some(existing => this.deepEqual(existing, entry))) {
				continue;
			}
			const key = (entry as { key?: unknown } | null)?.key;
			const command = (entry as { command?: unknown } | null)?.command;
			if (typeof key === 'string' && key) {
				labels.push(typeof command === 'string' && command ? `${key} → ${command}` : key);
			}
		}
		return labels;
	}

	private async previewSnippets(source: IExternalEditorSource): Promise<string[]> {
		const sourceSnippetsHome = URI.joinPath(source.userDataUri, 'snippets');
		let sourceStat;
		try {
			sourceStat = await this.fileService.resolve(sourceSnippetsHome);
		} catch {
			return [];
		}

		if (!sourceStat.children?.length) {
			return [];
		}

		const targetSnippetsHome = this.userDataProfileService.currentProfile.snippetsHome;
		const names: string[] = [];
		for (const child of sourceStat.children) {
			if (child.isDirectory) {
				continue;
			}
			if (await this.safeExists(URI.joinPath(targetSnippetsHome, child.name))) {
				continue;
			}
			names.push(child.name);
		}
		return names;
	}

	private async previewExtensions(source: IExternalEditorSource, token?: CancellationToken): Promise<string[]> {
		if (!source.extensionsManifestUri) {
			return [];
		}

		const identifiers = await this.readExtensionIdentifiers(source.extensionsManifestUri);
		if (identifiers.length === 0) {
			return [];
		}

		const installed = await this.extensionManagementService.getInstalled();
		const toQuery = identifiers.filter(identifier => !installed.some(local => areSameExtensions(local.identifier, identifier)));
		if (toQuery.length === 0) {
			return [];
		}

		try {
			const galleryExtensions = await this.extensionGalleryService.getExtensions(toQuery.map(identifier => ({ id: identifier.id })), token ?? CancellationToken.None);
			return galleryExtensions.map(extension => extension.displayName || extension.identifier.id);
		} catch (error) {
			this.logService.error('[externalEditorImport] Failed to query extensions for preview', error);
			return toQuery.map(identifier => identifier.id);
		}
	}

	// =====================================================================
	// Settings
	// =====================================================================

	private async importSettings(source: IExternalEditorSource): Promise<number> {
		const sourceSettings = await this.readJsonObject(URI.joinPath(source.userDataUri, 'settings.json'));
		if (!sourceSettings) {
			return 0;
		}

		const targetResource = this.userDataProfileService.currentProfile.settingsResource;
		const existingSettings = await this.readJsonObject(targetResource) ?? {};

		const edits: IJSONValue[] = [];
		for (const key of Object.keys(sourceSettings)) {
			// Never overwrite settings the user already has, and skip source-specific keys.
			if (Object.prototype.hasOwnProperty.call(existingSettings, key) || this.isBlockedSettingKey(key)) {
				continue;
			}
			edits.push({ path: [key], value: sourceSettings[key] });
		}

		if (edits.length === 0) {
			return 0;
		}

		try {
			await this.jsonEditingService.write(targetResource, edits, true);
			return edits.length;
		} catch (error) {
			this.logService.error('[externalEditorImport] Failed to import settings', error);
			return 0;
		}
	}

	private isBlockedSettingKey(key: string): boolean {
		return SETTINGS_KEY_BLOCKLIST_PREFIXES.some(prefix => key.startsWith(prefix));
	}

	// =====================================================================
	// Keybindings
	// =====================================================================

	private async importKeybindings(source: IExternalEditorSource): Promise<boolean> {
		const sourceKeybindings = await this.readJsonArray(URI.joinPath(source.userDataUri, 'keybindings.json'));
		if (!sourceKeybindings || sourceKeybindings.length === 0) {
			return false;
		}

		const targetResource = this.userDataProfileService.currentProfile.keybindingsResource;
		const existingKeybindings = await this.readJsonArray(targetResource) ?? [];

		const merged = [...existingKeybindings];
		for (const entry of sourceKeybindings) {
			const isDuplicate = existingKeybindings.some(existing => this.deepEqual(existing, entry));
			if (!isDuplicate) {
				merged.push(entry);
			}
		}

		if (merged.length === existingKeybindings.length) {
			return false;
		}

		try {
			await this.fileService.writeFile(targetResource, VSBuffer.fromString(JSON.stringify(merged, null, '\t')));
			return true;
		} catch (error) {
			this.logService.error('[externalEditorImport] Failed to import keybindings', error);
			return false;
		}
	}

	// =====================================================================
	// Snippets
	// =====================================================================

	private async importSnippets(source: IExternalEditorSource): Promise<number> {
		const sourceSnippetsHome = URI.joinPath(source.userDataUri, 'snippets');
		let sourceStat;
		try {
			sourceStat = await this.fileService.resolve(sourceSnippetsHome);
		} catch (error) {
			this.logService.error('[externalEditorImport] Failed to read snippets', error);
			return 0;
		}

		if (!sourceStat.children?.length) {
			return 0;
		}

		const targetSnippetsHome = this.userDataProfileService.currentProfile.snippetsHome;
		let imported = 0;
		for (const child of sourceStat.children) {
			if (child.isDirectory) {
				continue;
			}
			const targetUri = URI.joinPath(targetSnippetsHome, child.name);
			// Do not overwrite snippets the user already has.
			if (await this.safeExists(targetUri)) {
				continue;
			}
			try {
				const content = await this.fileService.readFile(child.resource);
				await this.fileService.writeFile(targetUri, content.value);
				imported++;
			} catch (error) {
				this.logService.error(`[externalEditorImport] Failed to import snippet ${child.name}`, error);
			}
		}

		return imported;
	}

	// =====================================================================
	// Extensions
	// =====================================================================

	private async importExtensions(source: IExternalEditorSource, token?: CancellationToken): Promise<{ installed: number; failed: number }> {
		if (!source.extensionsManifestUri) {
			return { installed: 0, failed: 0 };
		}

		const identifiers = await this.readExtensionIdentifiers(source.extensionsManifestUri);
		if (identifiers.length === 0) {
			return { installed: 0, failed: 0 };
		}

		const installed = await this.extensionManagementService.getInstalled();
		const toQuery = identifiers.filter(identifier => !installed.some(local => areSameExtensions(local.identifier, identifier)));
		if (toQuery.length === 0) {
			return { installed: 0, failed: 0 };
		}

		let galleryExtensions;
		try {
			galleryExtensions = await this.extensionGalleryService.getExtensions(toQuery.map(identifier => ({ id: identifier.id })), token ?? CancellationToken.None);
		} catch (error) {
			this.logService.error('[externalEditorImport] Failed to query extensions from gallery', error);
			return { installed: 0, failed: toQuery.length };
		}

		if (galleryExtensions.length === 0) {
			return { installed: 0, failed: 0 };
		}

		const installExtensionInfos: InstallExtensionInfo[] = galleryExtensions.map(extension => ({
			extension,
			options: { context: { [EXTENSION_INSTALL_SKIP_WALKTHROUGH_CONTEXT]: true } },
		}));

		try {
			const results = await this.extensionManagementService.installGalleryExtensions(installExtensionInfos);
			const failed = results.filter(result => !result.local).length;
			return { installed: results.length - failed, failed };
		} catch (error) {
			this.logService.error('[externalEditorImport] Failed to install extensions', error);
			return { installed: 0, failed: installExtensionInfos.length };
		}
	}

	private async readExtensionIdentifiers(manifestUri: URI): Promise<IExtensionIdentifier[]> {
		const manifest = await this.readJsonArray(manifestUri);
		if (!manifest) {
			return [];
		}

		const identifiers: IExtensionIdentifier[] = [];
		const seen = new Set<string>();
		for (const entry of manifest) {
			const identifier = (entry as { identifier?: { id?: unknown; uuid?: unknown } } | null)?.identifier;
			const id = identifier?.id;
			if (typeof id !== 'string' || !id) {
				continue;
			}
			const key = id.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			const uuid = identifier?.uuid;
			identifiers.push({ id, uuid: typeof uuid === 'string' ? uuid : undefined });
		}

		return identifiers;
	}

	// =====================================================================
	// Helpers
	// =====================================================================

	/**
	 * Returns the platform application-data directory that contains per-product
	 * folders (e.g. `Cursor`, `Code`). Returns `undefined` for unsupported platforms.
	 */
	private getApplicationDataHome(home: URI): URI | undefined {
		if (isWindows) {
			return URI.joinPath(home, 'AppData', 'Roaming');
		}
		if (isMacintosh) {
			return URI.joinPath(home, 'Library', 'Application Support');
		}
		if (isLinux) {
			return URI.joinPath(home, '.config');
		}
		return undefined;
	}

	private async safeExists(resource: URI): Promise<boolean> {
		try {
			return await this.fileService.exists(resource);
		} catch {
			return false;
		}
	}

	private async safeHasChildren(resource: URI): Promise<boolean> {
		try {
			const stat = await this.fileService.resolve(resource);
			return !!stat.children?.some(child => !child.isDirectory);
		} catch {
			return false;
		}
	}

	private async readJsonObject(resource: URI): Promise<Record<string, unknown> | undefined> {
		const parsed = await this.readJson(resource);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	}

	private async readJsonArray(resource: URI): Promise<unknown[] | undefined> {
		const parsed = await this.readJson(resource);
		return Array.isArray(parsed) ? parsed : undefined;
	}

	private async readJson(resource: URI): Promise<unknown> {
		try {
			const content = await this.fileService.readFile(resource);
			return parse(content.value.toString());
		} catch (error) {
			this.logService.trace(`[externalEditorImport] Could not read ${resource.toString()}`, error);
			return undefined;
		}
	}

	private deepEqual(a: unknown, b: unknown): boolean {
		return JSON.stringify(a) === JSON.stringify(b);
	}
}
