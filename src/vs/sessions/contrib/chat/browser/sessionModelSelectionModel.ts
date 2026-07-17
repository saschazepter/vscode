/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableValue } from '../../../../base/common/observable.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ChatConfiguration } from '../../../../workbench/contrib/chat/common/constants.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { IPendingModelSelection, transitionModelSelection } from '../../../../workbench/contrib/chat/common/modelSelection.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionModelPickerOptions, ISessionsProvider } from '../../../services/sessions/common/sessionsProvider.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';

export interface INormalizedSessionModelPickerOptions extends ISessionModelPickerOptions {
	readonly showAutoModel: boolean;
}

const DEFAULT_MODEL_PICKER_OPTIONS: INormalizedSessionModelPickerOptions = {
	useGroupedModelPicker: true,
	showFeatured: true,
	showUnavailableFeatured: false,
	showManageModelsAction: false,
	showAutoModel: true,
};

export function normalizeModelPickerOptions(options: ISessionModelPickerOptions | undefined): INormalizedSessionModelPickerOptions {
	return {
		...DEFAULT_MODEL_PICKER_OPTIONS,
		...options,
		showAutoModel: options?.showAutoModel ?? true,
	};
}

export function modelPickerStorageKey(providerId: string, sessionType: string): string {
	return `sessions.modelPicker.${providerId}.${sessionType}.selectedModelId`;
}

export interface ISessionModelSelectionTarget {
	readonly providerId: string;
	readonly sessionType: string;
	readonly sessionId: string;
}

export function persistSessionModelSelection(
	session: ISessionModelSelectionTarget,
	provider: Pick<ISessionsProvider, 'setModel'>,
	storageService: Pick<IStorageService, 'store'>,
	model: ILanguageModelChatMetadataAndIdentifier,
): void {
	storageService.store(
		modelPickerStorageKey(session.providerId, session.sessionType),
		model.identifier,
		StorageScope.PROFILE,
		StorageTarget.MACHINE,
	);
	provider.setModel(session.sessionId, model.identifier);
}

export function selectAvailableSessionModel(
	session: ISessionModelSelectionTarget,
	provider: Pick<ISessionsProvider, 'getModelsSnapshot' | 'setModel'>,
	storageService: Pick<IStorageService, 'store'>,
	modelIdentifier: string,
): ILanguageModelChatMetadataAndIdentifier | undefined {
	const model = provider.getModelsSnapshot(session.sessionId).models.find(model => model.identifier === modelIdentifier);
	if (!model) {
		return undefined;
	}
	persistSessionModelSelection(session, provider, storageService, model);
	return model;
}

export function hasSelectableModel(
	models: readonly ILanguageModelChatMetadataAndIdentifier[],
	options: INormalizedSessionModelPickerOptions,
): boolean {
	return models.length > 0 || options.showAutoModel;
}

export const ISessionModelSelectionModel = createDecorator<ISessionModelSelectionModel>('sessionModelSelectionModel');

export interface ISessionModelSelectionState {
	readonly currentModel: ILanguageModelChatMetadataAndIdentifier | undefined;
	readonly pendingSelection: IPendingModelSelection | undefined;
	readonly models: readonly ILanguageModelChatMetadataAndIdentifier[];
	readonly options: INormalizedSessionModelPickerOptions;
	readonly hasSelectableModel: boolean;
}

export interface ISessionModelSelectionModel {
	readonly _serviceBrand: undefined;
	readonly state: IObservable<ISessionModelSelectionState>;
	selectModel(modelIdentifier: string): boolean;
}

export class SessionModelSelectionModel extends Disposable implements ISessionModelSelectionModel {

	declare readonly _serviceBrand: undefined;

	private readonly _state = observableValue<ISessionModelSelectionState>(this, {
		currentModel: undefined,
		pendingSelection: undefined,
		models: [],
		options: normalizeModelPickerOptions(undefined),
		hasSelectableModel: false,
	});
	readonly state: IObservable<ISessionModelSelectionState> = this._state;

