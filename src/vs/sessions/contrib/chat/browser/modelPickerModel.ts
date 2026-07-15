/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableValue, transaction } from '../../../../base/common/observable.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { ChatConfiguration } from '../../../../workbench/contrib/chat/common/constants.js';
import { ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsProvider } from '../../../services/sessions/common/sessionsProvider.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';
import { hasSelectableModel, INormalizedSessionModelPickerOptions, modelPickerStorageKey, normalizeModelPickerOptions, persistSessionModelSelection, transitionModelSelection } from './modelPickerSelection.js';

export const ISessionModelSelectionModel = createDecorator<ISessionModelSelectionModel>('sessionModelSelectionModel');

export interface ISessionModelSelectionModel {
	readonly _serviceBrand: undefined;
	readonly currentModel: IObservable<ILanguageModelChatMetadataAndIdentifier | undefined>;
	readonly models: IObservable<readonly ILanguageModelChatMetadataAndIdentifier[]>;
	readonly options: IObservable<INormalizedSessionModelPickerOptions>;
	readonly hasSelectableModel: IObservable<boolean>;
	selectModel(modelIdentifier: string): boolean;
}

export class SessionModelSelectionModel extends Disposable implements ISessionModelSelectionModel {

	declare readonly _serviceBrand: undefined;

	private readonly _currentModel = observableValue<ILanguageModelChatMetadataAndIdentifier | undefined>(this, undefined);
	readonly currentModel: IObservable<ILanguageModelChatMetadataAndIdentifier | undefined> = this._currentModel;

	private readonly _models = observableValue<readonly ILanguageModelChatMetadataAndIdentifier[]>(this, []);
	readonly models: IObservable<readonly ILanguageModelChatMetadataAndIdentifier[]> = this._models;

	private readonly _options = observableValue<INormalizedSessionModelPickerOptions>(this, normalizeModelPickerOptions(undefined));
	readonly options: IObservable<INormalizedSessionModelPickerOptions> = this._options;

	private readonly _hasSelectableModel = observableValue(this, false);
	readonly hasSelectableModel: IObservable<boolean> = this._hasSelectableModel;

	private readonly _providerListener = this._register(new MutableDisposable());
	private _provider: ISessionsProvider | undefined;
	private _previousSessionKey: string | undefined;
	private _lastPushedChatKey: string | undefined;

	constructor(
		private readonly _session: IObservable<IActiveSession | undefined>,
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
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

		const models = provider.getModels(session.sessionId);
		const model = models.find(model => model.identifier === modelIdentifier);
		if (!model) {
			return false;
		}

		const options = normalizeModelPickerOptions(provider.getModelPickerOptions(session.sessionId));
		transaction(tx => {
			this._models.set(models, tx);
			this._options.set(options, tx);
			this._hasSelectableModel.set(hasSelectableModel(models, options), tx);
			this._currentModel.set(model, tx);
		});
		this._previousSessionKey = this._sessionKey(session);
		this._lastPushedChatKey = session.activeChat.get().resource.toString();
		this._applyModel(session, provider, model);
		return true;
	}

	private _refresh(session = this._session.get()): void {
		const provider = session ? this._sessionsProvidersService.getProvider(session.providerId) : undefined;
		this._setProvider(provider);
		const models = session && provider ? provider.getModels(session.sessionId) : [];
		const options = normalizeModelPickerOptions(session && provider ? provider.getModelPickerOptions(session.sessionId) : undefined);
		const sessionKey = session ? this._sessionKey(session) : undefined;
		const sessionModelId = session?.modelId.get();
		const rememberedModelId = session
			? this._storageService.get(modelPickerStorageKey(session.providerId, session.sessionType), StorageScope.PROFILE)
			: undefined;
		const result = transitionModelSelection({
			sessionKey,
			previousSessionKey: this._previousSessionKey,
			chatKey: session?.activeChat.get().resource.toString(),
			lastPushedChatKey: this._lastPushedChatKey,
			isUntitled: session?.status.get() === SessionStatus.Untitled,
			sessionModelId,
			currentModel: this._currentModel.get(),
			configuredModel: this._configurationService.getValue<string>(ChatConfiguration.DefaultModel),
			rememberedModelId,
			models,
			isSessionModelVendorResolved: !!sessionModelId && this._hasResolvedVendor(sessionModelId),
		});

		this._previousSessionKey = result.sessionKey;
		this._lastPushedChatKey = result.lastPushedChatKey;
		transaction(tx => {
			this._models.set(models, tx);
			this._options.set(options, tx);
			this._hasSelectableModel.set(!!session && !!provider && hasSelectableModel(models, options), tx);
			this._currentModel.set(result.currentModel, tx);
		});

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

	private _hasResolvedVendor(modelIdentifier: string): boolean {
		const separator = modelIdentifier.search(/[/:]/);
		return separator !== -1 && this._languageModelsService.hasResolvedVendor(modelIdentifier.substring(0, separator));
	}
}
