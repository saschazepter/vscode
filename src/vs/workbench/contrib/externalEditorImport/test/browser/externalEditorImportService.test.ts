/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IExtensionGalleryService, IExtensionManagementService, InstallExtensionInfo } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IJSONEditingService, IJSONValue } from '../../../../services/configuration/common/jsonEditing.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { ExternalEditorImportService } from '../../browser/externalEditorImportService.js';
import { IExternalEditorSource } from '../../common/externalEditorImport.js';

function applicationDataHome(home: URI): URI {
	if (isWindows) {
		return URI.joinPath(home, 'AppData', 'Roaming');
	}
	if (isMacintosh) {
		return URI.joinPath(home, 'Library', 'Application Support');
	}
	return URI.joinPath(home, '.config');
}

suite('ExternalEditorImportService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const home = URI.file('/home/tester');

	function createService(existingPaths: Set<string>, remoteAuthority?: string, fileContents?: Map<string, string>): ExternalEditorImportService {
		const fileService = {
			exists: async (resource: URI) => existingPaths.has(resource.toString()),
			readFile: async (resource: URI) => {
				const content = fileContents?.get(resource.toString());
				if (content === undefined) {
					throw new Error('not found');
				}
				return { value: VSBuffer.fromString(content) };
			},
			resolve: async (resource: URI) => {
				if (!existingPaths.has(resource.toString())) {
					throw new Error('not found');
				}
				return { children: [{ name: 'a.code-snippets', isDirectory: false, resource: URI.joinPath(resource, 'a.code-snippets') }] };
			},
		} as unknown as IFileService;

		const pathService = {
			userHome: async () => home,
		} as unknown as IPathService;

		return store.add(new ExternalEditorImportService(
			fileService,
			pathService,
			{} as unknown as IJSONEditingService,
			{} as unknown as IUserDataProfileService,
			{} as unknown as IExtensionGalleryService,
			{} as unknown as IExtensionManagementService,
			{ remoteAuthority } as unknown as IWorkbenchEnvironmentService,
			new NullLogService(),
		));
	}

	/**
	 * A minimal in-memory file system backing the reads and writes an import performs.
	 */
	class InMemoryFiles {
		constructor(private readonly contents: Map<string, string>) { }

		readonly service = {
			exists: async (resource: URI) => this.contents.has(resource.toString()),
			readFile: async (resource: URI) => {
				const content = this.contents.get(resource.toString());
				if (content === undefined) {
					throw new Error('not found');
				}
				return { value: VSBuffer.fromString(content) };
			},
			writeFile: async (resource: URI, value: VSBuffer) => {
				this.contents.set(resource.toString(), value.toString());
			},
			resolve: async (resource: URI) => {
				if (!this.contents.has(resource.toString())) {
					throw new Error('not found');
				}
				return { children: [] };
			},
		} as unknown as IFileService;

		get(resource: URI): string | undefined {
			return this.contents.get(resource.toString());
		}
	}

	const cursorUserData = URI.joinPath(applicationDataHome(home), 'Cursor', 'User');
	const keybindingsTarget = URI.file('/profile/keybindings.json');

	function cursorSource(overrides: Partial<IExternalEditorSource> = {}): IExternalEditorSource {
		return {
			id: 'cursor',
			label: 'Cursor',
			userDataUri: cursorUserData,
			extensionsManifestUri: URI.joinPath(home, '.cursor', 'extensions', 'extensions.json'),
			hasSettings: false,
			hasKeybindings: false,
			hasSnippets: false,
			hasExtensions: false,
			hasTheme: false,
			colorThemeId: undefined,
			...overrides,
		};
	}

	test('detects Cursor and reports available categories', async () => {
		const cursorUser = URI.joinPath(applicationDataHome(home), 'Cursor', 'User');
		const existing = new Set<string>([
			URI.joinPath(cursorUser, 'settings.json').toString(),
			URI.joinPath(home, '.cursor', 'extensions', 'extensions.json').toString(),
		]);

		const service = createService(existing);
		const sources = await service.detectSources();

		assert.deepStrictEqual(sources.map(s => ({
			id: s.id,
			hasSettings: s.hasSettings,
			hasKeybindings: s.hasKeybindings,
			hasSnippets: s.hasSnippets,
			hasExtensions: s.hasExtensions,
			userData: s.userDataUri.toString(),
		})), [{
			id: 'cursor',
			hasSettings: true,
			hasKeybindings: false,
			hasSnippets: false,
			hasExtensions: true,
			userData: cursorUser.toString(),
		}]);
	});

	test('resolves an explicit color theme to itself', async () => {
		const cursorUser = URI.joinPath(applicationDataHome(home), 'Cursor', 'User');
		const settingsUri = URI.joinPath(cursorUser, 'settings.json');
		const existing = new Set<string>([settingsUri.toString()]);
		const contents = new Map<string, string>([
			[settingsUri.toString(), JSON.stringify({ 'workbench.colorTheme': 'Monokai', 'editor.fontSize': 14 })],
		]);

		const service = createService(existing, undefined, contents);
		const sources = await service.detectSources();

		assert.deepStrictEqual(
			{ hasTheme: sources[0]?.hasTheme, colorThemeId: sources[0]?.colorThemeId },
			{ hasTheme: true, colorThemeId: 'Monokai' },
		);
	});

	test('maps the selected theme from state storage to the closest VS Code theme', async () => {
		const cursorUser = URI.joinPath(applicationDataHome(home), 'Cursor', 'User');
		const settingsUri = URI.joinPath(cursorUser, 'settings.json');
		const storageUri = URI.joinPath(cursorUser, 'globalStorage', 'storage.json');
		const existing = new Set<string>([settingsUri.toString()]);
		// settings.json only follows the OS; the real selection ("Cursor Light") lives in state.
		const contents = new Map<string, string>([
			[settingsUri.toString(), JSON.stringify({ 'window.autoDetectColorScheme': true })],
			[storageUri.toString(), JSON.stringify({ 'glass.theme.settingsId': 'Cursor Light', 'theme': 'vs-dark' })],
		]);

		const service = createService(existing, undefined, contents);
		const sources = await service.detectSources();

		assert.deepStrictEqual(
			{ hasTheme: sources[0]?.hasTheme, colorThemeId: sources[0]?.colorThemeId },
			{ hasTheme: true, colorThemeId: 'Light Modern' },
		);
	});

	test('maps a high-contrast base theme from state storage', async () => {
		const cursorUser = URI.joinPath(applicationDataHome(home), 'Cursor', 'User');
		const settingsUri = URI.joinPath(cursorUser, 'settings.json');
		const storageUri = URI.joinPath(cursorUser, 'globalStorage', 'storage.json');
		const existing = new Set<string>([settingsUri.toString()]);
		const contents = new Map<string, string>([
			[settingsUri.toString(), JSON.stringify({ 'editor.fontSize': 14 })],
			[storageUri.toString(), JSON.stringify({ 'theme': 'hc-black' })],
		]);

		const service = createService(existing, undefined, contents);
		const sources = await service.detectSources();

		assert.strictEqual(sources[0]?.colorThemeId, 'Dark High Contrast');
	});

	test('does not treat OS auto-detect alone as a resolved theme', async () => {
		const cursorUser = URI.joinPath(applicationDataHome(home), 'Cursor', 'User');
		const settingsUri = URI.joinPath(cursorUser, 'settings.json');
		const existing = new Set<string>([settingsUri.toString()]);
		const contents = new Map<string, string>([
			[settingsUri.toString(), JSON.stringify({ 'window.autoDetectColorScheme': true })],
		]);

		const service = createService(existing, undefined, contents);
		const sources = await service.detectSources();

		assert.deepStrictEqual(
			{ hasTheme: sources[0]?.hasTheme, colorThemeId: sources[0]?.colorThemeId },
			{ hasTheme: false, colorThemeId: undefined },
		);
	});

	test('reports no theme preference when the source settings set none', async () => {
		const cursorUser = URI.joinPath(applicationDataHome(home), 'Cursor', 'User');
		const settingsUri = URI.joinPath(cursorUser, 'settings.json');
		const existing = new Set<string>([settingsUri.toString()]);
		const contents = new Map<string, string>([
			[settingsUri.toString(), JSON.stringify({ 'editor.fontSize': 14 })],
		]);

		const service = createService(existing, undefined, contents);
		const sources = await service.detectSources();

		assert.strictEqual(sources[0]?.hasTheme, false);
	});

	test('returns no sources when nothing is installed', async () => {
		const service = createService(new Set<string>());
		const sources = await service.detectSources();
		assert.strictEqual(sources.length, 0);
	});

	test('returns no sources in a remote window', async () => {
		const cursorUser = URI.joinPath(applicationDataHome(home), 'Cursor', 'User');
		const existing = new Set<string>([URI.joinPath(cursorUser, 'settings.json').toString()]);
		const service = createService(existing, 'ssh-remote+host');
		const sources = await service.detectSources();
		assert.strictEqual(sources.length, 0);
	});

	function createImportService(options: {
		files: InMemoryFiles;
		jsonEditingService?: IJSONEditingService;
		extensionGalleryService?: IExtensionGalleryService;
		extensionManagementService?: IExtensionManagementService;
	}): ExternalEditorImportService {
		const pathService = { userHome: async () => home } as unknown as IPathService;
		const userDataProfileService = {
			currentProfile: {
				settingsResource: URI.file('/profile/settings.json'),
				keybindingsResource: keybindingsTarget,
				snippetsHome: URI.file('/profile/snippets'),
			},
		} as unknown as IUserDataProfileService;

		return store.add(new ExternalEditorImportService(
			options.files.service,
			pathService,
			options.jsonEditingService ?? ({ write: async () => { } } as unknown as IJSONEditingService),
			userDataProfileService,
			options.extensionGalleryService ?? ({} as unknown as IExtensionGalleryService),
			options.extensionManagementService ?? ({} as unknown as IExtensionManagementService),
			{ remoteAuthority: undefined } as unknown as IWorkbenchEnvironmentService,
			new NullLogService(),
		));
	}

	test('imports settings, skips theme/source keys, and pins the resolved color theme', async () => {
		const sourceSettings = URI.joinPath(cursorUserData, 'settings.json');
		const targetSettings = URI.file('/profile/settings.json');
		const files = new InMemoryFiles(new Map([
			[sourceSettings.toString(), JSON.stringify({
				'editor.fontSize': 14,
				'window.autoDetectColorScheme': true, // theme key: skipped in favour of the resolved theme
				'cursor.internal': true,              // source-specific: blocked
			})],
		]));

		const writes: { resource: URI; values: IJSONValue[] }[] = [];
		const jsonEditingService = {
			write: async (resource: URI, values: IJSONValue[]) => { writes.push({ resource, values }); },
		} as unknown as IJSONEditingService;

		const service = createImportService({ files, jsonEditingService });
		const result = await service.import(cursorSource({ hasSettings: true, hasTheme: true, colorThemeId: 'Light Modern' }), { settings: true });

		assert.strictEqual(result.settingsImported, 2);
		assert.deepStrictEqual(writes.map(w => ({ resource: w.resource.toString(), values: w.values })), [{
			resource: targetSettings.toString(),
			values: [
				{ path: ['editor.fontSize'], value: 14 },
				{ path: ['workbench.colorTheme'], value: 'Light Modern' },
			],
		}]);
	});

	test('imports keybindings by appending through the JSON editing service to preserve the existing file', async () => {
		const sourceKeybindings = URI.joinPath(cursorUserData, 'keybindings.json');
		const files = new InMemoryFiles(new Map([
			[sourceKeybindings.toString(), JSON.stringify([{ key: 'ctrl+a', command: 'a' }, { key: 'ctrl+b', command: 'b' }])],
			// Existing file contains a comment and one of the source entries already.
			[keybindingsTarget.toString(), '// user keybindings\n[\n\t{ "key": "ctrl+a", "command": "a" }\n]'],
		]));

		const writes: { resource: URI; values: IJSONValue[] }[] = [];
		const jsonEditingService = {
			write: async (resource: URI, values: IJSONValue[]) => { writes.push({ resource, values }); },
		} as unknown as IJSONEditingService;

		const service = createImportService({ files, jsonEditingService });
		const result = await service.import(cursorSource({ hasKeybindings: true }), { keybindings: true });

		assert.strictEqual(result.keybindingsImported, true);
		// Only the new (ctrl+b) entry is appended, via the JSON editing service (not a raw rewrite).
		assert.deepStrictEqual(writes, [{
			resource: keybindingsTarget,
			values: [{ path: [-1], value: { key: 'ctrl+b', command: 'b' } }],
		}]);
		// The existing file (with its comment) is left untouched by a direct write.
		assert.strictEqual(files.get(keybindingsTarget), '// user keybindings\n[\n\t{ "key": "ctrl+a", "command": "a" }\n]');
	});

	test('does not overwrite a corrupt (non-array) keybindings file', async () => {
		const sourceKeybindings = URI.joinPath(cursorUserData, 'keybindings.json');
		const files = new InMemoryFiles(new Map([
			[sourceKeybindings.toString(), JSON.stringify([{ key: 'ctrl+b', command: 'b' }])],
			[keybindingsTarget.toString(), '{ "not": "an array" }'],
		]));

		let jsonWriteCalled = false;
		const jsonEditingService = { write: async () => { jsonWriteCalled = true; } } as unknown as IJSONEditingService;

		const service = createImportService({ files, jsonEditingService });
		const result = await service.import(cursorSource({ hasKeybindings: true }), { keybindings: true });

		assert.strictEqual(result.keybindingsImported, false);
		assert.strictEqual(jsonWriteCalled, false);
		// The original content is preserved rather than clobbered.
		assert.strictEqual(files.get(keybindingsTarget), '{ "not": "an array" }');
	});

	test('counts extensions missing from the gallery as failed', async () => {
		const manifest = URI.joinPath(home, '.cursor', 'extensions', 'extensions.json');
		const files = new InMemoryFiles(new Map([
			[manifest.toString(), JSON.stringify([{ identifier: { id: 'pub.a' } }, { identifier: { id: 'pub.b' } }])],
		]));

		const extensionManagementService = {
			getInstalled: async () => [],
			installGalleryExtensions: async (infos: InstallExtensionInfo[]) => infos.map(info => ({ identifier: info.extension.identifier, local: {} })),
		} as unknown as IExtensionManagementService;

		// Only one of the two requested extensions resolves in the gallery.
		const extensionGalleryService = {
			getExtensions: async () => [{ identifier: { id: 'pub.a' }, displayName: 'A' }],
		} as unknown as IExtensionGalleryService;

		const service = createImportService({ files, extensionGalleryService, extensionManagementService });
		const result = await service.import(cursorSource({ hasExtensions: true }), { extensions: true });

		assert.deepStrictEqual(
			{ installed: result.extensionsInstalled, failed: result.extensionsFailed },
			{ installed: 1, failed: 1 },
		);
	});

	test('remaps known source-editor forks to their Marketplace equivalents', async () => {
		const manifest = URI.joinPath(home, '.cursor', 'extensions', 'extensions.json');
		const files = new InMemoryFiles(new Map([
			[manifest.toString(), JSON.stringify([{ identifier: { id: 'anysphere.remote-ssh', uuid: 'anysphere-uuid' } }])],
		]));

		const extensionManagementService = {
			getInstalled: async () => [],
			installGalleryExtensions: async (infos: InstallExtensionInfo[]) => infos.map(info => ({ identifier: info.extension.identifier, local: {} })),
		} as unknown as IExtensionManagementService;

		let queriedIds: string[] = [];
		const extensionGalleryService = {
			getExtensions: async (infos: { id: string }[]) => {
				queriedIds = infos.map(info => info.id);
				return infos.map(info => ({ identifier: { id: info.id }, displayName: info.id }));
			},
		} as unknown as IExtensionGalleryService;

		const service = createImportService({ files, extensionGalleryService, extensionManagementService });
		const result = await service.import(cursorSource({ hasExtensions: true }), { extensions: true });

		assert.deepStrictEqual(
			{ queriedIds, installed: result.extensionsInstalled, failed: result.extensionsFailed },
			{ queriedIds: ['ms-vscode-remote.remote-ssh'], installed: 1, failed: 0 },
		);
	});
});
