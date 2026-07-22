/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { getChatPetBaseState } from '../../../browser/widget/chatPetWidget.js';

suite('ChatPetWidget', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps chat activity to pet states by priority', () => {
		assert.deepStrictEqual([
			getChatPetBaseState(false, false, false),
			getChatPetBaseState(false, false, true),
			getChatPetBaseState(true, false, true),
			getChatPetBaseState(true, true, true),
		], [
			'idle',
			'sleep',
			'processing',
			'clapping',
		]);
	});
});
