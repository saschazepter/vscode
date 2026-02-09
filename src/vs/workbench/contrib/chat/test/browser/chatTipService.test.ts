/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandEvent, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IStorageService, InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { ChatTipService } from '../../browser/chatTipService.js';
import { IPromptsService, IResolvedAgentFile } from '../../common/promptSyntax/service/promptsService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { ChatModeKind } from '../../common/constants.js';

class MockContextKeyServiceWithRulesMatching extends MockContextKeyService {
	override contextMatchesRules(): boolean {
		return true;
	}
}

suite('ChatTipService', () => {
	const testDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	let instantiationService: TestInstantiationService;
	let contextKeyService: MockContextKeyServiceWithRulesMatching;
	let configurationService: TestConfigurationService;
	let commandExecutedEmitter: Emitter<ICommandEvent>;
	let storageService: InMemoryStorageService;
	let mockInstructionFiles: IResolvedAgentFile[];

	function createProductService(hasCopilot: boolean): IProductService {
		return {
			_serviceBrand: undefined,
			defaultChatAgent: hasCopilot ? { chatExtensionId: 'github.copilot-chat' } : undefined,
		} as IProductService;
	}

	function createService(hasCopilot: boolean = true, tipsEnabled: boolean = true): ChatTipService {
		instantiationService.stub(IProductService, createProductService(hasCopilot));
		configurationService.setUserConfiguration('chat.tips.enabled', tipsEnabled);
		return testDisposables.add(instantiationService.createInstance(ChatTipService));
	}

	setup(() => {
		instantiationService = testDisposables.add(new TestInstantiationService());
		contextKeyService = new MockContextKeyServiceWithRulesMatching();
		configurationService = new TestConfigurationService();
		commandExecutedEmitter = testDisposables.add(new Emitter<ICommandEvent>());
		storageService = testDisposables.add(new InMemoryStorageService());
		mockInstructionFiles = [];
		instantiationService.stub(IContextKeyService, contextKeyService);
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(ICommandService, {
			onDidExecuteCommand: commandExecutedEmitter.event,
			onWillExecuteCommand: testDisposables.add(new Emitter<ICommandEvent>()).event,
		} as Partial<ICommandService> as ICommandService);
		instantiationService.stub(IPromptsService, {
			listAgentInstructions: async () => mockInstructionFiles,
		} as Partial<IPromptsService> as IPromptsService);
	});

	test('returns a tip for new requests with timestamp after service creation', () => {
		const service = createService();
		const now = Date.now();

		// Request created after service initialization
		const tip = service.getNextTip('request-1', now + 1000, contextKeyService);
		assert.ok(tip, 'Should return a tip for requests created after service instantiation');
		assert.ok(tip.id.startsWith('tip.'), 'Tip should have a valid ID');
		assert.ok(tip.content.value.length > 0, 'Tip should have content');
	});

	test('returns undefined for old requests with timestamp before service creation', () => {
		const service = createService();
		const now = Date.now();

		// Request created before service initialization (simulating restored chat)
		const tip = service.getNextTip('old-request', now - 10000, contextKeyService);
		assert.strictEqual(tip, undefined, 'Should not return a tip for requests created before service instantiation');
	});

	test('only shows one tip per session', () => {
		const service = createService();
		const now = Date.now();

		// First request gets a tip
		const tip1 = service.getNextTip('request-1', now + 1000, contextKeyService);
		assert.ok(tip1, 'First request should get a tip');

		// Second request does not get a tip
		const tip2 = service.getNextTip('request-2', now + 2000, contextKeyService);
		assert.strictEqual(tip2, undefined, 'Second request should not get a tip');
	});

	test('returns same tip on rerender of same request', () => {
		const service = createService();
		const now = Date.now();

		// First call gets a tip
		const tip1 = service.getNextTip('request-1', now + 1000, contextKeyService);
		assert.ok(tip1);

		// Same request ID gets the same tip on rerender
		const tip2 = service.getNextTip('request-1', now + 1000, contextKeyService);
		assert.ok(tip2);
		assert.strictEqual(tip1.id, tip2.id, 'Should return same tip for stable rerender');
		assert.strictEqual(tip1.content.value, tip2.content.value);
	});

	test('returns undefined when Copilot is not enabled', () => {
		const service = createService(/* hasCopilot */ false);
		const now = Date.now();

		const tip = service.getNextTip('request-1', now + 1000, contextKeyService);
		assert.strictEqual(tip, undefined, 'Should not return a tip when Copilot is not enabled');
	});

	test('returns undefined when tips setting is disabled', () => {
		const service = createService(/* hasCopilot */ true, /* tipsEnabled */ false);
		const now = Date.now();

		const tip = service.getNextTip('request-1', now + 1000, contextKeyService);
		assert.strictEqual(tip, undefined, 'Should not return a tip when tips setting is disabled');
	});

	test('old requests do not consume the session tip allowance', () => {
		const service = createService();
		const now = Date.now();

		// Old request should not consume the tip allowance
		const oldTip = service.getNextTip('old-request', now - 10000, contextKeyService);
		assert.strictEqual(oldTip, undefined);

		// New request should still be able to get a tip
		const newTip = service.getNextTip('new-request', now + 1000, contextKeyService);
		assert.ok(newTip, 'New request should get a tip after old request was skipped');
	});

	test('multiple old requests do not affect new request tip', () => {
		const service = createService();
		const now = Date.now();

		// Simulate multiple restored requests being rendered
		service.getNextTip('old-1', now - 30000, contextKeyService);
		service.getNextTip('old-2', now - 20000, contextKeyService);
		service.getNextTip('old-3', now - 10000, contextKeyService);

		// New request should still get a tip
		const tip = service.getNextTip('new-request', now + 1000, contextKeyService);
		assert.ok(tip, 'New request should get a tip after multiple old requests');
	});

	test('excludes tip.undoChanges when restore checkpoint command has been executed', () => {
		createService();
		const now = Date.now();

		// Simulate the user restoring a checkpoint (persisted to workspace storage)
		commandExecutedEmitter.fire({ commandId: 'workbench.action.chat.restoreCheckpoint', args: [] });

		// New service instances should read from workspace storage and exclude the tip
		for (let i = 0; i < 50; i++) {
			const freshService = createService();
			const tip = freshService.getNextTip(`request-${i}`, now + 1000 + i, contextKeyService);
			if (tip) {
				assert.notStrictEqual(tip.id, 'tip.undoChanges', 'Should not show undoChanges tip after user has restored a checkpoint');
			}
		}
	});

	test('excludes tip.customInstructions when instruction files exist in workspace', async () => {
		// Mock that instruction files exist
		mockInstructionFiles = [{ uri: { path: '/.github/copilot-instructions.md' } } as IResolvedAgentFile];
		const now = Date.now();

		// Wait for the async file check to complete
		await new Promise(r => setTimeout(r, 0));

		// Run multiple attempts since tip selection is random
		for (let i = 0; i < 50; i++) {
			const freshService = createService();
			await new Promise(r => setTimeout(r, 0));
			const tip = freshService.getNextTip(`request-${i}`, now + 1000 + i, contextKeyService);
			if (tip) {
				assert.notStrictEqual(tip.id, 'tip.customInstructions', 'Should not show customInstructions tip when instruction files exist');
			}
		}
	});

	test('excludes tip.agentMode when agent mode has been used in workspace', () => {
		// Set the current mode to Agent so it gets recorded
		contextKeyService.createKey(ChatContextKeys.chatModeKind.key, ChatModeKind.Agent);
		contextKeyService.createKey(ChatContextKeys.chatModeName.key, 'Agent');

		const service = createService();
		const now = Date.now();

		// First call records the current mode in workspace storage
		service.getNextTip('request-0', now + 1000, contextKeyService);

		// New service instances should read from workspace storage and exclude the tip
		for (let i = 1; i < 50; i++) {
			const freshService = createService();
			const tip = freshService.getNextTip(`request-${i}`, now + 1000 + i, contextKeyService);
			if (tip) {
				assert.notStrictEqual(tip.id, 'tip.agentMode', 'Should not show agentMode tip after user has used agent mode');
			}
		}
	});

	test('excludes tip.planMode when Plan mode has been used in workspace', () => {
		// Set the current mode to Plan (a custom mode with kind=agent, name=Plan)
		contextKeyService.createKey(ChatContextKeys.chatModeKind.key, ChatModeKind.Agent);
		contextKeyService.createKey(ChatContextKeys.chatModeName.key, 'Plan');

		const service = createService();
		const now = Date.now();

		// First call records the current mode in workspace storage
		service.getNextTip('request-0', now + 1000, contextKeyService);

		// New service instances should read from workspace storage and exclude the tip
		for (let i = 1; i < 50; i++) {
			const freshService = createService();
			const tip = freshService.getNextTip(`request-${i}`, now + 1000 + i, contextKeyService);
			if (tip) {
				assert.notStrictEqual(tip.id, 'tip.planMode', 'Should not show planMode tip after user has used Plan mode');
			}
		}
	});
});
