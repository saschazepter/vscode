/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { isIMenuItem, MenuRegistry } from '../../../platform/actions/common/actions.js';
import { Menus } from '../../browser/menus.js';
import { clearSidebarToggleFocusRequest, consumeSidebarToggleFocusRequest, hasSidebarToggleFocusRequest, requestSidebarToggleFocus, SidebarToggleFocusTarget } from '../../browser/sidebarToggleFocus.js';

// Import layout actions to trigger menu registration
import '../../browser/layoutActions.js';

suite('Sessions - Layout Actions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();
	teardown(() => {
		clearSidebarToggleFocusRequest();
	});

	test('always-on-top toggle action is contributed to TitleBarRight', () => {
		const items = MenuRegistry.getMenuItems(Menus.TitleBarRightLayout);
		const menuItems = items.filter(isIMenuItem);

		const toggleAlwaysOnTop = menuItems.find(item => item.command.id === 'workbench.action.toggleWindowAlwaysOnTop');

		assert.ok(toggleAlwaysOnTop, 'toggleWindowAlwaysOnTop should be contributed to TitleBarRight');
		assert.strictEqual(toggleAlwaysOnTop.group, 'navigation');
	});

	test('sidebar toggle focus request is consumed only by the matching target', () => {
		requestSidebarToggleFocus(SidebarToggleFocusTarget.Titlebar);

		assert.strictEqual(consumeSidebarToggleFocusRequest(SidebarToggleFocusTarget.Sidebar), false);
		assert.strictEqual(consumeSidebarToggleFocusRequest(SidebarToggleFocusTarget.Titlebar), true);
		assert.strictEqual(consumeSidebarToggleFocusRequest(SidebarToggleFocusTarget.Titlebar), false);
	});

	test('sidebar toggle focus request can be observed without consuming it', () => {
		requestSidebarToggleFocus(SidebarToggleFocusTarget.Sidebar);

		assert.strictEqual(hasSidebarToggleFocusRequest(SidebarToggleFocusTarget.Titlebar), false);
		assert.strictEqual(hasSidebarToggleFocusRequest(SidebarToggleFocusTarget.Sidebar), true);
		assert.strictEqual(consumeSidebarToggleFocusRequest(SidebarToggleFocusTarget.Sidebar), true);
	});

	test('clearing sidebar toggle focus request prevents later consumption', () => {
		requestSidebarToggleFocus(SidebarToggleFocusTarget.Sidebar);
		clearSidebarToggleFocusRequest();

		assert.strictEqual(consumeSidebarToggleFocusRequest(SidebarToggleFocusTarget.Sidebar), false);
	});
});
