/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ChatContextKeys } from '../../../contrib/chat/common/actions/chatContextKeys.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IChatWidgetService } from '../../../contrib/chat/browser/chat.js';
import { ChatModel, IExportableChatData } from '../../../contrib/chat/common/model/chatModel.js';
import { IChatEditorOptions } from '../../../contrib/chat/browser/widgetHosts/editor/chatEditor.js';
import { ChatEditorInput } from '../../../contrib/chat/browser/widgetHosts/editor/chatEditorInput.js';
import { ACTIVE_GROUP } from '../../../services/editor/common/editorService.js';
import { IChatExecuteActionContext } from '../../../contrib/chat/browser/actions/chatExecuteActions.js';
import { revive } from '../../../../base/common/marshalling.js';


/**
 * Action ID for branching chat session to a new local session.
 */
export const ACTION_ID_BRANCH_CHAT_SESSION = 'workbench.action.chat.branchChatSession';

/**
 * Action that allows users to branch the current chat session to a new local session.
 * This creates a copy of the current conversation while keeping the original session intact.
 */
export class BranchChatSessionAction extends Action2 {

	static readonly ID = ACTION_ID_BRANCH_CHAT_SESSION;

	constructor() {
		super({
			id: BranchChatSessionAction.ID,
			title: localize2('branchChatSession', "Branch Chat"),
			tooltip: localize2('branchChatSessionTooltip', "Branch to new session"),
			icon: Codicon.reply,
			precondition: ContextKeyExpr.and(
				ChatContextKeys.enabled,
				ChatContextKeys.requestInProgress.negate(),
			),
			menu: [{
				id: MenuId.ChatExecute,
				group: 'navigation',
				order: 3.5,
				when: ContextKeyExpr.and(
					ChatContextKeys.showFullWelcome,
					ChatContextKeys.lockedToCodingAgent.negate(),
				),
			}]
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const context = args[0] as IChatExecuteActionContext | undefined;
		const widgetService = accessor.get(IChatWidgetService);

		// Get widget from context (toolbar button) or fall back to last focused widget
		const widget = context?.widget ?? widgetService.lastFocusedWidget;
		if (!widget || !widget.viewModel) {
			return;
		}

		// Get the current chat model
		const chatModel = widget.viewModel.model as ChatModel;
		if (!chatModel) {
			return;
		}

		// Export the current session data and deep clone it with proper revival of URIs and special objects
		const exportedData = revive(JSON.parse(JSON.stringify(chatModel.toExport()))) as IExportableChatData;

		// Clear sessionId to ensure a new session is created (not reusing the original)
		delete (exportedData as { sessionId?: string }).sessionId;

		// If there's no conversation history yet, don't branch
		if (exportedData.requests.length === 0) {
			return;
		}

		// Include any current input draft and attached context in the branched session
		const sessionResource = widget.viewModel.sessionResource;
		const attachedContext = widget.input.getAttachedAndImplicitContext(sessionResource);
		const currentInput = widget.getInput();

		// Use the same pattern as Import Chat for editors:
		// Pass the data in options.target.data, let ChatEditorInput create the model
		const newSessionResource = ChatEditorInput.getNewEditorUri();
		const options: IChatEditorOptions = {
			target: { data: exportedData },
			pinned: true,
		};

		const newWidget = await widgetService.openSession(newSessionResource, ACTIVE_GROUP, options);

		// After opening, set up the new session with current input if any
		if (currentInput || attachedContext.length > 0) {
			const actualSessionResource = newWidget?.viewModel?.sessionResource;
			if (actualSessionResource) {
				const foundWidget = widgetService.getWidgetBySessionResource(actualSessionResource);
				if (foundWidget) {
					// Set the input text from the original
					if (currentInput) {
						foundWidget.input.setValue(currentInput, false);
					}
					// Add attached context to the new session
					for (const entry of attachedContext.asArray()) {
						foundWidget.attachmentModel.addContext(entry);
					}
				}
			}
		}
	}
}

/**
 * Registers all chat session branching related actions.
 */
export function registerChatBranchActions() {
	registerAction2(BranchChatSessionAction);
}
