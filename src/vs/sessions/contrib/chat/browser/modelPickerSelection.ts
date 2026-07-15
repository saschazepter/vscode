/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { resolveConfiguredModel } from '../../../../workbench/contrib/chat/browser/widget/input/chatModelSelectionLogic.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ISessionModelPickerOptions, ISessionsProvider } from '../../../services/sessions/common/sessionsProvider.js';

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
	provider: Pick<ISessionsProvider, 'getModels' | 'setModel'>,
	storageService: Pick<IStorageService, 'store'>,
	modelIdentifier: string,
): ILanguageModelChatMetadataAndIdentifier | undefined {
	const model = provider.getModels(session.sessionId).find(model => model.identifier === modelIdentifier);
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

export const enum ModelSelectionReason {
	ConfiguredDefault = 'configuredDefault',
	FirstAvailable = 'firstAvailable',
	NoModels = 'noModels',
	Remembered = 'remembered',
	RemovedModelFallback = 'removedModelFallback',
	SessionRestore = 'sessionRestore',
	NewChatRepush = 'newChatRepush',
}

export type ModelSelectionEffect =
	| { readonly kind: 'none' }
	| { readonly kind: 'clear'; readonly reason: ModelSelectionReason.NoModels | ModelSelectionReason.SessionRestore }
	| { readonly kind: 'apply'; readonly model: ILanguageModelChatMetadataAndIdentifier; readonly reason: Exclude<ModelSelectionReason, ModelSelectionReason.NoModels> };

export interface IModelSelectionTransitionInput {
	readonly sessionKey: string | undefined;
	readonly previousSessionKey: string | undefined;
	readonly chatKey: string | undefined;
	readonly lastPushedChatKey: string | undefined;
	readonly isUntitled: boolean;
	readonly sessionModelId: string | undefined;
	readonly currentModel: ILanguageModelChatMetadataAndIdentifier | undefined;
	readonly configuredModel: string | undefined;
	readonly rememberedModelId: string | undefined;
	readonly models: readonly ILanguageModelChatMetadataAndIdentifier[];
	readonly isSessionModelVendorResolved: boolean;
}

export interface IModelSelectionTransitionResult {
	readonly currentModel: ILanguageModelChatMetadataAndIdentifier | undefined;
	readonly effect: ModelSelectionEffect;
	readonly sessionKey: string | undefined;
	readonly lastPushedChatKey: string | undefined;
}

export function transitionModelSelection(input: IModelSelectionTransitionInput): IModelSelectionTransitionResult {
	const sessionChanged = input.sessionKey !== input.previousSessionKey;
	const currentModel = sessionChanged ? undefined : input.currentModel;
	if (input.models.length === 0) {
		return {
			currentModel: undefined,
			effect: currentModel ? { kind: 'clear', reason: ModelSelectionReason.NoModels } : { kind: 'none' },
			sessionKey: input.sessionKey,
			lastPushedChatKey: input.lastPushedChatKey,
		};
	}

	const sessionModel = input.sessionModelId
		? input.models.find(model => model.identifier === input.sessionModelId)
		: undefined;
	const fallback = resolveFallbackModel(input.models, input.rememberedModelId);

	if (input.sessionKey && !input.isUntitled) {
		if (!input.sessionModelId || sessionModel || !input.isSessionModelVendorResolved) {
			return {
				currentModel: sessionModel,
				effect: !sessionModel && currentModel
					? { kind: 'clear', reason: ModelSelectionReason.SessionRestore }
					: { kind: 'none' },
				sessionKey: input.sessionKey,
				lastPushedChatKey: input.chatKey,
			};
		}

		return applyResult(input, fallback, ModelSelectionReason.RemovedModelFallback);
	}

	const configured = resolveConfiguredModel(input.configuredModel, [...input.models]);
	if (configured && input.sessionKey && input.chatKey !== input.lastPushedChatKey) {
		return applyResult(input, configured, ModelSelectionReason.ConfiguredDefault);
	}
	if (sessionModel && currentModel && sessionModel.identifier !== currentModel.identifier) {
		return {
			currentModel: sessionModel,
			effect: { kind: 'none' },
			sessionKey: input.sessionKey,
			lastPushedChatKey: input.chatKey,
		};
	}

	if (!currentModel) {
		const model = sessionModel ?? fallback;
		const reason = sessionModel
			? ModelSelectionReason.SessionRestore
			: model.identifier === input.rememberedModelId
				? ModelSelectionReason.Remembered
				: ModelSelectionReason.FirstAvailable;
		return applyResult(input, model, reason);
	}

	if (input.sessionKey && input.isUntitled && input.chatKey !== input.lastPushedChatKey && input.models.some(model => model.identifier === currentModel.identifier)) {
		return applyResult(input, currentModel, ModelSelectionReason.NewChatRepush);
	}

	return {
		currentModel,
		effect: { kind: 'none' },
		sessionKey: input.sessionKey,
		lastPushedChatKey: input.lastPushedChatKey,
	};
}

function resolveFallbackModel(
	models: readonly ILanguageModelChatMetadataAndIdentifier[],
	rememberedModelId: string | undefined,
): ILanguageModelChatMetadataAndIdentifier {
	return models.find(model => model.identifier === rememberedModelId) ?? models[0];
}

function applyResult(
	input: IModelSelectionTransitionInput,
	model: ILanguageModelChatMetadataAndIdentifier,
	reason: Exclude<ModelSelectionReason, ModelSelectionReason.NoModels>,
): IModelSelectionTransitionResult {
	return {
		currentModel: model,
		effect: { kind: 'apply', model, reason },
		sessionKey: input.sessionKey,
		lastPushedChatKey: input.chatKey,
	};
}
