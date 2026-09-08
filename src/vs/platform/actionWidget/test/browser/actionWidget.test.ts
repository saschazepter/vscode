/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as dom from '../../../../base/browser/dom.js';
import { toAction } from '../../../../base/common/actions.js';
import { Emitter } from '../../../../base/common/event.js';
import { AnchorPosition } from '../../../../base/common/layout.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IContextKeyService } from '../../../contextkey/common/contextkey.js';
import { IContextViewService } from '../../../contextview/browser/contextView.js';
import { ContextViewService } from '../../../contextview/browser/contextViewService.js';
import { IHoverService } from '../../../hover/browser/hover.js';
import { NullHoverService } from '../../../hover/test/browser/nullHoverService.js';
import { TestInstantiationService } from '../../../instantiation/test/common/instantiationServiceMock.js';
import { IKeybindingService } from '../../../keybinding/common/keybinding.js';
import { MockContextKeyService, MockKeybindingService } from '../../../keybinding/test/common/mockKeybindingService.js';
import { ILayoutService } from '../../../layout/browser/layoutService.js';
import { IOpenerService } from '../../../opener/common/opener.js';
import { NullOpenerService } from '../../../opener/test/common/nullOpenerService.js';
import { ActionListItemKind } from '../../browser/actionList.js';
import { ActionWidgetService } from '../../browser/actionWidget.js';

suite('ActionWidgetService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const container = dom.append(document.body, dom.$('div'));
		store.add({ dispose: () => container.remove() });
		const layout = store.add(new Emitter<{ container: HTMLElement; dimension: dom.IDimension }>());
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.set(ILayoutService, new class extends mock<ILayoutService>() {
			override readonly mainContainer = container;
			override readonly activeContainer = container;
			override readonly onDidLayoutContainer = layout.event;
			override getContainer() { return container; }
		}());
		instantiationService.set(IContextKeyService, store.add(new MockContextKeyService()));
		instantiationService.set(IKeybindingService, new MockKeybindingService());
		instantiationService.set(IHoverService, NullHoverService);
		instantiationService.set(IOpenerService, NullOpenerService);
		const contextView = store.add(instantiationService.createInstance(ContextViewService));
		instantiationService.set(IContextViewService, contextView);
		const service = store.add(instantiationService.createInstance(ActionWidgetService));
		return { container, layout, service };
	}

	test('closes a rich submenu once before focusing a warning dialog', () => {
		const { container, service } = setup();
		const trigger = dom.append(container, dom.$('button'));
		const warning = dom.append(container, dom.$('button'));
		const events: string[] = [];
		service.show('permissions', false, [{
			kind: ActionListItemKind.Action,
			label: 'Permissions',
			submenu: {
				id: 'permissions',
				items: [{
					kind: ActionListItemKind.Action,
					label: 'Allow All',
					item: toAction({
						id: 'allowAll', label: 'Allow All',
						run: () => {
							service.hide();
							events.push('warning');
							warning.focus();
						},
					}),
				}],
			},
		}], {
			onSelect: () => { },
			onHide: () => {
				events.push('hide');
				trigger.focus();
			},
		}, { x: 400, y: 400, width: 100, height: 24 }, undefined, [], undefined, {
			anchorPosition: AnchorPosition.ABOVE,
			initialSubmenuId: 'permissions',
		});
		const submenu = container.querySelector<HTMLElement>('.action-list-submenu-panel > .actionList')!;
		submenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		assert.deepStrictEqual({
			events,
			warningFocused: document.activeElement === warning,
			visible: service.isVisible,
		}, { events: ['hide', 'warning'], warningFocused: true, visible: false });
	});

	test('dismisses a permissions-first popup on subsequent workbench layout changes', () => {
		const { container, layout, service } = setup();
		const states = [];
		for (const initialSubmenuId of [undefined, 'permissions']) {
			let hides = 0;
			service.show('mode', false, [{
				kind: ActionListItemKind.Action,
				label: 'Permissions',
				submenu: {
					id: 'permissions',
					items: [{
						kind: ActionListItemKind.Action,
						label: 'Manual',
						item: toAction({ id: 'manual', label: 'Manual', run: () => { } }),
					}],
				},
			}], {
				onSelect: () => { },
				onHide: () => { hides++; },
			}, { x: 400, y: 400, width: 100, height: 24 }, undefined, [], undefined, {
				anchorPosition: AnchorPosition.ABOVE,
				initialSubmenuId,
			});
			const openAfterInitialLayout = service.isVisible;
			layout.fire({ container, dimension: { width: 900, height: 600 } });
			states.push({ initialSubmenuId, openAfterInitialLayout, visibleAfterResize: service.isVisible, hides });
			service.hide();
		}
		assert.deepStrictEqual(states, [
			{ initialSubmenuId: undefined, openAfterInitialLayout: true, visibleAfterResize: true, hides: 0 },
			{ initialSubmenuId: 'permissions', openAfterInitialLayout: true, visibleAfterResize: false, hides: 1 },
		]);
	});
});
