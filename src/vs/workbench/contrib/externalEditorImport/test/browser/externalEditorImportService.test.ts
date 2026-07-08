/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IExtensionGalleryService, IExtensionManagementService } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { IJSONEditingService } from '../../../../services/configuration/common/jsonEditing.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { ExternalEditorImportService } from '../../browser/externalEditorImportService.js';

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

	function createService(existingPaths: Set<string>): ExternalEditorImportService {
		const fileService = {
			exists: async (resource: URI) => existingPaths.has(resource.toString()),
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
			new NullLogService(),
		));
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

	test('returns no sources when nothing is installed', async () => {
		const service = createService(new Set<string>());
		const sources = await service.detectSources();
		assert.strictEqual(sources.length, 0);
	});
});
