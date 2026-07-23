/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { ChatAgentLocation } from '../../../../../workbench/contrib/chat/common/constants.js';
import { IChatService } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IChatModel, IChatRequestModel } from '../../../../../workbench/contrib/chat/common/model/chatModel.js';
import { IChatSlashCallback, IChatSlashCommandService, IChatSlashData } from '../../../../../workbench/contrib/chat/common/participants/chatSlashCommands.js';
import { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import { BtwSlashCommandContribution } from '../../browser/btwSlashCommand.contribution.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { IChat, ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';

suite('BtwSlashCommandContribution', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('opens the created side chat through the sessions service before sending', async () => {
		const store = disposables.add(new DisposableStore());
		const instantiationService = store.add(new TestInstantiationService());
		let registered: { data: IChatSlashData; callback: IChatSlashCallback } | undefined;
		instantiationService.stub(IChatSlashCommandService, {
			_serviceBrand: undefined,
			onDidChangeCommands: Event.None,
			registerSlashCommand: (data, callback) => {
				registered = { data, callback };
				return toDisposable(() => undefined);
			},
			executeCommand: async () => undefined,
			getCommands: () => [],
			hasCommand: () => false,
		});
		instantiationService.stub(IWorkbenchEnvironmentService, upcastPartial<IWorkbenchEnvironmentService>({ isSessionsWindow: true }));
		instantiationService.stub(IChatService, upcastPartial<IChatService>({
			getSession: () => upcastPartial<IChatModel>({ getRequests: () => [upcastPartial<IChatRequestModel>({ id: 'turn-1' })] }),
		}));
		const sourceChat = upcastPartial<IChat>({ resource: URI.parse('test:///chat/source') });
		const sideChat = upcastPartial<IChat>({ resource: URI.parse('test:///chat/side') });
		const session = upcastPartial<ISession>({
			sessionId: 'session',
			resource: URI.parse('test:///session'),
			status: constObservable(SessionStatus.Completed),
			isArchived: constObservable(false),
			capabilities: constObservable({ supportsMultipleChats: true, supportsSideChat: true }),
		});
		const callOrder: string[] = [];
		instantiationService.stub(ISessionsManagementService, upcastPartial<ISessionsManagementService>({
			getSessionForChatResource: resource => resource.toString() === sourceChat.resource.toString() ? { session, chat: sourceChat } : undefined,
			createSideChatInSession: async () => {
				callOrder.push('create');
				return sideChat;
			},
			sendRequest: async (_session, chat, options) => {
				callOrder.push(`send:${chat.resource.toString()}:${options.query}`);
			},
		}));
		instantiationService.stub(ISessionsService, upcastPartial<ISessionsService>({
			openChat: async (_session, chatUri) => {
				callOrder.push(`open:${chatUri.toString()}`);
			},
		}));
		instantiationService.stub(INotificationService, new TestNotificationService());
		instantiationService.stub(ILogService, new NullLogService());

		const contribution = instantiationService.createInstance(BtwSlashCommandContribution);
		store.add(contribution);

		assert.ok(registered);
		assert.strictEqual(registered.data.executeDuringRequest, true);

		await registered.callback(
			'what about this?',
			{ report: () => undefined },
			[],
			ChatAgentLocation.Chat,
			sourceChat.resource,
			CancellationToken.None,
		);

		assert.deepStrictEqual(callOrder, [
			'create',
			`open:${sideChat.resource.toString()}`,
			`send:${sideChat.resource.toString()}:what about this?`,
		]);
	});
});
