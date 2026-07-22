/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../../../base/common/event.js';
import { toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { ExtensionIdentifier } from '../../../../../../../platform/extensions/common/extensions.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../common/constants.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../../../common/languageModels.js';
import { ModelSelectionReason, resolveModelIdentifier, resolveModelIdentifierFromCatalog } from '../../../../common/modelSelection.js';
import { ChatInputModelSelectionController, IChatInputModelSelectionRuntime } from '../../../../browser/widget/input/chatInputModelSelectionController.js';
import { ChatModelSelectionModel } from '../../../../browser/widget/input/chatModelSelectionModel.js';

function model(identifier: string): ILanguageModelChatMetadataAndIdentifier {
	return {
		identifier,
		metadata: {
			extension: new ExtensionIdentifier('test.extension'),
			id: identifier,
			name: identifier,
			vendor: 'test',
			version: '1.0',
			family: identifier,
			maxInputTokens: 1,
			maxOutputTokens: 1,
			isDefaultForLocation: {},
		},
	};
}

function targetedModel(identifier: string, sessionType: string): ILanguageModelChatMetadataAndIdentifier {
	const result = model(identifier);
	return { ...result, metadata: { ...result.metadata, targetChatSessionType: sessionType } };
}

interface IRuntimeState {
	models: ILanguageModelChatMetadataAndIdentifier[];
	resolved: boolean;
	readonly sessionType: string;
	configuredModel?: string;
}

function createRuntime(
	selection: ChatModelSelectionModel,
	state: IRuntimeState,
	modelChanges: Emitter<string>,
	applied: string[],
): IChatInputModelSelectionRuntime {
	return {
		location: ChatAgentLocation.Chat,
		getCurrentModeKind: () => ChatModeKind.Ask,
		getCurrentSessionType: () => state.sessionType,
		isEmpty: () => true,
		getModels: () => state.models,
		getAllModels: () => state.models,
		requiresCustomModels: () => false,
		getConfiguredModelValue: () => state.configuredModel,
		resolveModelIdentifier: identifier => resolveModelIdentifier(state.models, identifier, state.resolved),
		subscribeToModelChanges: listener => modelChanges.event(listener),
		getBoundConversationKey: () => 'chat:one',
		getVisibleConversationKey: () => 'chat:one',
		restoreModelConfiguration: () => { },
		applyModel: model => {
			applied.push(model.identifier);
			selection.setCurrentModel(model, false);
		},
	};
}

suite('ChatModelSelectionModel', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('tracks explicit selection origin', () => {
		const selection = new ChatModelSelectionModel();
		const first = model('test/first');
		const second = model('test/second');

		selection.setCurrentModel(first, false);
		const automatic = {
			current: selection.currentModel.get()?.identifier,
			explicit: selection.userExplicitlySelectedModel,
		};
		selection.setCurrentModel(second, true);

		assert.deepStrictEqual({
			automatic,
			current: selection.currentModel.get()?.identifier,
			explicitAfterUserSelection: selection.userExplicitlySelectedModel,
		}, {
			automatic: { current: first.identifier, explicit: false },
			current: second.identifier,
			explicitAfterUserSelection: true,
		});
	});

	test('rolls back a failed automatic transition effect', () => {
		const selection = new ChatModelSelectionModel();
		const first = model('test/first');
		const second = model('test/second');
		selection.setCurrentModel(first, false);
		selection.setSelectionReason(ModelSelectionReason.FirstAvailable);
		const previousState = selection.captureState();
		selection.setCurrentModel(second, false);
		selection.setSelectionReason(ModelSelectionReason.ConfiguredDefault);

		assert.throws(() => selection.applyTransitionEffect(previousState, () => { throw new Error('rejected'); }), /rejected/);
		assert.deepStrictEqual({
			current: selection.currentModel.get()?.identifier,
			reason: selection.getCurrentReason(undefined),
		}, {
			current: first.identifier,
			reason: ModelSelectionReason.FirstAvailable,
		});
	});

	test('restores only for fresh own-pool session switches', () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const controller = disposables.add(new ChatInputModelSelectionController(selection, createRuntime(selection, {
			models: [],
			resolved: true,
			sessionType: 'test',
		}, modelChanges, [])));

		controller.beginSessionSwitch(true, true, false);
		const restoreDuringFreshSwitch = controller.restorePerTypeModel;
		controller.endSessionSwitch();
		const restoreAfterSwitch = controller.restorePerTypeModel;
		controller.beginSessionSwitch(true, true, true);

		assert.deepStrictEqual({
			restoreDuringFreshSwitch,
			restoreAfterSwitch,
			carriedModelRestore: controller.restorePerTypeModel,
		}, {
			restoreDuringFreshSwitch: true,
			restoreAfterSwitch: false,
			carriedModelRestore: false,
		});
	});

	test('applies a fallback while waiting for a remembered model, then restores it', () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const first = model('test/first');
		const second = model('test/second');
		let models = [first];
		let catalogResolved = false;
		const applied: string[] = [];
		const initialSelections: string[] = [];

		const runtime: IChatInputModelSelectionRuntime = {
			location: ChatAgentLocation.Chat,
			getCurrentModeKind: () => ChatModeKind.Ask,
			getCurrentSessionType: () => undefined,
			isEmpty: () => true,
			getModels: () => models,
			getAllModels: () => models,
			requiresCustomModels: () => false,
			getConfiguredModelValue: () => undefined,
			resolveModelIdentifier: identifier => resolveModelIdentifier(models, identifier, catalogResolved),
			subscribeToModelChanges: listener => modelChanges.event(listener),
			getBoundConversationKey: () => 'chat:one',
			getVisibleConversationKey: () => 'chat:one',
			restoreModelConfiguration: () => { },
			applyModel: selected => {
				applied.push(selected.identifier);
				selection.setCurrentModel(selected, false);
			},
		};
		const controller = disposables.add(new ChatInputModelSelectionController(selection, runtime));
		controller.initialize(second.identifier, result => initialSelections.push(result.kind));
		const pending = controller.hasPendingIntent();
		models = [first, second];
		catalogResolved = true;
		modelChanges.fire('test');

		assert.deepStrictEqual({
			initialSelections,
			pending,
			pendingAfterResolve: controller.hasPendingIntent(),
			applied,
		}, {
			initialSelections: ['pending'],
			pending: true,
			pendingAfterResolve: false,
			applied: [first.identifier, second.identifier],
		});
	});

	test('explicit selection cancels an eventual remembered-model restore', () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const fallback = model('test/fallback');
		const explicit = model('test/explicit');
		const remembered = model('test/remembered');
		const state: IRuntimeState = { models: [fallback, explicit], resolved: true, sessionType: 'local' };
		const applied: string[] = [];
		const controller = disposables.add(new ChatInputModelSelectionController(selection, createRuntime(selection, state, modelChanges, applied)));

		controller.initialize(remembered.identifier, () => { });
		controller.applyExplicitSelection(explicit, 'local', 'chat:one', () => applied.push(explicit.identifier), false);
		state.models = [fallback, explicit, remembered];
		modelChanges.fire('loaded');

		assert.deepStrictEqual({
			pending: controller.hasPendingIntent(),
			applied,
			current: selection.currentModel.get()?.identifier,
		}, {
			pending: false,
			applied: [fallback.identifier, explicit.identifier],
			current: explicit.identifier,
		});
	});

	test('programmatic selection cancels an eventual remembered-model restore', () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const fallback = model('test/fallback');
		const programmatic = model('test/programmatic');
		const remembered = model('test/remembered');
		const state: IRuntimeState = { models: [fallback, programmatic], resolved: true, sessionType: 'local' };
		const applied: string[] = [];
		const controller = disposables.add(new ChatInputModelSelectionController(selection, createRuntime(selection, state, modelChanges, applied)));

		controller.initialize(remembered.identifier, () => { });
		controller.applyProgrammaticSelection(programmatic, 'local', 'chat:one', () => applied.push(programmatic.identifier));
		state.models = [fallback, programmatic, remembered];
		modelChanges.fire('loaded');

		assert.deepStrictEqual({
			pending: controller.hasPendingIntent(),
			applied,
			current: selection.currentModel.get()?.identifier,
			reason: selection.selectionReason,
		}, {
			pending: false,
			applied: [fallback.identifier, programmatic.identifier],
			current: programmatic.identifier,
			reason: ModelSelectionReason.ProgrammaticSelection,
		});
	});

	test('pending programmatic selection applies when the model arrives', async () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const requested = model('test/requested');
		const state: IRuntimeState = { models: [], resolved: false, sessionType: 'local' };
		const applied: string[] = [];
		const controller = disposables.add(new ChatInputModelSelectionController(selection, createRuntime(selection, state, modelChanges, applied)));

		const result = controller.requestProgrammaticSelection(
			() => state.models.find(model => model.identifier === requested.identifier),
			'local',
			'chat:one',
			model => {
				applied.push(model.identifier);
				selection.setCurrentModel(model, false);
			},
		);
		const pending = controller.hasPendingProgrammaticSelection();
		state.models = [requested];
		modelChanges.fire('loaded');

		assert.deepStrictEqual({
			pending,
			result: await result,
			pendingAfterLoad: controller.hasPendingProgrammaticSelection(),
			applied,
			current: selection.currentModel.get()?.identifier,
		}, {
			pending: true,
			result: true,
			pendingAfterLoad: false,
			applied: [requested.identifier],
			current: requested.identifier,
		});
	});

	test('explicit selection cancels a pending programmatic selection', async () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const requested = model('test/requested');
		const explicit = model('test/explicit');
		const state: IRuntimeState = { models: [explicit], resolved: false, sessionType: 'local' };
		const applied: string[] = [];
		const controller = disposables.add(new ChatInputModelSelectionController(selection, createRuntime(selection, state, modelChanges, applied)));

		const result = controller.requestProgrammaticSelection(
			() => state.models.find(model => model.identifier === requested.identifier),
			'local',
			'chat:one',
			model => applied.push(model.identifier),
		);
		controller.applyExplicitSelection(explicit, 'local', 'chat:one', () => applied.push(explicit.identifier), false);
		state.models = [explicit, requested];
		modelChanges.fire('loaded');

		assert.deepStrictEqual({
			result: await result,
			pending: controller.hasPendingProgrammaticSelection(),
			applied,
			current: selection.currentModel.get()?.identifier,
		}, {
			result: false,
			pending: false,
			applied: [explicit.identifier],
			current: explicit.identifier,
		});
	});

	test('clearing a pending programmatic selection clears its authority', async () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const requested = model('test/requested');
		const state: IRuntimeState = { models: [], resolved: false, sessionType: 'local' };
		const controller = disposables.add(new ChatInputModelSelectionController(selection, createRuntime(selection, state, modelChanges, [])));

		const result = controller.requestProgrammaticSelection(
			() => state.models.find(model => model.identifier === requested.identifier),
			'local',
			'chat:one',
			() => { },
		);
		controller.clearIntent();

		assert.deepStrictEqual({ result: await result, reason: selection.selectionReason }, {
			result: false,
			reason: undefined,
		});
	});

	test('location default improves the fallback while remembered intent remains pending', () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const fallback = model('test/fallback');
		const remembered = model('test/remembered');
		const defaultBase = model('test/default');
		const locationDefault = {
			...defaultBase,
			metadata: { ...defaultBase.metadata, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } },
		};
		const state: IRuntimeState = { models: [fallback], resolved: true, sessionType: 'local' };
		const applied: string[] = [];
		const controller = disposables.add(new ChatInputModelSelectionController(selection, createRuntime(selection, state, modelChanges, applied)));

		controller.initialize(remembered.identifier, () => { });
		state.models = [fallback, locationDefault];
		controller.reconcileModelListChange(state.models);
		const pendingAfterDefault = controller.hasPendingIntent();
		state.models = [fallback, locationDefault, remembered];
		modelChanges.fire('loaded');

		assert.deepStrictEqual({
			pendingAfterDefault,
			pendingAfterLoad: controller.hasPendingIntent(),
			applied,
			current: selection.currentModel.get()?.identifier,
		}, {
			pendingAfterDefault: true,
			pendingAfterLoad: false,
			applied: [fallback.identifier, locationDefault.identifier, remembered.identifier],
			current: remembered.identifier,
		});
	});

	test('repairs a removed fallback while remembered intent remains pending', () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const fallback = model('test/fallback');
		const replacement = model('test/replacement');
		const remembered = model('test/remembered');
		const state: IRuntimeState = { models: [fallback], resolved: true, sessionType: 'local' };
		const applied: string[] = [];
		const controller = disposables.add(new ChatInputModelSelectionController(selection, createRuntime(selection, state, modelChanges, applied)));

		controller.initialize(remembered.identifier, () => { });
		state.models = [replacement];
		modelChanges.fire('fallback-removed');
		const pendingAfterRepair = controller.hasPendingIntent();
		state.models = [replacement, remembered];
		modelChanges.fire('remembered-loaded');

		assert.deepStrictEqual({
			pendingAfterRepair,
			pendingAfterLoad: controller.hasPendingIntent(),
			applied,
			current: selection.currentModel.get()?.identifier,
		}, {
			pendingAfterRepair: true,
			pendingAfterLoad: false,
			applied: [fallback.identifier, replacement.identifier, remembered.identifier],
			current: remembered.identifier,
		});
	});

	test('applies a fallback while the configured default loads, then upgrades it', () => {
		const selection = new ChatModelSelectionModel();
		const byok = model('openai/byok');
		const configured = model('copilot/configured');
		let models = [byok];
		const applied: string[] = [];
		const runtime: IChatInputModelSelectionRuntime = {
			location: ChatAgentLocation.Chat,
			getCurrentModeKind: () => ChatModeKind.Ask,
			getCurrentSessionType: () => undefined,
			isEmpty: () => true,
			getModels: () => models,
			getAllModels: () => models,
			requiresCustomModels: () => false,
			getConfiguredModelValue: () => configured.metadata.id,
			resolveModelIdentifier: identifier => resolveModelIdentifier(models, identifier, true),
			subscribeToModelChanges: () => toDisposable(() => { }),
			getBoundConversationKey: () => 'chat:one',
			getVisibleConversationKey: () => 'chat:one',
			restoreModelConfiguration: () => { },
			applyModel: selected => {
				applied.push(selected.identifier);
				selection.setCurrentModel(selected, false);
			},
		};
		const controller = disposables.add(new ChatInputModelSelectionController(selection, runtime));

		controller.initialize(undefined, () => { });
		const pending = controller.hasPendingIntent();
		models = [byok, configured];
		controller.reconcileModelListChange(models);

		assert.deepStrictEqual({ pending, applied, current: selection.currentModel.get()?.identifier }, {
			pending: false,
			applied: [byok.identifier, configured.identifier],
			current: configured.identifier,
		});
	});

	test('configured default supersedes pending remembered intent', () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const fallback = model('test/fallback');
		const configured = model('test/configured');
		const remembered = model('test/remembered');
		const state: IRuntimeState = {
			models: [fallback],
			resolved: false,
			sessionType: 'local',
			configuredModel: configured.metadata.id,
		};
		const applied: string[] = [];
		const controller = disposables.add(new ChatInputModelSelectionController(selection, createRuntime(selection, state, modelChanges, applied)));

		controller.initialize(remembered.identifier, () => { });
		state.models = [fallback, configured, remembered];
		state.resolved = true;
		modelChanges.fire('loaded');

		assert.deepStrictEqual({
			pending: controller.hasPendingIntent(),
			applied,
			current: selection.currentModel.get()?.identifier,
			reason: selection.selectionReason,
		}, {
			pending: false,
			applied: [fallback.identifier, configured.identifier],
			current: configured.identifier,
			reason: ModelSelectionReason.ConfiguredDefault,
		});
	});

	test('configured default claims an already selected fallback', () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const fallback = model('test/fallback');
		const defaultBase = model('test/default');
		const locationDefault = {
			...defaultBase,
			metadata: { ...defaultBase.metadata, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } },
		};
		const state: IRuntimeState = { models: [fallback], resolved: true, sessionType: 'local' };
		const applied: string[] = [];
		const controller = disposables.add(new ChatInputModelSelectionController(selection, createRuntime(selection, state, modelChanges, applied)));

		controller.initialize(undefined, () => { });
		state.configuredModel = fallback.metadata.id;
		state.models = [fallback, locationDefault];
		modelChanges.fire('configured');
		modelChanges.fire('unchanged');

		assert.deepStrictEqual({
			applied,
			current: selection.currentModel.get()?.identifier,
			reason: selection.selectionReason,
		}, {
			applied: [fallback.identifier],
			current: fallback.identifier,
			reason: ModelSelectionReason.ConfiguredDefault,
		});
	});

	test('keeps an explicit selection when the configured default loads later', () => {
		const selection = new ChatModelSelectionModel();
		const byok = model('openai/byok');
		const explicit = model('openai/explicit');
		const configured = model('copilot/configured');
		let models = [byok, explicit];
		const applied: string[] = [];
		const runtime: IChatInputModelSelectionRuntime = {
			location: ChatAgentLocation.Chat,
			getCurrentModeKind: () => ChatModeKind.Ask,
			getCurrentSessionType: () => undefined,
			isEmpty: () => true,
			getModels: () => models,
			getAllModels: () => models,
			requiresCustomModels: () => false,
			getConfiguredModelValue: () => configured.metadata.id,
			resolveModelIdentifier: identifier => resolveModelIdentifier(models, identifier, true),
			subscribeToModelChanges: () => toDisposable(() => { }),
			getBoundConversationKey: () => 'chat:one',
			getVisibleConversationKey: () => 'chat:one',
			restoreModelConfiguration: () => { },
			applyModel: selected => {
				applied.push(selected.identifier);
				selection.setCurrentModel(selected, false);
			},
		};
		const controller = disposables.add(new ChatInputModelSelectionController(selection, runtime));

		controller.initialize(undefined, () => { });
		controller.applyExplicitSelection(explicit, undefined, 'chat:one', () => applied.push(explicit.identifier), false);
		models = [byok, explicit, configured];
		controller.reconcileModelListChange(models);

		assert.deepStrictEqual({ applied, current: selection.currentModel.get()?.identifier }, {
			applied: [byok.identifier, explicit.identifier],
			current: explicit.identifier,
		});
	});

	test('conversation restore cancels startup remembered intent', () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const fallback = model('test/fallback');
		const remembered = model('copilot/remembered');
		const restored = model('test/restored');
		let models = [fallback, restored];
		let catalogResolved = false;
		const applied: string[] = [];
		const runtime: IChatInputModelSelectionRuntime = {
			location: ChatAgentLocation.Chat,
			getCurrentModeKind: () => ChatModeKind.Ask,
			getCurrentSessionType: () => undefined,
			isEmpty: () => false,
			getModels: () => models,
			getAllModels: () => models,
			requiresCustomModels: () => false,
			getConfiguredModelValue: () => undefined,
			resolveModelIdentifier: identifier => resolveModelIdentifier(models, identifier, catalogResolved),
			subscribeToModelChanges: listener => modelChanges.event(listener),
			getBoundConversationKey: () => 'chat:one',
			getVisibleConversationKey: () => 'chat:one',
			restoreModelConfiguration: () => { },
			applyModel: selected => {
				applied.push(selected.identifier);
				selection.setCurrentModel(selected, false);
			},
		};
		const controller = disposables.add(new ChatInputModelSelectionController(selection, runtime));

		controller.initialize(remembered.identifier, () => { });
		controller.syncFromConversationState(restored, undefined, undefined, 'chat:one');
		models = [fallback, restored, remembered];
		catalogResolved = true;
		modelChanges.fire('test');

		assert.deepStrictEqual({
			pending: controller.hasPendingIntent(),
			applied,
			current: selection.currentModel.get()?.identifier,
		}, {
			pending: false,
			applied: [fallback.identifier, restored.identifier],
			current: restored.identifier,
		});
	});

	test('late configured default does not overwrite a restored conversation model', () => {
		const selection = new ChatModelSelectionModel();
		const restored = model('test/restored');
		const configured = model('copilot/configured');
		let models = [restored];
		const applied: string[] = [];
		const runtime: IChatInputModelSelectionRuntime = {
			location: ChatAgentLocation.Chat,
			getCurrentModeKind: () => ChatModeKind.Ask,
			getCurrentSessionType: () => undefined,
			isEmpty: () => true,
			getModels: () => models,
			getAllModels: () => models,
			requiresCustomModels: () => false,
			getConfiguredModelValue: () => configured.metadata.id,
			resolveModelIdentifier: identifier => resolveModelIdentifier(models, identifier, true),
			subscribeToModelChanges: () => toDisposable(() => { }),
			getBoundConversationKey: () => 'chat:one',
			getVisibleConversationKey: () => 'chat:one',
			restoreModelConfiguration: () => { },
			applyModel: selected => {
				applied.push(selected.identifier);
				selection.setCurrentModel(selected, false);
			},
		};
		const controller = disposables.add(new ChatInputModelSelectionController(selection, runtime));

		controller.initialize(undefined, () => { });
		controller.syncFromConversationState(restored, undefined, undefined, 'chat:one');
		models = [restored, configured];
		controller.reconcileModelListChange(models);

		assert.deepStrictEqual({ applied, current: selection.currentModel.get()?.identifier }, {
			applied: [restored.identifier],
			current: restored.identifier,
		});
	});

	test('conversation restore cancels older history intent', () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const restored = model('test/restored');
		const history = model('test/history');
		let models = [restored];
		const applied: string[] = [];
		const runtime: IChatInputModelSelectionRuntime = {
			location: ChatAgentLocation.Chat,
			getCurrentModeKind: () => ChatModeKind.Ask,
			getCurrentSessionType: () => undefined,
			isEmpty: () => false,
			getModels: () => models,
			getAllModels: () => models,
			requiresCustomModels: () => false,
			getConfiguredModelValue: () => undefined,
			resolveModelIdentifier: identifier => resolveModelIdentifier(models, identifier, true),
			subscribeToModelChanges: listener => modelChanges.event(listener),
			getBoundConversationKey: () => 'chat:one',
			getVisibleConversationKey: () => 'chat:one',
			restoreModelConfiguration: () => { },
			applyModel: selected => {
				applied.push(selected.identifier);
				selection.setCurrentModel(selected, false);
			},
		};
		const controller = disposables.add(new ChatInputModelSelectionController(selection, runtime));

		controller.preselectFromHistory(history.identifier, 'chat:one');
		controller.syncFromConversationState(restored, undefined, undefined, 'chat:one');
		models = [restored, history];
		modelChanges.fire('test');

		assert.deepStrictEqual({ applied, current: selection.currentModel.get()?.identifier }, {
			applied: [restored.identifier],
			current: restored.identifier,
		});
	});

	test('fresh conversation precedence is configured, remembered, default, then first available', () => {
		const first = model('test/first');
		const remembered = model('test/remembered');
		const locationDefault = {
			...model('test/default'),
			metadata: {
				...model('test/default').metadata,
				isDefaultForLocation: { [ChatAgentLocation.Chat]: true },
			},
		};

		const run = (configuredModel: string | undefined, rememberedModel: string | undefined, models: ILanguageModelChatMetadataAndIdentifier[]) => {
			const selection = new ChatModelSelectionModel();
			const applied: string[] = [];
			const runtime: IChatInputModelSelectionRuntime = {
				location: ChatAgentLocation.Chat,
				getCurrentModeKind: () => ChatModeKind.Ask,
				getCurrentSessionType: () => undefined,
				isEmpty: () => true,
				getModels: () => models,
				getAllModels: () => models,
				requiresCustomModels: () => false,
				getConfiguredModelValue: () => configuredModel,
				resolveModelIdentifier: identifier => resolveModelIdentifier(models, identifier, true),
				subscribeToModelChanges: () => toDisposable(() => { }),
				getBoundConversationKey: () => 'chat:one',
				getVisibleConversationKey: () => 'chat:one',
				restoreModelConfiguration: () => { },
				applyModel: selected => {
					applied.push(selected.identifier);
					selection.setCurrentModel(selected, false);
				},
			};
			disposables.add(new ChatInputModelSelectionController(selection, runtime)).initialize(rememberedModel, () => { });
			return applied[0];
		};

		assert.deepStrictEqual([
			run(locationDefault.metadata.id, remembered.identifier, [first, remembered, locationDefault]),
			run(undefined, remembered.identifier, [first, remembered, locationDefault]),
			run(undefined, undefined, [first, locationDefault]),
			run(undefined, undefined, [first]),
		], [locationDefault.identifier, remembered.identifier, locationDefault.identifier, first.identifier]);
	});

	test('applies fallback and configured defaults through the automatic path', () => {
		const selection = new ChatModelSelectionModel();
		const first = model('test/first');
		const second = model('test/second');
		const configuration: { model: string | undefined } = { model: undefined };
		const applied: string[] = [];
		const runtime: IChatInputModelSelectionRuntime = {
			location: ChatAgentLocation.Chat,
			getCurrentModeKind: () => ChatModeKind.Ask,
			getCurrentSessionType: () => undefined,
			isEmpty: () => true,
			getModels: () => [first, second],
			getAllModels: () => [first, second],
			requiresCustomModels: () => false,
			getConfiguredModelValue: () => configuration.model,
			resolveModelIdentifier: identifier => resolveModelIdentifier([first, second], identifier, true),
			subscribeToModelChanges: () => toDisposable(() => { }),
			getBoundConversationKey: () => 'chat:one',
			getVisibleConversationKey: () => 'chat:one',
			restoreModelConfiguration: () => { },
			applyModel: selected => {
				applied.push(selected.identifier);
				selection.setCurrentModel(selected, false);
			},
		};
		const controller = disposables.add(new ChatInputModelSelectionController(selection, runtime));

		controller.ensureCurrentModelSupported();
		configuration.model = second.metadata.id;
		const configuredApplied = controller.applyConfiguredDefault();

		assert.deepStrictEqual({ configuredApplied, applied }, {
			configuredApplied: true,
			applied: [first.identifier, second.identifier],
		});
	});

	test('replaces a BYOK first-available model when the Copilot default loads later', () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const byok = model('openai/byok');
		const copilotDefault = {
			...model('copilot/auto'),
			metadata: {
				...model('copilot/auto').metadata,
				isDefaultForLocation: { [ChatAgentLocation.Chat]: true },
			},
		};
		let models = [byok];
		const applied: string[] = [];
		const runtime: IChatInputModelSelectionRuntime = {
			location: ChatAgentLocation.Chat,
			getCurrentModeKind: () => ChatModeKind.Ask,
			getCurrentSessionType: () => undefined,
			isEmpty: () => true,
			getModels: () => models,
			getAllModels: () => models,
			requiresCustomModels: () => false,
			getConfiguredModelValue: () => undefined,
			resolveModelIdentifier: identifier => resolveModelIdentifier(models, identifier, true),
			subscribeToModelChanges: listener => modelChanges.event(listener),
			getBoundConversationKey: () => 'chat:one',
			getVisibleConversationKey: () => 'chat:one',
			restoreModelConfiguration: () => { },
			applyModel: selected => {
				applied.push(selected.identifier);
				selection.setCurrentModel(selected, false);
			},
		};
		const controller = disposables.add(new ChatInputModelSelectionController(selection, runtime));

		controller.initialize(undefined, () => { });
		models = [byok, copilotDefault];
		controller.reconcileModelListChange(models);

		assert.deepStrictEqual({ applied, current: selection.currentModel.get()?.identifier }, {
			applied: [byok.identifier, copilotDefault.identifier],
			current: copilotDefault.identifier,
		});
	});

	test('drops cross-pool drafts and waits for a cold conversation model', () => {
		const selection = new ChatModelSelectionModel();
		const sessionType = 'agent-host-test';
		const general = model('test/general');
		const fallback = targetedModel('test/fallback', sessionType);
		const desired = targetedModel('test/desired', sessionType);
		const modelChanges = disposables.add(new Emitter<string>());
		let models = [fallback];
		let resolved = false;
		const applied: string[] = [];
		const restored: { modelId: string; configuration: Record<string, unknown> | undefined }[] = [];
		const runtime: IChatInputModelSelectionRuntime = {
			location: ChatAgentLocation.Chat,
			getCurrentModeKind: () => ChatModeKind.Ask,
			getCurrentSessionType: () => sessionType,
			isEmpty: () => false,
			getModels: () => models,
			getAllModels: () => models,
			requiresCustomModels: () => true,
			getConfiguredModelValue: () => undefined,
			resolveModelIdentifier: identifier => resolveModelIdentifier(models, identifier, resolved),
			subscribeToModelChanges: listener => modelChanges.event(listener),
			getBoundConversationKey: () => 'chat:one',
			getVisibleConversationKey: () => 'chat:one',
			restoreModelConfiguration: (modelId, configuration) => restored.push({ modelId, configuration }),
			applyModel: selected => {
				applied.push(selected.identifier);
				selection.setCurrentModel(selected, false);
			},
		};
		const controller = disposables.add(new ChatInputModelSelectionController(selection, runtime));

		const draft = controller.resolveDraftModel(general, sessionType, true);
		models = [];
		controller.syncFromConversationState(desired, { effort: 'high' }, sessionType, 'chat:one');
		const pending = controller.hasPendingIntent();
		models = [fallback, desired];
		resolved = true;
		modelChanges.fire('test');

		assert.deepStrictEqual({
			draft: { model: draft.model?.identifier, changed: draft.changed },
			pending,
			pendingAfterResolve: controller.hasPendingIntent(),
			applied,
			restored,
		}, {
			draft: { model: undefined, changed: true },
			pending: true,
			pendingAfterResolve: false,
			applied: [desired.identifier],
			restored: [{ modelId: desired.identifier, configuration: { effort: 'high' } }],
		});
	});

	test('syncFromConversationState waits through a resolved-but-empty agent-host pool and restores the model', () => {
		// Cold-restart race: the agent-host vendor is registered ("resolved") but its models arrive
		// later. Routed through the real catalog resolver, the agent-host grace keeps the absent
		// model `pending` (not `unavailable`), so the restore waits through the intermediate empty
		// re-resolutions and applies the model once the pool loads — instead of defaulting to Auto.
		// (If the grace in resolveModelIdentifierFromCatalog is removed, resolution is `unavailable`,
		// no wait is armed, and this test fails.)
		const selection = new ChatModelSelectionModel();
		const sessionType = 'agent-host-copilotcli';
		const base = targetedModel('agent-host-copilotcli:gpt-5.6-sol', sessionType);
		const desired = { ...base, metadata: { ...base.metadata, vendor: sessionType } };
		const modelChanges = disposables.add(new Emitter<string>());
		let models: ILanguageModelChatMetadataAndIdentifier[] = [];
		const applied: string[] = [];
		const restored: { modelId: string; configuration: Record<string, unknown> | undefined }[] = [];
		const runtime: IChatInputModelSelectionRuntime = {
			location: ChatAgentLocation.Chat,
			getCurrentModeKind: () => ChatModeKind.Ask,
			getCurrentSessionType: () => sessionType,
			isEmpty: () => false,
			getModels: () => models,
			getAllModels: () => models,
			requiresCustomModels: () => true,
			getConfiguredModelValue: () => undefined,
			// Faithful to production: vendor is resolved but publishes models asynchronously.
			resolveModelIdentifier: identifier => resolveModelIdentifierFromCatalog(models, identifier, {
				hasLiveModels: vendor => models.some(m => m.metadata.vendor === vendor),
				hasResolved: () => true,
			}),
			subscribeToModelChanges: listener => modelChanges.event(listener),
			getBoundConversationKey: () => 'chat:one',
			getVisibleConversationKey: () => 'chat:one',
			restoreModelConfiguration: (modelId, configuration) => restored.push({ modelId, configuration }),
			applyModel: selected => {
				applied.push(selected.identifier);
				selection.setCurrentModel(selected, false);
			},
		};
		const controller = disposables.add(new ChatInputModelSelectionController(selection, runtime));

		controller.syncFromConversationState(desired, { effort: 'high' }, sessionType, 'chat:one');
		const pending = controller.hasPendingIntent();
		// An intermediate empty re-resolution must not end the wait or apply a default.
		modelChanges.fire('still-empty');
		const stillPendingAfterEmpty = controller.hasPendingIntent();
		const appliedAfterEmpty = [...applied];
		// The real models finally arrive.
		models = [desired];
		modelChanges.fire('loaded');

		assert.deepStrictEqual({
			pending,
			stillPendingAfterEmpty,
			appliedAfterEmpty,
			pendingAfterLoad: controller.hasPendingIntent(),
			applied,
			restored,
		}, {
			pending: true,
			stillPendingAfterEmpty: true,
			appliedAfterEmpty: [],
			pendingAfterLoad: false,
			applied: [desired.identifier],
			restored: [{ modelId: desired.identifier, configuration: { effort: 'high' } }],
		});
	});

	test('initialize preserves remembered intent across a conclusively empty catalog', () => {
		// Profile preference restoration is eventual intent: an empty catalog does not prove that the
		// model will never arrive. Keep waiting while showing any available fallback, and let an
		// explicit user selection cancel the wait.
		const selection = new ChatModelSelectionModel();
		const sessionType = 'test-session';
		const remembered = targetedModel('test:remembered', sessionType);
		const modelChanges = disposables.add(new Emitter<string>());
		let models: ILanguageModelChatMetadataAndIdentifier[] = [];
		const applied: string[] = [];
		const runtime: IChatInputModelSelectionRuntime = {
			location: ChatAgentLocation.Chat,
			getCurrentModeKind: () => ChatModeKind.Ask,
			getCurrentSessionType: () => sessionType,
			isEmpty: () => true,
			getModels: () => models,
			getAllModels: () => models,
			requiresCustomModels: () => true,
			getConfiguredModelValue: () => undefined,
			resolveModelIdentifier: identifier => resolveModelIdentifier(models, identifier, true),
			subscribeToModelChanges: listener => modelChanges.event(listener),
			getBoundConversationKey: () => 'chat:one',
			getVisibleConversationKey: () => 'chat:one',
			restoreModelConfiguration: () => { },
			applyModel: selected => {
				applied.push(selected.identifier);
				selection.setCurrentModel(selected, false);
			},
		};
		const controller = disposables.add(new ChatInputModelSelectionController(selection, runtime));

		controller.initialize(remembered.identifier, () => { });
		const pendingAfterInit = controller.hasPendingIntent();
		const appliedAfterInit = [...applied];
		// An intermediate empty re-resolution must not end the wait or apply a default.
		modelChanges.fire('still-empty');
		const pendingAfterEmpty = controller.hasPendingIntent();
		// The agent-host pool finally publishes its models.
		models = [remembered];
		modelChanges.fire('loaded');

		assert.deepStrictEqual({
			pendingAfterInit,
			appliedAfterInit,
			pendingAfterEmpty,
			pendingAfterLoad: controller.hasPendingIntent(),
			applied,
			current: selection.currentModel.get()?.identifier,
		}, {
			pendingAfterInit: true,
			appliedAfterInit: [],
			pendingAfterEmpty: true,
			pendingAfterLoad: false,
			applied: [remembered.identifier],
			current: remembered.identifier,
		});
	});

	test('late best-match restore remains authoritative after configured-model refresh', () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const sessionType = 'agent-host-test';
		const desired = targetedModel('test/desired', sessionType);
		const matchBase = targetedModel('test/match', sessionType);
		const match = { ...matchBase, metadata: { ...matchBase.metadata, id: desired.metadata.id } };
		const configured = targetedModel('test/configured', sessionType);
		const state: IRuntimeState = { models: [], resolved: false, sessionType, configuredModel: configured.metadata.id };
		const applied: string[] = [];
		const controller = disposables.add(new ChatInputModelSelectionController(selection, createRuntime(selection, state, modelChanges, applied)));

		controller.syncFromConversationState(desired, undefined, sessionType, 'chat:one');
		state.models = [match, configured];
		state.resolved = true;
		modelChanges.fire('test');
		controller.reconcileModelListChange(state.models);

		assert.deepStrictEqual({
			applied,
			current: selection.currentModel.get()?.identifier,
			reason: selection.selectionReason,
		}, {
			applied: [match.identifier],
			current: match.identifier,
			reason: ModelSelectionReason.SessionRestore,
		});
	});

	test('terminal restore fallback cancels obsolete session intent', () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const sessionType = 'agent-host-test';
		const staleDesired = targetedModel('test/stale', sessionType);
		const fallback = targetedModel('test/fallback', sessionType);
		const inapplicable = model('test/inapplicable');
		const state: IRuntimeState = { models: [], resolved: false, sessionType };
		const applied: string[] = [];
		const controller = disposables.add(new ChatInputModelSelectionController(selection, createRuntime(selection, state, modelChanges, applied)));

		controller.syncFromConversationState(staleDesired, undefined, sessionType, 'chat:one');
		state.models = [fallback];
		state.resolved = true;
		controller.syncFromConversationState(inapplicable, undefined, sessionType, 'chat:one');
		state.models = [fallback, staleDesired];
		modelChanges.fire('test');

		assert.deepStrictEqual({ pending: controller.hasPendingIntent(), applied }, {
			pending: false,
			applied: [fallback.identifier],
		});
	});

	test('does not apply a late history model after the visible conversation changes', () => {
		const selection = new ChatModelSelectionModel();
		const modelChanges = disposables.add(new Emitter<string>());
		const restored = model('test/restored');
		let models: ILanguageModelChatMetadataAndIdentifier[] = [];
		let visibleConversation = 'chat:one';
		const applied: string[] = [];
		const runtime: IChatInputModelSelectionRuntime = {
			location: ChatAgentLocation.Chat,
			getCurrentModeKind: () => ChatModeKind.Ask,
			getCurrentSessionType: () => undefined,
			isEmpty: () => false,
			getModels: () => models,
			getAllModels: () => models,
			requiresCustomModels: () => false,
			getConfiguredModelValue: () => undefined,
			resolveModelIdentifier: identifier => resolveModelIdentifier(models, identifier, true),
			subscribeToModelChanges: listener => modelChanges.event(listener),
			getBoundConversationKey: () => visibleConversation,
			getVisibleConversationKey: () => visibleConversation,
			restoreModelConfiguration: () => { },
			applyModel: selected => applied.push(selected.identifier),
		};
		const controller = disposables.add(new ChatInputModelSelectionController(selection, runtime));

		controller.preselectFromHistory(restored.identifier, 'chat:one');
		visibleConversation = 'chat:two';
		models = [restored];
		modelChanges.fire('test');

		assert.deepStrictEqual(applied, []);
	});

	test('revalidates a selection when switching model pools', () => {
		const selection = new ChatModelSelectionModel();
		const general = model('test/general');
		const targeted = targetedModel('test/targeted', 'agent-host-test');
		const state: { sessionType: string | undefined } = { sessionType: undefined };
		const applied: string[] = [];
		const runtime: IChatInputModelSelectionRuntime = {
			location: ChatAgentLocation.Chat,
			getCurrentModeKind: () => ChatModeKind.Ask,
			getCurrentSessionType: () => state.sessionType,
			isEmpty: () => true,
			getModels: type => type ? [targeted] : [general],
			getAllModels: () => [general, targeted],
			requiresCustomModels: () => true,
			getConfiguredModelValue: () => undefined,
			resolveModelIdentifier: identifier => resolveModelIdentifier([general, targeted], identifier, true),
			subscribeToModelChanges: () => toDisposable(() => { }),
			getBoundConversationKey: () => 'chat:one',
			getVisibleConversationKey: () => 'chat:one',
			restoreModelConfiguration: () => { },
			applyModel: selected => {
				applied.push(selected.identifier);
				selection.setCurrentModel(selected, false);
			},
		};
		const controller = disposables.add(new ChatInputModelSelectionController(selection, runtime));
		selection.setCurrentModel(general, false);
		state.sessionType = 'agent-host-test';

		controller.revalidateForSessionType(() => { });

		assert.deepStrictEqual({ applied, current: selection.currentModel.get()?.identifier }, {
			applied: [targeted.identifier],
			current: targeted.identifier,
		});
	});
});