	private readonly _providerListener = this._register(new MutableDisposable());
	private _provider: ISessionsProvider | undefined;
	private _previousSessionKey: string | undefined;
	private _lastPushedChatKey: string | undefined;

	constructor(
		private readonly _session: IObservable<IActiveSession | undefined>,
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();

		this._register(autorun(reader => {
			const session = this._session.read(reader);
			session?.modelId.read(reader);
			session?.status.read(reader);
			session?.activeChat.read(reader);
			this._refresh(session);
		}));
		this._register(this._configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatConfiguration.DefaultModel)) {
				this._refresh();
			}
		}));
		this._register(this._sessionsProvidersService.onDidChangeProviders(() => this._refresh()));
	}

	selectModel(modelIdentifier: string): boolean {
		const session = this._session.get();
		const provider = session ? this._sessionsProvidersService.getProvider(session.providerId) : undefined;
		if (!session || !provider) {
			return false;
		}

		const models = provider.getModelsSnapshot(session.sessionId).models;
		const model = models.find(model => model.identifier === modelIdentifier);
		if (!model) {
			return false;
		}

		const options = normalizeModelPickerOptions(provider.getModelPickerOptions(session.sessionId));
		this._state.set({
			models,
			options,
			hasSelectableModel: hasSelectableModel(models, options),
			currentModel: model,
			pendingSelection: undefined,
		}, undefined);
		this._previousSessionKey = this._sessionKey(session);
		this._lastPushedChatKey = session.activeChat.get().resource.toString();
		this._applyModel(session, provider, model);
		return true;
	}

	private _refresh(session = this._session.get()): void {
		const provider = session ? this._sessionsProvidersService.getProvider(session.providerId) : undefined;
		this._setProvider(provider);
		const sessionKey = session ? this._sessionKey(session) : undefined;
		const sessionModelId = session?.modelId.get();
		const rememberedModelId = session
			? this._storageService.get(modelPickerStorageKey(session.providerId, session.sessionType), StorageScope.PROFILE)
			: undefined;
		const desiredModelIdentifier = sessionModelId ?? rememberedModelId;
		const snapshot = session && provider ? provider.getModelsSnapshot(session.sessionId, desiredModelIdentifier) : { models: [], desiredModelResolution: { kind: 'notRequested' } as const };
		const models = snapshot.models;
		const options = normalizeModelPickerOptions(session && provider ? provider.getModelPickerOptions(session.sessionId) : undefined);
		const result = transitionModelSelection({
			session: session ? {
				kind: session.status.get() === SessionStatus.Untitled ? 'untitled' : 'existing',
				key: sessionKey!,
				chatKey: session.activeChat.get().resource.toString(),
				modelId: sessionModelId,
			} : { kind: 'none' },
			models: {
				available: models,
				configuredModel: this._configurationService.getValue<string>(ChatConfiguration.DefaultModel),
				rememberedModelId,
				desiredModelResolution: snapshot.desiredModelResolution,
			},
			previous: {
				sessionKey: this._previousSessionKey,
				lastPushedChatKey: this._lastPushedChatKey,
				currentModel: this._state.get().currentModel,
			},
		});

		this._previousSessionKey = result.sessionKey;
		this._lastPushedChatKey = result.lastPushedChatKey;
		this._state.set({
			models,
			options,
			hasSelectableModel: !!session && !!provider && hasSelectableModel(models, options),
			currentModel: result.currentModel,
			pendingSelection: result.pendingSelection,
		}, undefined);

		if (result.effect.kind === 'apply' && session && provider) {
			this._applyModel(session, provider, result.effect.model);
		}
	}

	private _setProvider(provider: ISessionsProvider | undefined): void {
		if (this._provider === provider) {
			return;
		}
		this._provider = provider;
		this._providerListener.value = provider?.onDidChangeModels(() => this._refresh());
	}

	private _applyModel(session: IActiveSession, provider: ISessionsProvider, model: ILanguageModelChatMetadataAndIdentifier): void {
		persistSessionModelSelection(session, provider, this._storageService, model);
	}

	private _sessionKey(session: IActiveSession): string {
		return `${session.providerId}/${session.sessionType}`;
	}

}
