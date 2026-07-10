/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IColorCustomizations } from '../../../../services/themes/common/workbenchThemeService.js';
import { ColorThemeData } from '../../../../services/themes/common/colorThemeData.js';
import { ITitleBarColorCustomizations } from '../../../../../platform/theme/common/themeService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getPartsSplashColorInfo } from '../../common/partsSplash.js';

suite('Parts Splash', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const defaultModernThemeColors = {
		'titleBar.activeBackground': '#181818',
		'titleBar.activeForeground': '#CCCCCC',
		'titleBar.inactiveBackground': '#1F1F1F',
		'titleBar.inactiveForeground': '#9D9D9D',
		'titleBar.border': '#2B2B2B'
	};
	const titleBarDefaults: ITitleBarColorCustomizations = {
		activeForeground: false,
		inactiveForeground: false,
		activeBackground: false,
		inactiveBackground: false,
		border: false
	};

	function getTitleBarColorCustomizations(colors: IColorCustomizations): ITitleBarColorCustomizations | undefined {
		return getColorInfo(colors).titleBarColorCustomizations;
	}

	function getColorInfo(colors: IColorCustomizations) {
		const themeData = ColorThemeData.createUnloadedTheme('vs-dark default-modern', defaultModernThemeColors);
		themeData.setCustomColors(colors);
		return getPartsSplashColorInfo(themeData);
	}

	test('serializes title bar color customizations independently', () => {
		assert.deepStrictEqual([
			getTitleBarColorCustomizations({}),
			getTitleBarColorCustomizations({ 'titleBar.activeForeground': '#FF0000' }),
			getTitleBarColorCustomizations({ 'titleBar.inactiveForeground': '#FF0000' }),
			getTitleBarColorCustomizations({ 'titleBar.activeBackground': '#FF0000' }),
			getTitleBarColorCustomizations({ 'titleBar.inactiveBackground': '#FF0000' }),
			getTitleBarColorCustomizations({ 'titleBar.border': '#FF0000' }),
			getTitleBarColorCustomizations({
				'titleBar.activeForeground': '#FF0000',
				'titleBar.activeBackground': '#FF0000',
				'titleBar.border': '#FF0000'
			}),
			getTitleBarColorCustomizations({ 'titleBar.activeBackground': 'default' })
		], [
			titleBarDefaults,
			{ ...titleBarDefaults, activeForeground: true },
			{ ...titleBarDefaults, inactiveForeground: true },
			{ ...titleBarDefaults, activeBackground: true },
			{ ...titleBarDefaults, inactiveBackground: true },
			{ ...titleBarDefaults, border: true },
			{ ...titleBarDefaults, activeForeground: true, activeBackground: true, border: true },
			titleBarDefaults
		]);
	});

	test('serializes active and inactive title bar backgrounds', () => {
		const themeData = ColorThemeData.createUnloadedTheme('vs-dark default-modern', defaultModernThemeColors);
		themeData.setCustomColors({
			'titleBar.activeBackground': '#FF0000',
			'titleBar.inactiveBackground': '#00FF00'
		});

		const colorInfo = getPartsSplashColorInfo(themeData);

		assert.deepStrictEqual({
			titleBarBackground: colorInfo.titleBarBackground,
			titleBarInactiveBackground: colorInfo.titleBarInactiveBackground,
			titleBarColorCustomizations: colorInfo.titleBarColorCustomizations
		}, {
			titleBarBackground: '#ff0000',
			titleBarInactiveBackground: '#00ff00',
			titleBarColorCustomizations: { ...titleBarDefaults, activeBackground: true, inactiveBackground: true }
		});
	});

	test('retains legacy title bar customization metadata', () => {
		assert.deepStrictEqual([
			getColorInfo({}).titleBarColorsCustomized,
			getColorInfo({ 'titleBar.activeForeground': '#FF0000' }).titleBarColorsCustomized
		], [false, true]);
	});
});
