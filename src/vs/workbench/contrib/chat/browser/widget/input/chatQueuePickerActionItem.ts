/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, addDisposableListener, EventType, getWindow } from '../../../../../../base/browser/dom.js';
import { ActionViewItem, BaseActionViewItem, IActionViewItemOptions } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Action, IAction } from '../../../../../../base/common/actions.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { IActionViewItemService } from '../../../../../../platform/actions/browser/actionViewItemService.js';
import { MenuId, SubmenuItemAction } from '../../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import { CancelChatActionId, ChatSubmitAction } from '../../actions/chatExecuteActions.js';
import { ChatQueueMessageAction, ChatSteerWithMessageAction } from '../../actions/chatQueueActions.js';

/**
 * Expanding toolbar action view item for the queue/steer picker in the chat execute toolbar.
 * Shows a primary Queue button that, on hover, expands to reveal Cancel, Stop and Send,
 * and Steer buttons sliding in from the left with animation.
 */
export class ChatQueuePickerActionItem extends BaseActionViewItem {

	private readonly _cancelAction: Action;
	private readonly _sendAction: Action;
	private readonly _steerAction: Action;
	private readonly _queueAction: Action;

	private readonly _cancelViewItem: ActionViewItem;
	private readonly _sendViewItem: ActionViewItem;
	private readonly _steerViewItem: ActionViewItem;
	private readonly _queueViewItem: ActionViewItem;

	constructor(
		action: IAction,
		_options: IActionViewItemOptions,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(undefined, action);

		const hasText = !!contextKeyService.getContextKeyValue(ChatContextKeys.inputHasText.key);

		// Cancel -- always enabled
		this._cancelAction = this._register(new Action(
			'chat.expandingCancel',
			localize('interactive.cancel.label', "Cancel"),
			ThemeIcon.asClassName(Codicon.stopCircle),
			true,
			() => this.commandService.executeCommand(CancelChatActionId)
		));
		this._cancelViewItem = this._register(new ActionViewItem(undefined, this._cancelAction, { icon: true, label: false }));

		// Stop and Send
		this._sendAction = this._register(new Action(
			'chat.expandingSend',
			localize('chat.sendImmediately', "Stop and Send"),
			ThemeIcon.asClassName(Codicon.arrowRight),
			hasText,
			() => this.commandService.executeCommand(ChatSubmitAction.ID)
		));
		this._sendViewItem = this._register(new ActionViewItem(undefined, this._sendAction, { icon: true, label: false }));

		// Steer
		this._steerAction = this._register(new Action(
			'chat.expandingSteer',
			localize('chat.steerWithMessage', "Steer with Message"),
			ThemeIcon.asClassName(Codicon.arrowUp),
			hasText,
			() => this.commandService.executeCommand(ChatSteerWithMessageAction.ID)
		));
		this._steerViewItem = this._register(new ActionViewItem(undefined, this._steerAction, { icon: true, label: false }));

		// Queue (primary -- always visible)
		this._queueAction = this._register(new Action(
			'chat.expandingQueue',
			localize('chat.queueMessage', "Add to Queue"),
			ThemeIcon.asClassName(Codicon.add),
			hasText,
			() => this.commandService.executeCommand(ChatQueueMessageAction.ID)
		));
		this._queueViewItem = this._register(new ActionViewItem(undefined, this._queueAction, { icon: true, label: false }));

		// Track input text changes
		this._register(contextKeyService.onDidChangeContext(() => {
			const hasTextNow = !!contextKeyService.getContextKeyValue(ChatContextKeys.inputHasText.key);
			this._sendAction.enabled = hasTextNow;
			this._steerAction.enabled = hasTextNow;
			this._queueAction.enabled = hasTextNow;
		}));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('chat-queue-expanding-toolbar');

		// Expanded actions (slide in on hover)
		const expandedContainer = append(container, $('.chat-queue-expanded-actions'));
		this._cancelViewItem.render(append(expandedContainer, $('.action-container')));
		this._sendViewItem.render(append(expandedContainer, $('.action-container')));
		this._queueViewItem.render(append(expandedContainer, $('.action-container')));

		// Always-visible action: steer
		const alwaysVisibleContainer = append(container, $('.chat-queue-always-visible'));
		this._steerViewItem.render(append(alwaysVisibleContainer, $('.action-container')));

		// Arrow key navigation and Enter/Space activation
		const allItems = [this._cancelViewItem, this._sendViewItem, this._queueViewItem, this._steerViewItem];
		this._register(addDisposableListener(container, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
				const activeEl = getWindow(container).document.activeElement;
				const currentIndex = allItems.findIndex(item => item.element?.contains(activeEl));
				if (currentIndex === -1) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				const delta = e.key === 'ArrowRight' ? 1 : -1;
				const nextIndex = (currentIndex + delta + allItems.length) % allItems.length;
				allItems[nextIndex].focus();
			} else if (e.key === 'Enter' || e.key === ' ') {
				const currentIndex = allItems.findIndex(item => item.element?.contains(getWindow(container).document.activeElement));
				if (currentIndex !== -1) {
					e.preventDefault();
					e.stopPropagation();
					allItems[currentIndex].action.run();
				}
			}
		}));
	}

	override focus(fromRight?: boolean): void {
		this._steerViewItem.focus();
	}

	override blur(): void {
		this._cancelViewItem.blur();
		this._sendViewItem.blur();
		this._steerViewItem.blur();
		this._queueViewItem.blur();
	}

	override setFocusable(focusable: boolean): void {
		this._steerViewItem.setFocusable(focusable);
	}
}


/**
 * Workbench contribution that registers a custom action view item for the
 * queue/steer picker in the execute toolbar. This replaces the default split
 * button with a custom dropdown similar to the model switcher.
 */
export class ChatQueuePickerRendering extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'chat.queuePickerRendering';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
	) {
		super();
		this._register(actionViewItemService.register(MenuId.ChatExecute, MenuId.ChatExecuteQueue, (action, options, instantiationService) => {
			if (!(action instanceof SubmenuItemAction)) {
				return undefined;
			}
			return instantiationService.createInstance(ChatQueuePickerActionItem, action, options);
		}));
	}
}
