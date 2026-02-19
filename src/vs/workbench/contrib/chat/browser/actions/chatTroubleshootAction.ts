/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatDebugService } from '../../common/chatDebugService.js';
import { chatSessionResourceToId } from '../../common/model/chatUri.js';
import { ChatViewId, IChatWidgetService } from '../chat.js';
import { CHAT_CATEGORY, CHAT_CONFIG_MENU_ID } from './chatActions.js';
import { ChatDebugEditorInput } from '../chatDebug/chatDebugEditorInput.js';

/**
 * Registers the Troubleshoot action for the chat context menu.
 */
export function registerChatTroubleshootAction() {
	registerAction2(class OpenDebugViewAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.openDebugView',
				title: localize2('chat.openDebugView.label', "Open Debug View"),
				f1: true,
				category: CHAT_CATEGORY,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const editorService = accessor.get(IEditorService);
			const chatDebugService = accessor.get(IChatDebugService);

			// Clear active session so the editor shows the home view
			chatDebugService.activeSessionId = undefined;

			await editorService.openEditor(ChatDebugEditorInput.instance, { pinned: true });
		}
	});

	registerAction2(class TroubleshootAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.troubleshoot',
				title: localize2('chat.troubleshoot.label', "View Logs"),
				f1: false,
				category: CHAT_CATEGORY,
				menu: [{
					id: MenuId.ChatContext,
					group: 'z_clear',
					order: 0
				}, {
					id: CHAT_CONFIG_MENU_ID,
					when: ContextKeyExpr.and(ChatContextKeys.enabled, ContextKeyExpr.equals('view', ChatViewId)),
					order: 15,
					group: '3_configure'
				}, {
					id: MenuId.ChatWelcomeContext,
					group: '2_settings',
					order: 1,
					when: ChatContextKeys.inChatEditor.negate()
				}]
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			console.log('[Troubleshoot] Action triggered');
			const editorService = accessor.get(IEditorService);
			const chatWidgetService = accessor.get(IChatWidgetService);
			const chatDebugService = accessor.get(IChatDebugService);

			// Get the active chat session ID from the last focused widget
			const widget = chatWidgetService.lastFocusedWidget;
			console.log('[Troubleshoot] lastFocusedWidget:', !!widget);
			const sessionResource = widget?.viewModel?.sessionResource;
			console.log('[Troubleshoot] sessionResource:', sessionResource?.toString());
			const sessionId = sessionResource ? chatSessionResourceToId(sessionResource) : '';
			console.log('[Troubleshoot] sessionId:', sessionId);
			chatDebugService.activeSessionId = sessionId;
			chatDebugService.activeViewHint = 'logs';

			// Invoke extension providers to fetch events for this session
			await chatDebugService.invokeProviders(sessionId);
			console.log('[Troubleshoot] providers invoked, events:', chatDebugService.getEvents(sessionId).length);

			console.log('[Troubleshoot] opening editor with input:', ChatDebugEditorInput.instance.typeId, ChatDebugEditorInput.instance.resource.toString());
			const editor = await editorService.openEditor(ChatDebugEditorInput.instance, { pinned: true });
			console.log('[Troubleshoot] openEditor returned:', !!editor, editor?.getId());
		}
	});
}
