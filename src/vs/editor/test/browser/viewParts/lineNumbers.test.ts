/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LineNumbersOverlay } from '../../../../browser/viewParts/lineNumbers/lineNumbers.js';
import { TestCodeEditorInstantiationOptions, withTestCodeEditor } from '../testCodeEditor.js';
import { Selection } from '../../../../common/core/selection.js';
import { ViewCursorStateChangedEvent } from '../../../../common/viewEvents.js';
import { CursorChangeReason } from '../../../../common/cursorEvents.js';

suite('LineNumbersOverlay', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Relative line numbers only re-render on line change, not column change', () => {
		const options: TestCodeEditorInstantiationOptions = {
			lineNumbers: 'relative'
		};

		withTestCodeEditor('line1\nline2\nline3\nline4\nline5', options, (editor) => {
			const viewModel = editor._getViewModel()!;
			const overlay = new LineNumbersOverlay(viewModel.viewModel.coordinatesConverter._context);

			// Initial cursor position at line 2
			const event1 = new ViewCursorStateChangedEvent(
				[new Selection(2, 1, 2, 1)],
				[new Selection(2, 1, 2, 1)],
				CursorChangeReason.NotSet
			);
			const shouldRender1 = overlay.onCursorStateChanged(event1);
			assert.strictEqual(shouldRender1, true, 'Should render on first cursor position change');

			// Move cursor to different column on same line (line 2, column 3)
			const event2 = new ViewCursorStateChangedEvent(
				[new Selection(2, 3, 2, 3)],
				[new Selection(2, 3, 2, 3)],
				CursorChangeReason.NotSet
			);
			const shouldRender2 = overlay.onCursorStateChanged(event2);
			assert.strictEqual(shouldRender2, false, 'Should NOT render when moving cursor on same line');

			// Move cursor to different column on same line (line 2, column 5)
			const event3 = new ViewCursorStateChangedEvent(
				[new Selection(2, 5, 2, 5)],
				[new Selection(2, 5, 2, 5)],
				CursorChangeReason.NotSet
			);
			const shouldRender3 = overlay.onCursorStateChanged(event3);
			assert.strictEqual(shouldRender3, false, 'Should NOT render when moving cursor on same line again');

			// Move cursor to different line (line 3)
			const event4 = new ViewCursorStateChangedEvent(
				[new Selection(3, 1, 3, 1)],
				[new Selection(3, 1, 3, 1)],
				CursorChangeReason.NotSet
			);
			const shouldRender4 = overlay.onCursorStateChanged(event4);
			assert.strictEqual(shouldRender4, true, 'Should render when moving to different line');

			overlay.dispose();
		});
	});

	test('Non-relative line numbers only re-render on line change', () => {
		const options: TestCodeEditorInstantiationOptions = {
			lineNumbers: 'on'
		};

		withTestCodeEditor('line1\nline2\nline3\nline4\nline5', options, (editor) => {
			const viewModel = editor._getViewModel()!;
			const overlay = new LineNumbersOverlay(viewModel.viewModel.coordinatesConverter._context);

			// Initial cursor position at line 2
			const event1 = new ViewCursorStateChangedEvent(
				[new Selection(2, 1, 2, 1)],
				[new Selection(2, 1, 2, 1)],
				CursorChangeReason.NotSet
			);
			const shouldRender1 = overlay.onCursorStateChanged(event1);
			assert.strictEqual(shouldRender1, true, 'Should render on first cursor position change');

			// Move cursor to different column on same line
			const event2 = new ViewCursorStateChangedEvent(
				[new Selection(2, 3, 2, 3)],
				[new Selection(2, 3, 2, 3)],
				CursorChangeReason.NotSet
			);
			const shouldRender2 = overlay.onCursorStateChanged(event2);
			assert.strictEqual(shouldRender2, false, 'Should NOT render when column changes on same line');

			// Move cursor to different line
			const event3 = new ViewCursorStateChangedEvent(
				[new Selection(3, 1, 3, 1)],
				[new Selection(3, 1, 3, 1)],
				CursorChangeReason.NotSet
			);
			const shouldRender3 = overlay.onCursorStateChanged(event3);
			assert.strictEqual(shouldRender3, true, 'Should render when moving to different line');

			overlay.dispose();
		});
	});
});
