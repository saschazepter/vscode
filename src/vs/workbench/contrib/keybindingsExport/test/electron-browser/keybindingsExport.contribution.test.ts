/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import type { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import type { IFileService, IFileStatWithMetadata } from '../../../../../platform/files/common/files.js';
import type { ILogService } from '../../../../../platform/log/common/log.js';
import type { INativeHostService } from '../../../../../platform/native/common/native.js';
import type { IProductService } from '../../../../../platform/product/common/productService.js';
import type { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import type { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { KeybindingsExportContribution, getDefaultKeybindingsExportTargets } from '../../electron-browser/keybindingsExport.contribution.js';

suite('Keybindings export contribution', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('exports workbench keybindings to the existing filenames', () => {
		assert.deepStrictEqual(getDefaultKeybindingsExportTargets(false), [
			{ os: OperatingSystem.Windows, filename: 'doc.keybindings.win.json' },
			{ os: OperatingSystem.Macintosh, filename: 'doc.keybindings.osx.json' },
			{ os: OperatingSystem.Linux, filename: 'doc.keybindings.linux.json' },
		]);
	});

	test('exports agents window keybindings to dedicated filenames', () => {
		assert.deepStrictEqual(getDefaultKeybindingsExportTargets(true), [
			{ os: OperatingSystem.Windows, filename: 'doc.keybindings.agents.win.json' },
			{ os: OperatingSystem.Macintosh, filename: 'doc.keybindings.agents.osx.json' },
			{ os: OperatingSystem.Linux, filename: 'doc.keybindings.agents.linux.json' },
		]);
	});

	test('main workbench export opens the agents window and closes the current window', async () => {
		const calls: string[] = [];
		const completion = createContribution(false, calls);

		await completion.p;

		assert.deepStrictEqual(calls, [
			'writeFile:/tmp/doc.keybindings.win.json',
			'writeFile:/tmp/doc.keybindings.osx.json',
			'writeFile:/tmp/doc.keybindings.linux.json',
			'openAgentsWindow',
			'closeWindow',
		]);
	});

	test('agents window export quits after writing its files', async () => {
		const calls: string[] = [];
		const completion = createContribution(true, calls);

		await completion.p;

		assert.deepStrictEqual(calls, [
			'writeFile:/tmp/doc.keybindings.agents.win.json',
			'writeFile:/tmp/doc.keybindings.agents.osx.json',
			'writeFile:/tmp/doc.keybindings.agents.linux.json',
			'quit',
		]);
	});
});

function createContribution(isSessionsWindow: boolean, calls: string[]): DeferredPromise<void> {
	const completion = new DeferredPromise<void>();
	const nativeEnvironmentService = { exportDefaultKeybindings: '/tmp' } as INativeEnvironmentService;
	const workbenchEnvironmentService = { isSessionsWindow } as IWorkbenchEnvironmentService;
	const fileService = {
		writeFile: async (resource: URI) => {
			calls.push(`writeFile:${resource.path}`);
			return { resource } as IFileStatWithMetadata;
		}
	} as Partial<IFileService> as IFileService;
	const nativeHostService = {
		openAgentsWindow: async () => {
			calls.push('openAgentsWindow');
		},
		closeWindow: async () => {
			calls.push('closeWindow');
			completion.complete();
		},
		quit: async () => {
			calls.push('quit');
			completion.complete();
		}
	} as Partial<INativeHostService> as INativeHostService;
	const productService = { quality: 'insider' } as IProductService;
	const extensionService = {
		extensions: [],
		whenInstalledExtensionsRegistered: async () => true
	} as Partial<IExtensionService> as IExtensionService;
	const logService = {
		info: (..._args: unknown[]) => { /* no-op */ },
		error: (..._args: unknown[]) => { /* no-op */ }
	} as Partial<ILogService> as ILogService;

	new KeybindingsExportContribution(
		nativeEnvironmentService,
		workbenchEnvironmentService,
		fileService,
		nativeHostService,
		productService,
		extensionService,
		logService,
	);
	return completion;
}
