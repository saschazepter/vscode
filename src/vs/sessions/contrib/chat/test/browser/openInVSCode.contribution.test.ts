/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isISubmenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';

// Side-effect import to trigger module-level menu registration.
import '../../browser/openInVSCode.contribution.js';

const titleBarSessionMenu = MenuId.for('SessionsTitleBarSessionMenu');

suite('OpenInContribution', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('contributes open in dropdown to TitleBarSessionMenu', () => {
		const items = MenuRegistry.getMenuItems(titleBarSessionMenu);

		const openInAction = items.find(item => isISubmenuItem(item) && item.submenu.id === 'AgentSessionsOpenInDropdown');

		assert.ok(openInAction, 'open in dropdown should be contributed to TitleBarSessionMenu');
		assert.strictEqual(openInAction.order, 9);
	});
});
