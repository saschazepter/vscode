/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { InMemoryStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { IModelSelectionCatalogContext, IModelSelectionMemory, IModelSelectionSessionContext, ModelSelectionReason, modelPickerStorageKey, normalizeModelPickerOptions, selectAvailableSessionModel, transitionModelSelection } from '../../browser/modelPickerSelection.js';

function model(identifier: string, metadataId = identifier, family = identifier): ILanguageModelChatMetadataAndIdentifier {
	return {
		identifier,
		metadata: {
			extension: new ExtensionIdentifier('test.extension'),
			id: metadataId,
			name: identifier,
			vendor: 'test',
			version: '1.0',
			family,
			maxInputTokens: 1,
			maxOutputTokens: 1,
			isDefaultForLocation: {},
		},
	};
}

const first = model('target:first', 'first', 'first');
const second = model('target:second', 'second', 'second');

interface ITransitionOverrides {
	readonly session?: Partial<Extract<IModelSelectionSessionContext, { kind: 'untitled' | 'existing' }>>;
	readonly catalog?: Partial<IModelSelectionCatalogContext>;
	readonly previous?: Partial<IModelSelectionMemory>;
}

function transition(overrides: ITransitionOverrides = {}) {
	return transitionModelSelection({
		session: {
			kind: 'untitled',
			key: 'provider/type',
			chatKey: 'chat:one',
			modelId: undefined,
			modelCatalogResolved: false,
			...overrides.session,
		},
		catalog: {
			models: [first, second],
			configuredModel: undefined,
			rememberedModelId: undefined,
			...overrides.catalog,
		},
		previous: {
			sessionKey: 'provider/type',
			lastPushedChatKey: 'chat:one',
			currentModel: undefined,
			...overrides.previous,
		},
	});
}

function summarize(result: ReturnType<typeof transitionModelSelection>) {
	return {
		current: result.currentModel?.identifier,
		effect: result.effect.kind,
		applied: result.effect.kind === 'apply' ? result.effect.model.identifier : undefined,
		reason: result.effect.kind === 'none' ? undefined : result.effect.reason,
		lastPushedChatKey: result.lastPushedChatKey,
	};
}

suite('ModelPickerSelection', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes omitted Auto support to true', () => {
		assert.deepStrictEqual(normalizeModelPickerOptions({
			useGroupedModelPicker: false,
			showFeatured: false,
			showUnavailableFeatured: true,
			showManageModelsAction: true,
		}), {
			useGroupedModelPicker: false,
			showFeatured: false,
			showUnavailableFeatured: true,
			showManageModelsAction: true,
			showAutoModel: true,
		});
	});

	test('restores a valid existing-session model without writing it', () => {
		assert.deepStrictEqual(summarize(transition({
			session: { kind: 'existing', modelId: second.identifier },
			previous: { currentModel: first },
		})), {
			current: second.identifier,
			effect: 'none',
			applied: undefined,
			reason: undefined,
			lastPushedChatKey: 'chat:one',
		});
	});

	test('waits for the vendor before repairing a missing existing-session model', () => {
		assert.deepStrictEqual(summarize(transition({
			session: { kind: 'existing', modelId: 'target:missing', modelCatalogResolved: false },
			previous: { currentModel: first },
		})), {
			current: undefined,
			effect: 'clear',
			applied: undefined,
			reason: ModelSelectionReason.SessionRestore,
			lastPushedChatKey: 'chat:one',
		});
	});

	test('repairs a confirmed removed model with the remembered fallback', () => {
		assert.deepStrictEqual(summarize(transition({
			session: { kind: 'existing', modelId: 'target:missing', modelCatalogResolved: true },
			catalog: { rememberedModelId: second.identifier },
		})), {
			current: second.identifier,
			effect: 'apply',
			applied: second.identifier,
			reason: ModelSelectionReason.RemovedModelFallback,
			lastPushedChatKey: 'chat:one',
		});
	});

	test('configured default wins at the start of each new chat', () => {
		assert.deepStrictEqual(summarize(transition({
			catalog: { configuredModel: second.metadata.id },
			previous: { currentModel: first, lastPushedChatKey: 'chat:previous' },
		})), {
			current: second.identifier,
			effect: 'apply',
			applied: second.identifier,
			reason: ModelSelectionReason.ConfiguredDefault,
			lastPushedChatKey: 'chat:one',
		});
	});

	test('adopts an externally selected draft model without writing it again', () => {
		assert.deepStrictEqual(summarize(transition({
			session: { modelId: second.identifier },
			previous: { currentModel: first },
		})), {
			current: second.identifier,
			effect: 'none',
			applied: undefined,
			reason: undefined,
			lastPushedChatKey: 'chat:one',
		});
	});

	test('uses remembered then first available fallback for an unseeded draft', () => {
		assert.deepStrictEqual([
			summarize(transition({ catalog: { rememberedModelId: second.identifier } })),
			summarize(transition()),
		], [{
			current: second.identifier,
			effect: 'apply',
			applied: second.identifier,
			reason: ModelSelectionReason.Remembered,
			lastPushedChatKey: 'chat:one',
		}, {
			current: first.identifier,
			effect: 'apply',
			applied: first.identifier,
			reason: ModelSelectionReason.FirstAvailable,
			lastPushedChatKey: 'chat:one',
		}]);
	});

	test('resets carried selection when provider or session type changes', () => {
		assert.deepStrictEqual(summarize(transition({
			previous: { sessionKey: 'other/type', currentModel: second },
		})), {
			current: first.identifier,
			effect: 'apply',
			applied: first.identifier,
			reason: ModelSelectionReason.FirstAvailable,
			lastPushedChatKey: 'chat:one',
		});
	});

	test('clears stale selection when the catalog becomes empty', () => {
		assert.deepStrictEqual(summarize(transition({
			catalog: { models: [] },
			previous: { currentModel: first },
		})), {
			current: undefined,
			effect: 'clear',
			applied: undefined,
			reason: ModelSelectionReason.NoModels,
			lastPushedChatKey: 'chat:one',
		});
	});

	test('does not write twice in the same chat', () => {
		assert.deepStrictEqual(summarize(transition({ previous: { currentModel: second } })), {
			current: second.identifier,
			effect: 'none',
			applied: undefined,
			reason: undefined,
			lastPushedChatKey: 'chat:one',
		});
	});

	test('re-pushes a carried selection when an untitled chat is reused', () => {
		assert.deepStrictEqual(summarize(transition({
			previous: { currentModel: second, lastPushedChatKey: 'chat:previous' },
		})), {
			current: second.identifier,
			effect: 'apply',
			applied: second.identifier,
			reason: ModelSelectionReason.NewChatRepush,
			lastPushedChatKey: 'chat:one',
		});
	});

	test('validates stateless selection before persisting and applying it', () => {
		const storage = disposables.add(new InMemoryStorageService());
		const writes: string[] = [];
		const session = { providerId: 'provider', sessionType: 'type', sessionId: 'session' };
		const provider = {
			getModelCatalog: () => ({ models: [first], resolved: true }),
			setModel: (_sessionId: string, modelIdentifier: string) => writes.push(modelIdentifier),
		};

		const selected = selectAvailableSessionModel(session, provider, storage, first.identifier);
		const rejected = selectAvailableSessionModel(session, provider, storage, second.identifier);

		assert.deepStrictEqual({
			selected: selected?.identifier,
			rejected,
			stored: storage.get(modelPickerStorageKey('provider', 'type'), StorageScope.PROFILE),
			writes,
		}, {
			selected: first.identifier,
			rejected: undefined,
			stored: first.identifier,
			writes: [first.identifier],
		});
	});
});
