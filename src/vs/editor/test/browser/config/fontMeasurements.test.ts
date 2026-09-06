/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FontMeasurementsImpl, ISerializedFontInfo } from '../../../browser/config/fontMeasurements.js';
import { FontInfo, SERIALIZED_FONT_INFO_VERSION } from '../../../common/config/fontInfo.js';

suite('FontMeasurements', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('does not serialize restored untrusted font information', () => {
		const fontMeasurements = store.add(new FontMeasurementsImpl());
		const restoredFontInfo: ISerializedFontInfo = {
			version: SERIALIZED_FONT_INFO_VERSION,
			pixelRatio: 1,
			fontFamily: 'monospace',
			fontWeight: 'normal',
			fontSize: 14,
			fontFeatureSettings: '"liga" off, "calt" off',
			fontVariationSettings: 'normal',
			lineHeight: 19,
			letterSpacing: 0,
			isMonospace: true,
			typicalHalfwidthCharacterWidth: 8,
			typicalFullwidthCharacterWidth: 14,
			canUseHalfwidthRightwardsArrow: true,
			spaceWidth: 8,
			middotWidth: 8,
			wsmiddotWidth: 14,
			maxDigitWidth: 8,
		};
		const initiallySerialized = fontMeasurements.serializeFontInfo(mainWindow);

		fontMeasurements.restoreFontInfo(mainWindow, [restoredFontInfo]);

		assert.deepStrictEqual({
			initiallySerialized,
			isTrusted: fontMeasurements.readFontInfo(mainWindow, new FontInfo(restoredFontInfo, false)).isTrusted,
			serialized: fontMeasurements.serializeFontInfo(mainWindow),
		}, {
			initiallySerialized: [],
			isTrusted: false,
			serialized: undefined,
		});
	});
});
