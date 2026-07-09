/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $ } from '../../../../browser/dom.js';
import { ContextView, ContextViewDOMPosition, IDelegate } from '../../../../browser/ui/contextview/contextview.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../common/utils.js';

suite('ContextView', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('hide() is re-entrant safe and does not double-dispose render result (#319393)', () => {
		const container = $('.container');
		const contextView = new ContextView(container, ContextViewDOMPosition.ABSOLUTE);

		let disposeCount = 0;
		const delegate: IDelegate = {
			getAnchor: () => ({ x: 0, y: 0 }),
			render: () => ({
				dispose: () => {
					disposeCount++;
					if (disposeCount === 1) {
						// Simulate a re-entrant hide() call (e.g. via a blur event
						// fired while removing the rendered DOM node from the document).
						contextView.hide();
					}
				}
			})
		};

		contextView.show(delegate);

		assert.doesNotThrow(() => contextView.hide());
		assert.strictEqual(disposeCount, 1, 'render disposable must be disposed exactly once');

		contextView.dispose();
		container.remove();
	});

	test('hide() delays render disposal for close animations', () => {
		const container = $('.container');
		container.classList.add('style-override', 'monaco-enable-motion');
		const contextView = new ContextView(container, ContextViewDOMPosition.ABSOLUTE);

		let disposeCount = 0;
		const delegate: IDelegate = {
			getAnchor: () => ({ x: 0, y: 0 }),
			render: () => ({
				dispose: () => {
					disposeCount++;
				}
			}),
			closeAnimation: {
				className: 'closing',
				duration: 100,
				requiredAncestorClasses: ['style-override', 'monaco-enable-motion']
			}
		};

		contextView.show(delegate);
		contextView.hide();

		assert.deepStrictEqual({
			disposeCount,
			hasClosingClass: contextView.getViewElement().classList.contains('closing')
		}, {
			disposeCount: 0,
			hasClosingClass: true
		});

		contextView.dispose();
		container.remove();
	});
});
