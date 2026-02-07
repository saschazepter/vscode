/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IDialogService, IConfirmation, IConfirmationResult } from '../../../../../../platform/dialogs/common/dialogs.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IChatWidgetService, IChatWidget } from '../../../browser/chat.js';
import { IChatService } from '../../../common/chatService/chatService.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { MockChatWidgetService } from '../widget/mockChatWidget.js';
import { MockChatService } from '../../common/chatService/mockChatService.js';
import { IChatModel } from '../../../common/model/chatModel.js';

suite('SendToNewChatAction', () => {
	const store = new DisposableStore();
	let instantiationService: TestInstantiationService;

	// Register actions once for all tests
	let actionsRegistered = false;
	function ensureActionsRegistered(): void {
		if (!actionsRegistered) {
			// Actions are registered when the module is loaded, so we just import it
			require('../../../browser/actions/chatExecuteActions.js');
			actionsRegistered = true;
		}
	}

	setup(() => {
		instantiationService = store.add(new TestInstantiationService());
		ensureActionsRegistered();
	});

	teardown(() => {
		store.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('should clear input when sending to new chat', async () => {
		const sessionResource = URI.parse('test://session');
		const inputText = 'test prompt';
		let inputCleared = false;
		let inputAccepted = false;
		let sessionCleared = false;

		const mockWidget: Partial<IChatWidget> = {
			getInput: () => inputText,
			setInput: (value: string) => {
				if (value === '') {
					inputCleared = true;
				}
			},
			clear: async () => {
				sessionCleared = true;
			},
			acceptInput: async (query?: string) => {
				inputAccepted = true;
				assert.strictEqual(query, inputText, 'Should accept the original input text');
				return undefined;
			},
			viewModel: {
				model: undefined,
				sessionResource
			} as any
		};

		// Create MockChatWidgetService with widget lookup
		const mockChatWidgetService = new class extends MockChatWidgetService {
			override get lastFocusedWidget() {
				return mockWidget as IChatWidget;
			}
		};

		const mockChatService = new class extends MockChatService {
			override getSession(_sessionResource: URI) {
				return {} as IChatModel;
			}
			override cancelCurrentRequestForSession(_sessionResource: URI) {
				// no-op
			}
		};

		const mockDialogService = new class extends mock<IDialogService>() {
			override async confirm(_confirmation: IConfirmation): Promise<IConfirmationResult> {
				return { confirmed: true };
			}
		};

		instantiationService.set(IChatWidgetService, mockChatWidgetService);
		instantiationService.set(IChatService, mockChatService);
		instantiationService.set(IDialogService, mockDialogService);

		// Get the action handler
		const commandHandler = CommandsRegistry.getCommand('workbench.action.chat.sendToNewChat')?.handler;
		assert.ok(commandHandler, 'Command handler should be registered');

		// Run the action
		await commandHandler(instantiationService);

		// Verify the sequence of operations
		assert.ok(inputCleared, 'Input should be cleared before creating new session');
		assert.ok(sessionCleared, 'Session should be cleared');
		assert.ok(inputAccepted, 'Input should be accepted in the new session');
	});
});
