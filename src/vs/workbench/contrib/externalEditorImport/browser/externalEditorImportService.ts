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
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
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
	/**
	 * Keys in the source editor's `globalStorage/storage.json` that hold the label of the
	 * user's currently selected color theme. Forks such as Cursor persist the active theme
	 * here (under their own namespace) rather than in `settings.json`, so we consult these to
	 * recover the user's real theme choice. Checked in order; the first string value wins.
	 */
	readonly themeStateNameKeys?: readonly string[];
}

const KNOWN_EDITORS: readonly IKnownEditorDescriptor[] = [
	{
		id: 'cursor',
		label: 'Cursor',
		appDataFolder: 'Cursor',
		extensionsDirSegments: ['.cursor', 'extensions'],
		themeStateNameKeys: ['glass.theme.settingsId'],
	},
];

/**
 * The base kind of a color theme, mirroring VS Code's UI theme types.
 */
type ColorThemeKind = 'light' | 'dark' | 'hc-dark' | 'hc-light';

/**
 * The closest VS Code built-in default theme for each color theme kind. Used to map a source
 * editor's selected theme — which is frequently a proprietary theme VS Code does not ship — onto
 * an equivalent theme that always exists here.
 */
const DEFAULT_THEME_BY_KIND: Record<ColorThemeKind, string> = {
	'light': 'Light Modern',
	'dark': 'Dark Modern',
	'hc-dark': 'Dark High Contrast',
	'hc-light': 'Light High Contrast',
};

/**
 * VS Code base theme identifiers (`uiTheme`) as persisted in `globalStorage/storage.json`, mapped
 * to their color theme kind.
 */
const BASE_THEME_TO_KIND: Record<string, ColorThemeKind> = {
	'vs': 'light',
	'vs-dark': 'dark',
	'hc-black': 'hc-dark',
	'hc-light': 'hc-light',
};

/**
 * Settings keys (or prefixes) that should never be imported because they are
 * specific to the source editor and have no meaning in VS Code.
 */
const SETTINGS_KEY_BLOCKLIST_PREFIXES: readonly string[] = [
	'cursor.',
	'cursorai.',
	'aicontext.',
];

/**
 * Settings keys that express a color theme preference. These are handled specially rather than
 * bulk-imported: forks frequently rely on OS-driven auto-detection or a proprietary theme that has
 * no VS Code equivalent, so instead of copying them verbatim we resolve the source's effective
 * theme and pin the closest VS Code built-in theme. See {@link resolveColorThemeId}.
 */
const THEME_SETTING_KEYS: readonly string[] = [
	'workbench.colorTheme',
	'workbench.preferredDarkColorTheme',
	'workbench.preferredLightColorTheme',
	'workbench.preferredHighContrastColorTheme',
	'workbench.preferredHighContrastLightColorTheme',
	'window.autoDetectColorScheme',
];

const COLOR_THEME_SETTING_KEY = 'workbench.colorTheme';

/**
 * Some source editors (notably Cursor) ship their own forks of Microsoft extensions under a
 * different publisher — e.g. Cursor publishes the Remote extensions under `anysphere.*`. Those
 * identifiers do not exist on the VS Code Marketplace, so importing them verbatim always fails and
 * surfaces a spurious warning even though the genuine extension is installable. Map the known forks
 * onto their Marketplace equivalents so the real extension gets installed instead. Keys are
 * lowercased source extension ids.
 */
const EXTENSION_ID_REMAP: ReadonlyMap<string, string> = new Map([
	['anysphere.remote-ssh', 'ms-vscode-remote.remote-ssh'],
	['anysphere.remote-wsl', 'ms-vscode-remote.remote-wsl'],
	['anysphere.remote-containers', 'ms-vscode-remote.remote-containers'],
]);

export class ExternalEditorImportService extends Disposable implements IExternalEditorImportService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IJSONEditingService private readonly jsonEditingService: IJSONEditingService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async detectSources(token?: CancellationToken): Promise<IExternalEditorSource[]> {
		// Detection reads the local machine's application-data directory. In a remote window the
		// workbench file system operates against the remote host, so local detection would either
		// find nothing or inspect the wrong machine. Skip it entirely in that case.
		if (this.environmentService.remoteAuthority) {
			return [];
		}

