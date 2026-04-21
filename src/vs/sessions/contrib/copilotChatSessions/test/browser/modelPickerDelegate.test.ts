/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ILanguageModelChatMetadata, ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { IActiveSession, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { getAvailableModels, modelPickerStorageKey, SessionModelPicker } from '../../browser/copilotChatSessionsActions.js';

function makeModel(id: string, sessionType: string): ILanguageModelChatMetadataAndIdentifier {
	return {
		identifier: id,
		metadata: { targetChatSessionType: sessionType } as ILanguageModelChatMetadata,
	};
}

function stubServices(
	disposables: DisposableStore,
	opts?: {
		models?: ILanguageModelChatMetadataAndIdentifier[];
		activeSession?: Partial<IActiveSession>;
		storedEntries?: Map<string, string>;
		setModelSpy?: (sessionId: string, modelId: string) => void;
	},
): { instantiationService: TestInstantiationService; storage: Map<string, string>; activeSession: ReturnType<typeof observableValue<IActiveSession | undefined>> } {
	const instantiationService = disposables.add(new TestInstantiationService());
	const models = opts?.models ?? [];
	const storage = opts?.storedEntries ?? new Map<string, string>();

	const activeSession = opts?.activeSession
		? observableValue<IActiveSession | undefined>('activeSession', opts.activeSession as IActiveSession)
		: observableValue<IActiveSession | undefined>('activeSession', undefined);

	const setModelSpy = opts?.setModelSpy ?? (() => { });

	instantiationService.stub(ILanguageModelsService, {
		onDidChangeLanguageModels: Event.None,
		getLanguageModelIds: () => models.map(m => m.identifier),
		lookupLanguageModel: (id: string) => models.find(m => m.identifier === id)?.metadata,
	} as Partial<ILanguageModelsService>);

	instantiationService.stub(IStorageService, {
		get: (key: string, _scope: StorageScope) => storage.get(key),
		store: (key: string, value: string, _scope: StorageScope, _target: StorageTarget) => { storage.set(key, value); },
	} as Partial<IStorageService>);

	const provider: Partial<ISessionsProvider> = {
		id: 'default-copilot',
		setModel: setModelSpy,
	};

	instantiationService.stub(ISessionsManagementService, {
		activeSession,
	} as unknown as ISessionsManagementService);

	instantiationService.stub(ISessionsProvidersService, {
		onDidChangeProviders: Event.None,
		getProviders: () => [provider as ISessionsProvider],
	} as Partial<ISessionsProvidersService>);

	// Stub IInstantiationService so SessionModelPicker can call createInstance for ModelPickerActionItem
	instantiationService.stub(IInstantiationService, instantiationService);

	return { instantiationService, storage, activeSession };
}

suite('modelPickerStorageKey', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('produces per-session-type keys', () => {
		assert.strictEqual(modelPickerStorageKey('copilot-cli'), 'sessions.modelPicker.copilot-cli.selectedModelId');
		assert.strictEqual(modelPickerStorageKey('claude-code'), 'sessions.modelPicker.claude-code.selectedModelId');
	});
});

suite('getAvailableModels', () => {
	const disposables = new DisposableStore();

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns empty when no active session', () => {
		const models = [makeModel('model-1', 'copilot-cli')];
		const { instantiationService } = stubServices(disposables, { models });
		const languageModelsService = instantiationService.get(ILanguageModelsService);
		const sessionsManagementService = instantiationService.get(ISessionsManagementService);
		const result = getAvailableModels(languageModelsService, sessionsManagementService);
		assert.deepStrictEqual(result, []);
	});

	test('filters models by session type', () => {
		const models = [
			makeModel('cli-model', 'copilot-cli'),
			makeModel('cloud-model', 'copilot-cloud'),
			makeModel('claude-model', 'claude-code'),
		];
		const { instantiationService } = stubServices(disposables, {
			models,
			activeSession: { providerId: 'default-copilot', sessionId: 'sess-1', sessionType: 'claude-code' },
		});
		const languageModelsService = instantiationService.get(ILanguageModelsService);
		const sessionsManagementService = instantiationService.get(ISessionsManagementService);
		const result = getAvailableModels(languageModelsService, sessionsManagementService);
		assert.deepStrictEqual(result, [models[2]]);
	});
});

