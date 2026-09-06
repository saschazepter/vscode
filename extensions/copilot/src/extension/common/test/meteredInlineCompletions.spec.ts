/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert, suite, test } from 'vitest';
import { shouldSkipInlineCompletion } from '../meteredInlineCompletions';

suite('Metered inline completions', () => {
	test('skips only automatic requests on metered connections', () => {
		assert.deepStrictEqual([
			shouldSkipInlineCompletion(true, false),
			shouldSkipInlineCompletion(false, false),
			shouldSkipInlineCompletion(true, true),
			shouldSkipInlineCompletion(false, true),
		], [false, false, true, false]);
	});
});
