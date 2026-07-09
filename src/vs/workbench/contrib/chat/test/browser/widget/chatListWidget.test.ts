/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { shouldSuppressPersistedAutoScroll } from '../../../browser/widget/chatListWidget.js';

suite('ChatListWidget', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('suppresses persisted auto-scroll only within the user toggle window', () => {
		assert.deepStrictEqual({
			noToggle: shouldSuppressPersistedAutoScroll(0, 1000, 250),
			atWindowStart: shouldSuppressPersistedAutoScroll(1000, 1000, 250),
			atWindowEnd: shouldSuppressPersistedAutoScroll(1000, 1250, 250),
			afterWindow: shouldSuppressPersistedAutoScroll(1000, 1251, 250),
		}, {
			noToggle: false,
			atWindowStart: true,
			atWindowEnd: true,
			afterWindow: false,
		});
	});
});
