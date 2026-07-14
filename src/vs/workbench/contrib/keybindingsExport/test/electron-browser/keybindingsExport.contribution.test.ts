/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getDefaultKeybindingsExportTargets } from '../../electron-browser/keybindingsExport.contribution.js';

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
});
