/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ChatAgentLocation } from '../../../../workbench/contrib/chat/common/constants.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatSlashCommandService } from '../../../../workbench/contrib/chat/common/participants/chatSlashCommands.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { SessionIsArchivedContext, SessionIsCreatedContext, SessionSupportsSideChatContext } from '../../../common/contextkeys.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';
import { SideChatEditorInput } from '../../sideChat/browser/sideChatEditorInput.js';

class BtwSlashCommandContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.btwSlashCommand';

	constructor(
		@IChatSlashCommandService slashCommandService: IChatSlashCommandService,
		@ISessionsManagementService sessionsManagementService: ISessionsManagementService,
		@IChatService chatService: IChatService,
		@IEditorService editorService: IEditorService,
		@IEditorGroupsService editorGroupsService: IEditorGroupsService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@ILogService logService: ILogService,
		@INotificationService notificationService: INotificationService,
	) {
		super();

		if (!environmentService.isSessionsWindow) {
			return;
		}

		this._register(slashCommandService.registerSlashCommand({
			command: 'btw',
			detail: localize('btw', "Ask a side question without adding it to this conversation"),
			sortText: 'z2_btw',
			executeImmediately: false,
			executeDuringRequest: true,
			silent: true,
			locations: [ChatAgentLocation.Chat],
			when: ContextKeyExpr.and(
				IsSessionsWindowContext,
				SessionIsCreatedContext,
				SessionIsArchivedContext.negate(),
				SessionSupportsSideChatContext,
			),
		}, async (prompt, _progress, _history, _location, sessionResource) => {
			const remainder = prompt.trim();
			if (!remainder) {
				notificationService.warn(localize('btw.missingPrompt', "Enter a question after `/btw`."));
				return;
			}
			const found = sessionsManagementService.getSessionForChatResource(sessionResource);
			if (!found) {
				notificationService.warn(localize('btw.sessionUnavailable', "A side chat cannot be created from this conversation."));
				return;
			}
			const { session, chat } = found;
			if (session.status.get() === SessionStatus.Untitled || session.isArchived.get() || !session.capabilities.get().supportsSideChat) {
				notificationService.warn(localize('btw.unsupported', "This conversation does not support side chats."));
				return;
			}

			const sourceTurn = chatService.getSession(chat.resource)?.getRequests().at(-1);
			if (!sourceTurn) {
				logService.warn('[btw] No turn to branch a side chat from');
				notificationService.warn(localize('btw.noTurn', "Send a message in this conversation before starting a side chat."));
				return;
			}

			let sideChat;
			try {
				sideChat = await sessionsManagementService.createSideChatInSession(session, chat.resource, sourceTurn.id);
			} catch (err) {
				logService.error('[btw] Failed to create side chat', err);
				notificationService.error(localize('btw.createFailed', "The side chat could not be created."));
				return;
			}

			const group = editorGroupsService.mainPart.activeGroup;
			await editorService.openEditor(instantiationService.createInstance(SideChatEditorInput), { pinned: true, index: group.count }, group);
			await sessionsManagementService.sendRequest(session, sideChat, { query: remainder, background: true });
		}));
	}
}

registerWorkbenchContribution2(BtwSlashCommandContribution.ID, BtwSlashCommandContribution, WorkbenchPhase.Eventually);
