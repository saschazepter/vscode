/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ITitleBarColorCustomizations } from '../../../theme/common/themeService.js';
import { dimWindowControlsColor, getWindowControlsOverlayColors } from '../../electron-main/windows.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

suite('Window Controls Overlay', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const titleBarCustomizations: ITitleBarColorCustomizations = {
		activeForeground: false,
		inactiveForeground: false,
		activeBackground: false,
		inactiveBackground: false,
		border: false
	};

	test('uses splash colors for initial window controls', () => {
		assert.deepStrictEqual([
			getWindowControlsOverlayColors({
				editorBackground: '#FFFFFF',
				titleBarBackground: '#181818',
				titleBarForeground: '#CCCCCC',
				titleBarColorCustomizations: titleBarCustomizations
			}, true, '#1E1E1E'),
			getWindowControlsOverlayColors({
				editorBackground: '#181818',
				titleBarBackground: 'rgba(255, 255, 255, 0.5)',
				titleBarForeground: 'rgba(1, 2, 3, 0.5)',
				titleBarColorCustomizations: { ...titleBarCustomizations, activeForeground: true }
			}, false, '#1E1E1E'),
			getWindowControlsOverlayColors({
				editorBackground: '#181818',
				titleBarBackground: 'rgba(invalid)',
				titleBarForeground: undefined,
				titleBarColorCustomizations: titleBarCustomizations
			}, false, '#1E1E1E'),
			getWindowControlsOverlayColors({
				editorBackground: '#FFFFFF',
				titleBarBackground: 'rgba(0, 0, 0, 0.1)',
				titleBarForeground: undefined,
				titleBarColorCustomizations: { ...titleBarCustomizations, activeBackground: true }
			}, true, '#1E1E1E'),
			getWindowControlsOverlayColors({
				editorBackground: '#181818',
				titleBarBackground: 'rgba(0, 0, 0, 0.1)',
				titleBarForeground: undefined,
				titleBarColorCustomizations: { ...titleBarCustomizations, activeBackground: true }
			}, true, '#1E1E1E'),
			getWindowControlsOverlayColors({
				editorBackground: '#FFFFFF',
				titleBarBackground: undefined,
				titleBarForeground: undefined,
				titleBarColorCustomizations: titleBarCustomizations
			}, false, 'rgba(0, 0, 0, 0.1)')
		], [
			{ color: 'transparent', symbolColor: '#000000' },
			{ color: 'rgba(255, 255, 255, 0.5)', symbolColor: 'rgba(1, 2, 3, 0.5)' },
			{ color: 'rgba(invalid)', symbolColor: '#FFFFFF' },
			{ color: 'rgba(0, 0, 0, 0.1)', symbolColor: '#000000' },
			{ color: 'rgba(0, 0, 0, 0.1)', symbolColor: '#FFFFFF' },
			{ color: 'rgba(0, 0, 0, 0.1)', symbolColor: '#000000' }
		]);
	});

	test('preserves window control color alpha when dimming', () => {
		assert.deepStrictEqual([
			dimWindowControlsColor('transparent'),
			dimWindowControlsColor('rgba(255, 255, 255, 0.5)'),
			dimWindowControlsColor('#FFFFFF'),
			dimWindowControlsColor('invalid')
		], [
			'rgba(0, 0, 0, 0)',
			'rgba(128, 128, 128, 0.5)',
			'rgb(128, 128, 128)',
			'invalid'
		]);
	});
});