suite('SessionModelPicker', () => {
	const disposables = new DisposableStore();

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	test('stores selected model under session-type-scoped key', () => {
		const models = [makeModel('model-1', 'claude-code')];
		const { instantiationService, storage } = stubServices(disposables, {
			models,
			activeSession: { providerId: 'default-copilot', sessionId: 'sess-1', sessionType: 'claude-code' },
		});
		// Creating the picker triggers initModel which calls setModel for the first available model
		disposables.add(instantiationService.createInstance(SessionModelPicker));
		assert.strictEqual(storage.get('sessions.modelPicker.claude-code.selectedModelId'), 'model-1');
		assert.strictEqual(storage.has('sessions.modelPicker.copilot-cli.selectedModelId'), false);
	});

	test('calls provider.setModel on init', () => {
		const calls: { sessionId: string; modelId: string }[] = [];
		const models = [makeModel('model-1', 'claude-code')];
		const { instantiationService } = stubServices(disposables, {
			models,
			activeSession: { providerId: 'default-copilot', sessionId: 'sess-1', sessionType: 'claude-code' },
			setModelSpy: (sessionId, modelId) => calls.push({ sessionId, modelId }),
		});
		disposables.add(instantiationService.createInstance(SessionModelPicker));
		assert.ok(calls.some(c => c.sessionId === 'sess-1' && c.modelId === 'model-1'));
	});

	test('remembers model per session type from storage', () => {
		const models = [makeModel('model-a', 'claude-code'), makeModel('model-b', 'claude-code')];
		const storedEntries = new Map([['sessions.modelPicker.claude-code.selectedModelId', 'model-b']]);
		const calls: { sessionId: string; modelId: string }[] = [];
		const { instantiationService } = stubServices(disposables, {
			models,
			activeSession: { providerId: 'default-copilot', sessionId: 'sess-1', sessionType: 'claude-code' },
			storedEntries,
			setModelSpy: (sessionId, modelId) => calls.push({ sessionId, modelId }),
		});
		disposables.add(instantiationService.createInstance(SessionModelPicker));
		// Should pick model-b (remembered) instead of model-a (first)
		assert.ok(calls.some(c => c.modelId === 'model-b'));
	});

	test('does not throw when no active session', () => {
		const { instantiationService } = stubServices(disposables);
		assert.doesNotThrow(() => disposables.add(instantiationService.createInstance(SessionModelPicker)));
	});

	test('different session types use independent storage keys', () => {
		const cliModels = [makeModel('cli-m', 'copilot-cli')];
		const claudeModels = [makeModel('claude-m', 'claude-code')];
		const allModels = [...cliModels, ...claudeModels];

		const { instantiationService, storage, activeSession } = stubServices(disposables, {
			models: allModels,
			activeSession: { providerId: 'default-copilot', sessionId: 's1', sessionType: 'copilot-cli' },
		});
		disposables.add(instantiationService.createInstance(SessionModelPicker));
		assert.strictEqual(storage.get('sessions.modelPicker.copilot-cli.selectedModelId'), 'cli-m');

		// Switch session type
		activeSession.set({ providerId: 'default-copilot', sessionId: 's2', sessionType: 'claude-code' } as IActiveSession, undefined);

		assert.strictEqual(storage.get('sessions.modelPicker.claude-code.selectedModelId'), 'claude-m');
		// CLI key should still be intact
		assert.strictEqual(storage.get('sessions.modelPicker.copilot-cli.selectedModelId'), 'cli-m');
	});
});