		const home = await this.pathService.userHome({ preferLocal: true });
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
				const colorThemeId = hasSettings ? await this.resolveColorThemeId(editor, userDataUri, settingsUri) : undefined;
				sources.push({
					id: editor.id,
					label: editor.label,
					userDataUri,
					extensionsManifestUri: hasExtensions ? extensionsManifestUri : undefined,
					hasSettings,
					hasKeybindings,
					hasSnippets,
					hasExtensions,
					hasTheme: !!colorThemeId,
					colorThemeId,
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
			// Theme keys are represented by the resolved color theme (added below), not copied verbatim.
			if (Object.prototype.hasOwnProperty.call(existingSettings, key) || this.isBlockedSettingKey(key) || this.isThemeSettingKey(key)) {
				continue;
			}
			keys.push(key);
		}
		if (this.willApplyColorTheme(source, existingSettings)) {
			keys.push(COLOR_THEME_SETTING_KEY);
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
			// Never overwrite settings the user already has, skip source-specific keys, and defer
			// theme keys — they are applied via the resolved color theme below.
			if (Object.prototype.hasOwnProperty.call(existingSettings, key) || this.isBlockedSettingKey(key) || this.isThemeSettingKey(key)) {
				continue;
			}
			edits.push({ path: [key], value: sourceSettings[key] });
		}

		// Pin the source editor's effective color theme (mapped to the closest VS Code built-in),
		// unless the user already chose one.
		if (this.willApplyColorTheme(source, existingSettings)) {
			edits.push({ path: [COLOR_THEME_SETTING_KEY], value: source.colorThemeId });
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

	private isThemeSettingKey(key: string): boolean {
		return THEME_SETTING_KEYS.includes(key);
	}

	/**
	 * Whether importing would pin a resolved color theme, i.e. the source had a detectable theme
	 * and the user has not already chosen one.
	 */
	private willApplyColorTheme(source: IExternalEditorSource, existingSettings: Record<string, unknown>): boolean {
		return !!source.colorThemeId && !Object.prototype.hasOwnProperty.call(existingSettings, COLOR_THEME_SETTING_KEY);
	}

	/**
	 * Resolves the source editor's effective color theme to the closest VS Code built-in theme.
	 *
	 * Resolution order:
	 * 1. An explicit `workbench.colorTheme` in the source's `settings.json` is used as-is.
	 * 2. Otherwise the source's persisted theme state (`globalStorage/storage.json`) is consulted —
	 *    forks such as Cursor store the active theme there under their own namespace. Its kind
	 *    (light/dark/high-contrast) is mapped to the matching VS Code default theme.
	 * 3. Otherwise the `preferred*ColorTheme` / `window.autoDetectColorScheme` settings are used to
	 *    infer a kind.
	 *
	 * Returns `undefined` when no theme preference can be determined.
	 */
	private async resolveColorThemeId(editor: IKnownEditorDescriptor, userDataUri: URI, settingsUri: URI): Promise<string | undefined> {
		const settings = await this.readJsonObject(settingsUri);

		// 1. Explicit theme in settings.json wins.
		const explicit = settings?.[COLOR_THEME_SETTING_KEY];
		if (typeof explicit === 'string' && explicit) {
			return explicit;
		}

		// 2. The fork's persisted theme state (the user's real selected theme).
		const kindFromState = await this.readThemeKindFromState(editor, userDataUri);
		if (kindFromState) {
			return DEFAULT_THEME_BY_KIND[kindFromState];
		}

		// 3. Fall back to preferred-theme / auto-detect settings.
		const kindFromSettings = settings ? this.inferKindFromSettings(settings) : undefined;
		return kindFromSettings ? DEFAULT_THEME_BY_KIND[kindFromSettings] : undefined;
	}

	private async readThemeKindFromState(editor: IKnownEditorDescriptor, userDataUri: URI): Promise<ColorThemeKind | undefined> {
		const state = await this.readJsonObject(URI.joinPath(userDataUri, 'globalStorage', 'storage.json'));
		if (!state) {
			return undefined;
		}

		// Prefer the fork-specific key holding the selected theme's label (e.g. "Cursor Light"),
		// since it reflects the user's explicit choice even when the base-theme cache is stale.
		for (const key of editor.themeStateNameKeys ?? []) {
			const value = state[key];
			if (typeof value === 'string') {
				const kind = this.inferKindFromThemeName(value);
				if (kind) {
					return kind;
				}
			}
		}

		// Fall back to the standard base-theme cache (`theme` = uiTheme id).
		const baseTheme = state['theme'];
		if (typeof baseTheme === 'string') {
			return BASE_THEME_TO_KIND[baseTheme];
		}
		return undefined;
	}

	/**
	 * Infers a color theme kind from a human-readable theme label such as "Cursor Light" or
	 * "Default High Contrast". Returns `undefined` when the name gives no clear signal.
	 */
	private inferKindFromThemeName(name: string): ColorThemeKind | undefined {
		const normalized = name.toLowerCase();
		const isHighContrast = normalized.includes('high contrast') || /\bhc\b/.test(normalized);
		const isLight = normalized.includes('light');
		const isDark = normalized.includes('dark');
		if (isHighContrast) {
			return isLight ? 'hc-light' : 'hc-dark';
		}
		if (isLight) {
			return 'light';
		}
		if (isDark) {
			return 'dark';
		}
		return undefined;
	}

	/**
	 * Infers a color theme kind from the source settings' `preferred*ColorTheme` names. Used only
	 * when the persisted theme state does not resolve a kind.
	 */
	private inferKindFromSettings(settings: Record<string, unknown>): ColorThemeKind | undefined {
		const preferredHcDark = settings['workbench.preferredHighContrastColorTheme'];
		const preferredHcLight = settings['workbench.preferredHighContrastLightColorTheme'];
		const preferredDark = settings['workbench.preferredDarkColorTheme'];
		const preferredLight = settings['workbench.preferredLightColorTheme'];
		if (typeof preferredHcDark === 'string') {
			return 'hc-dark';
		}
		if (typeof preferredHcLight === 'string') {
			return 'hc-light';
		}
		if (typeof preferredDark === 'string') {
			return 'dark';
		}
		if (typeof preferredLight === 'string') {
			return 'light';
		}
		return undefined;
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
		const targetExists = await this.safeExists(targetResource);
		const existingKeybindings = targetExists ? await this.readJsonArray(targetResource) : [];

		// The target file exists but could not be parsed. Rewriting it would discard the user's
		// keybindings, so bail out rather than risk data loss.
		if (targetExists && !existingKeybindings) {
			this.logService.warn('[externalEditorImport] Existing keybindings.json could not be parsed; skipping keybindings import');
			return false;
		}

		const newEntries = sourceKeybindings.filter(entry => !existingKeybindings!.some(existing => this.deepEqual(existing, entry)));
		if (newEntries.length === 0) {
			return false;
		}

		try {
			if (!targetExists) {
				// No existing file to preserve, so create it with the new entries directly.
				await this.fileService.writeFile(targetResource, VSBuffer.fromString(JSON.stringify(newEntries, null, '\t')));
			} else {
				// Append via JSONC-aware editing so the user's comments and formatting are preserved.
				const edits: IJSONValue[] = newEntries.map(value => ({ path: [-1], value }));
				await this.jsonEditingService.write(targetResource, edits, true);
			}
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

		// Extensions that could not be resolved in the gallery (e.g. not published on the
		// Marketplace) count as failures so callers can report an accurate outcome.
		const unresolved = toQuery.length - galleryExtensions.length;
		if (galleryExtensions.length === 0) {
			return { installed: 0, failed: unresolved };
		}

		const installExtensionInfos: InstallExtensionInfo[] = galleryExtensions.map(extension => ({
			extension,
			options: { context: { [EXTENSION_INSTALL_SKIP_WALKTHROUGH_CONTEXT]: true } },
		}));

		try {
			const results = await this.extensionManagementService.installGalleryExtensions(installExtensionInfos);
			const installFailed = results.filter(result => !result.local).length;
			return { installed: results.length - installFailed, failed: unresolved + installFailed };
		} catch (error) {
			this.logService.error('[externalEditorImport] Failed to install extensions', error);
			return { installed: 0, failed: unresolved + installExtensionInfos.length };
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
			const rawId = identifier?.id;
			if (typeof rawId !== 'string' || !rawId) {
				continue;
			}
			// Remap known source-editor forks (e.g. Cursor's `anysphere.*` Remote extensions) to
			// their VS Code Marketplace equivalents. When remapped, the fork's uuid no longer
			// applies and must be dropped so the identifier is matched by id instead.
			const remapped = EXTENSION_ID_REMAP.get(rawId.toLowerCase());
			const id = remapped ?? rawId;
			const key = id.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			const uuid = remapped ? undefined : identifier?.uuid;
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
