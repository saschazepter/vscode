/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ChatAgentLocation, ChatModeKind } from '../../../common/constants.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../../common/languageModels.js';
import { InitialModelSelectionResult, ModelIdentifierResolution, ModelSelectionReason, resolveConfiguredModel, resolveInitialModelSelection, resolveModelIdentifier } from '../../../common/modelSelection.js';
import { findBestMatchingModel, findDefaultModel, hasModelsTargetingSession, isModelValidForSession, resolveModelFromSyncState, shouldDropAgnosticDraftModel, shouldResetModelToDefault, shouldResetOnModelListChange, shouldWaitForSessionModel } from './chatInputModelUtils.js';
import { IChatModelSelectionDiagnostics, NullChatModelSelectionDiagnostics } from './chatModelSelectionDiagnostics.js';
import { ChatModelSelectionModel } from './chatModelSelectionModel.js';

/** Supplies Workbench chat's filtered model catalog and conversation effects. */
export interface IChatInputModelSelectionRuntime {
	readonly location: ChatAgentLocation;
	readonly getCurrentModeKind: () => ChatModeKind;
	readonly getCurrentSessionType: () => string | undefined;
	readonly isEmpty: () => boolean;
	readonly getModels: (sessionType: string | undefined) => ILanguageModelChatMetadataAndIdentifier[];
	readonly getAllModels: () => ILanguageModelChatMetadataAndIdentifier[];
	readonly requiresCustomModels: (sessionType: string) => boolean;
	readonly getConfiguredModelValue: () => string | undefined;
	readonly resolveModelIdentifier: (identifier: string) => ModelIdentifierResolution;
	readonly subscribeToModelChanges: (listener: () => void) => IDisposable;
	readonly getBoundConversationKey: () => string | undefined;
	readonly getVisibleConversationKey: () => string | undefined;
	readonly restoreModelConfiguration: (modelId: string, configuration: Record<string, unknown> | undefined) => void;
	readonly applyModel: (model: ILanguageModelChatMetadataAndIdentifier) => void;
}

interface IResolvedDraftModelSelection {
	readonly model: ILanguageModelChatMetadataAndIdentifier | undefined;
	readonly changed: boolean;
}

type ModelSelectionIntent =
	| { readonly kind: 'remembered'; readonly modelId: string }
	| { readonly kind: 'programmatic'; readonly resolveModel: () => ILanguageModelChatMetadataAndIdentifier | undefined; readonly sessionKey: string | undefined; readonly conversationKey: string | undefined; readonly complete: (applied: boolean) => void }
	| { readonly kind: 'session'; readonly model: ILanguageModelChatMetadataAndIdentifier; readonly configuration: Record<string, unknown> | undefined; readonly sessionType: string | undefined; readonly conversationKey: string }
	| { readonly kind: 'history'; readonly modelId: string; readonly conversationKey: string };

/** Reconciles the shared selection model with Workbench-specific input and catalog state. */
export class ChatInputModelSelectionController extends Disposable {

	private _intent: ModelSelectionIntent | undefined;
	private _restorePerTypeModel = false;

	constructor(
		private readonly _model: ChatModelSelectionModel,
		private readonly _runtime: IChatInputModelSelectionRuntime,
		private readonly _diagnostics: IChatModelSelectionDiagnostics = NullChatModelSelectionDiagnostics,
	) {
		super();
		this._register(this._runtime.subscribeToModelChanges(() => this.reconcileModelListChange(this._runtime.getModels(this._runtime.getCurrentSessionType()))));
		this._register(toDisposable(() => this._clearIntent()));
	}

	get restorePerTypeModel(): boolean {
		return this._restorePerTypeModel;
	}

	beginSessionSwitch(isEmpty: boolean, ownsPool: boolean, hadIncomingModel: boolean): void {
		this._model.resetSelectionOrigin();
		this._restorePerTypeModel = isEmpty && ownsPool && !hadIncomingModel;
		this._clearIntent();
	}

	endSessionSwitch(): void {
		this._restorePerTypeModel = false;
	}

	hasPendingIntent(): boolean {
		return !!this._intent;
	}

	hasPendingProgrammaticSelection(): boolean {
		return this._intent?.kind === 'programmatic';
	}

	clearIntent(): void {
		this._clearIntent();
	}

	clearHistoryIntent(): void {
		if (this._intent?.kind === 'history') {
			this._clearIntent();
		}
	}

	applyExplicitSelection(
		model: ILanguageModelChatMetadataAndIdentifier,
		sessionKey: string | undefined,
		conversationKey: string | undefined,
		apply: () => void,
		rollbackOnError: boolean,
	): void {
		this._clearIntent();
		this._model.applyExplicitSelection(model, sessionKey, conversationKey, apply, rollbackOnError);
	}

	applyProgrammaticSelection(
		model: ILanguageModelChatMetadataAndIdentifier,
		sessionKey: string | undefined,
		conversationKey: string | undefined,
		apply: () => void,
	): void {
		this._clearIntent();
		this._model.applyProgrammaticSelection(model, sessionKey, conversationKey);
		apply();
	}

	requestProgrammaticSelection(
		resolveModel: () => ILanguageModelChatMetadataAndIdentifier | undefined,
		sessionKey: string | undefined,
		conversationKey: string | undefined,
		apply: (model: ILanguageModelChatMetadataAndIdentifier) => void,
	): Promise<boolean> {
		this._clearIntent();
		this._model.setTransitionMemory(sessionKey, conversationKey, ModelSelectionReason.ProgrammaticSelection);
		return new Promise<boolean>(resolve => {
			let complete = resolve;
			this._intent = {
				kind: 'programmatic',
				resolveModel,
				sessionKey,
				conversationKey,
				complete: applied => {
					complete(applied);
					complete = () => { };
				},
			};
			this._reconcileIntent();
		});
	}

	initialize(rememberedModelId: string | undefined, onInitialSelection: (selection: InitialModelSelectionResult) => void): void {
		this._clearIntent();
		const resolveSelection = (): InitialModelSelectionResult => {
			const configuredModelValue = this._runtime.getConfiguredModelValue();
			const models = this._runtime.getModels(this._runtime.getCurrentSessionType());
			const configuredModel = resolveConfiguredModel(configuredModelValue, models);
			const resolution = resolveModelIdentifier(models, rememberedModelId, false);
			return resolveInitialModelSelection({
				configuredModel,
				desiredModelResolution: resolution,
				desiredReason: ModelSelectionReason.Remembered,
				fallbackModel: findDefaultModel(models, this._runtime.location),
				fallbackReason: ModelSelectionReason.FirstAvailable,
			});
		};

		const selection = resolveSelection();
		onInitialSelection(selection);
		this._reportInitialization(this._runtime.getConfiguredModelValue(), rememberedModelId, selection);
		if (selection.kind === 'apply') {
			this._model.setSelectionReason(selection.reason);
			this._runtime.applyModel(selection.model);
			this.ensureCurrentModelSupported();
		} else if (selection.kind === 'pending') {
			this._intent = { kind: 'remembered', modelId: selection.selection.reference };
			const fallbackModel = findDefaultModel(this._runtime.getModels(this._runtime.getCurrentSessionType()), this._runtime.location);
			if (fallbackModel) {
				this._model.setSelectionReason(ModelSelectionReason.FirstAvailable);
				this._runtime.applyModel(fallbackModel);
			}
		}
	}

	ensureCurrentModelSupported(): void {
		const currentModel = this._model.currentModel.get();
		const sessionType = this._runtime.getCurrentSessionType();
		const models = this._runtime.getModels(sessionType);
		const context = {
			location: this._runtime.location,
			currentModeKind: this._runtime.getCurrentModeKind(),
			sessionType,
		};
		const willReset = shouldResetModelToDefault(currentModel, models, context, this._runtime.getAllModels());
		this._diagnostics.report('compatibility-check', {
			currentModel: currentModel?.identifier,
			mode: context.currentModeKind,
			sessionType,
			willReset,
		}, willReset ? 'info' : 'debug');
		if (willReset) {
			this.selectDefault(sessionType);
		}
	}

	selectDefault(sessionType = this._runtime.getCurrentSessionType()): void {
		const allModels = this._runtime.getAllModels();
		if (sessionType && this._runtime.requiresCustomModels(sessionType) && !hasModelsTargetingSession(allModels, sessionType)) {
			return;
		}
		const models = this._runtime.getModels(sessionType);
		const configuredModel = resolveConfiguredModel(this._runtime.getConfiguredModelValue(), models);
		const defaultModel = configuredModel ?? findDefaultModel(models, this._runtime.location);
		this._diagnostics.report('select-default', {
			configuredModel: configuredModel?.identifier,
			defaultModel: defaultModel?.identifier,
			currentModel: this._model.currentModel.get()?.identifier,
		}, defaultModel ? 'info' : 'debug');
		if (!defaultModel) {
			return;
		}
		if (!this.hasPendingProgrammaticSelection()) {
			this._model.setSelectionReason(configuredModel ? ModelSelectionReason.ConfiguredDefault : ModelSelectionReason.FirstAvailable);
		}
		this._runtime.applyModel(defaultModel);
	}

	applyConfiguredDefault(): boolean {
		if (!this._runtime.isEmpty()
			|| this._model.selectionIsAuthoritative
			|| (this._intent && this._intent.kind !== 'remembered')) {
			return false;
		}
		const configuredValue = this._runtime.getConfiguredModelValue();
		if (!configuredValue) {
			return false;
		}
		const configuredModel = resolveConfiguredModel(configuredValue, this._runtime.getModels(this._runtime.getCurrentSessionType()));
		if (!configuredModel) {
			return false;
		}
		const matchesCurrent = configuredModel.identifier === this._model.currentModel.get()?.identifier;
		const supersededRememberedIntent = this._intent?.kind === 'remembered';
		if (supersededRememberedIntent) {
			this._clearIntent();
		}
		if (matchesCurrent) {
			if (this._model.selectionReason !== ModelSelectionReason.ConfiguredDefault) {
				this._model.setSelectionReason(ModelSelectionReason.ConfiguredDefault);
				return true;
			}
			return supersededRememberedIntent;
		}
		this._model.setSelectionReason(ModelSelectionReason.ConfiguredDefault);
		this._runtime.applyModel(configuredModel);
		this.ensureCurrentModelSupported();
		return true;
	}

	reconcileModelListChange(models: readonly ILanguageModelChatMetadataAndIdentifier[]): void {
		if (this.applyConfiguredDefault() || this._reconcileIntent()) {
			return;
		}
		const currentModel = this._model.currentModel.get();
		const locationDefault = models.find(model => model.metadata.isDefaultForLocation[this._runtime.location]);
		if (this._runtime.isEmpty()
			&& this._model.selectionReason === ModelSelectionReason.FirstAvailable
			&& locationDefault
			&& currentModel?.identifier !== locationDefault.identifier) {
			this._runtime.applyModel(locationDefault);
			return;
		}
		if (!shouldResetOnModelListChange(currentModel?.identifier, [...models])) {
			return;
		}
		const match = findBestMatchingModel(currentModel, models);
		if (match) {
			this._runtime.applyModel(match);
		} else {
			this.selectDefault();
		}
	}

	syncFromConversationState(
		desiredModel: ILanguageModelChatMetadataAndIdentifier,
		modelConfiguration: Record<string, unknown> | undefined,
		sessionType: string | undefined,
		conversationKey: string,
	): void {
		this.clearHistoryIntent();
		const allModels = this._runtime.getAllModels();
		const currentModel = this._model.currentModel.get();
		const resolution = this._runtime.resolveModelIdentifier(desiredModel.identifier);
		const syncResult = resolveModelFromSyncState(desiredModel, currentModel, allModels, sessionType, {
			location: this._runtime.location,
			currentModeKind: this._runtime.getCurrentModeKind(),
			sessionType,
		});
		this._diagnostics.report('conversation-restore', {
			desiredModel: desiredModel.identifier,
			currentModel: currentModel?.identifier,
			sessionType,
			action: syncResult.action,
		}, syncResult.action === 'keep' ? 'debug' : 'info');
		if (syncResult.action === 'apply' || syncResult.action === 'keep') {
			this._applySessionRestore(desiredModel, syncResult.action === 'apply', {
				modelId: desiredModel.identifier,
				configuration: modelConfiguration,
			});
			return;
		}

		const pool = this._runtime.getModels(sessionType);
		const match = findBestMatchingModel(desiredModel, pool) ?? findBestMatchingModel(currentModel, pool);
		if (match) {
			this._applySessionRestore(match, true);
		} else if (resolution.kind === 'pending' && shouldWaitForSessionModel(desiredModel, sessionType, allModels)) {
			this._clearIntent();
			this._intent = { kind: 'session', model: desiredModel, configuration: modelConfiguration, sessionType, conversationKey };
		} else {
			this._clearIntent();
			this.selectDefault(sessionType);
		}
	}

	ensureCurrentModelInSessionPool(): void {
		const currentModel = this._model.currentModel.get();
		if (currentModel && !isModelValidForSession(currentModel, this._runtime.getAllModels(), this._runtime.getCurrentSessionType())) {
			this.selectDefault();
		}
	}

	revalidateForSessionType(initialize: () => void): void {
		const previousModel = this._model.currentModel.get();
		this._model.resetSelectionOrigin();
		initialize();
		const restoredModel = this._model.currentModel.get();
		const sessionType = this._runtime.getCurrentSessionType();
		if (restoredModel && isModelValidForSession(restoredModel, this._runtime.getAllModels(), sessionType)) {
			return;
		}
		const match = findBestMatchingModel(previousModel, this._runtime.getModels(sessionType));
		if (match) {
			this._runtime.applyModel(match);
		} else {
			this.selectDefault(sessionType);
		}
	}

	preselectFromHistory(modelId: string, conversationKey: string): void {
		this.clearIntent();
		const tryMatch = (): ILanguageModelChatMetadataAndIdentifier | undefined => {
			const models = this._runtime.getModels(this._runtime.getCurrentSessionType());
			if (models.length === 0 || (models.length === 1 && models[0].metadata.id.toLocaleLowerCase() === 'auto')) {
				return undefined;
			}
			return models.find(model => model.identifier === modelId)
				?? models.find(model => model.metadata.id === modelId);
		};
		const match = tryMatch();
		if (match) {
			this._model.setSelectionReason(ModelSelectionReason.SessionRestore);
			this._runtime.applyModel(match);
			return;
		}
		this._intent = { kind: 'history', modelId, conversationKey };
	}

	resolveDraftModel(
		draftModel: ILanguageModelChatMetadataAndIdentifier | undefined,
		sessionTypeForValidation: string | undefined,
		validatePool: boolean,
	): IResolvedDraftModelSelection {
		let model = draftModel;
		if (validatePool && shouldDropAgnosticDraftModel(model, this._runtime.getAllModels(), sessionTypeForValidation)) {
			model = undefined;
		}
		const configuredValue = this._runtime.getConfiguredModelValue();
		if (configuredValue) {
			model = resolveConfiguredModel(configuredValue, this._runtime.getModels(this._runtime.getCurrentSessionType()));
		}
		return { model, changed: model?.identifier !== draftModel?.identifier };
	}

	private _applySessionRestore(
		model: ILanguageModelChatMetadataAndIdentifier,
		applyModel: boolean,
		configuration?: { readonly modelId: string; readonly configuration: Record<string, unknown> | undefined },
	): void {
		this._clearIntent();
		this._model.setSelectionReason(ModelSelectionReason.SessionRestore);
		if (configuration) {
			this._runtime.restoreModelConfiguration(configuration.modelId, configuration.configuration);
		}
		if (applyModel) {
			this._runtime.applyModel(model);
		}
	}

	private _reconcileIntent(): boolean {
		const intent = this._intent;
		if (!intent) {
			return false;
		}

		if (intent.kind === 'programmatic') {
			if (this._runtime.getBoundConversationKey() !== intent.conversationKey) {
				this._clearIntent();
				return true;
			}
			const model = intent.resolveModel();
			if (!model) {
				return false;
			}
			this._intent = undefined;
			intent.complete(true);
			this.applyProgrammaticSelection(model, intent.sessionKey, intent.conversationKey, () => this._runtime.applyModel(model));
			return true;
		}

		if (intent.kind === 'remembered') {
			const models = this._runtime.getModels(this._runtime.getCurrentSessionType());
			const model = models.find(model => model.identifier === intent.modelId);
			if (model) {
				this._intent = undefined;
				this._model.setSelectionReason(ModelSelectionReason.Remembered);
				this._runtime.applyModel(model);
				this.ensureCurrentModelSupported();
				return true;
			}
			const currentModel = this._model.currentModel.get();
			const replacement = models.find(model => model.metadata.isDefaultForLocation[this._runtime.location]);
			if (replacement && currentModel?.identifier !== replacement.identifier && !this._model.selectionIsAuthoritative) {
				this._model.setSelectionReason(ModelSelectionReason.FirstAvailable);
				this._runtime.applyModel(replacement);
				this.ensureCurrentModelSupported();
				return true;
			}
			return false;
		}

		if (intent.kind === 'session') {
			if (this._runtime.getBoundConversationKey() !== intent.conversationKey) {
				this._clearIntent();
				return true;
			}
			const resolution = this._runtime.resolveModelIdentifier(intent.model.identifier);
			if (resolution.kind === 'available') {
				this._intent = undefined;
				this._applySessionRestore(resolution.model, true, { modelId: intent.model.identifier, configuration: intent.configuration });
				return true;
			}
			if (resolution.kind === 'unavailable') {
				this._intent = undefined;
				const match = findBestMatchingModel(intent.model, this._runtime.getModels(intent.sessionType));
				if (match) {
					this._applySessionRestore(match, true);
				} else {
					this.selectDefault(intent.sessionType);
				}
				return true;
			}
			return false;
		}

		if (this._runtime.getVisibleConversationKey() !== intent.conversationKey) {
			this._clearIntent();
			return true;
		}
		const models = this._runtime.getModels(this._runtime.getCurrentSessionType());
		const model = models.find(model => model.identifier === intent.modelId)
			?? models.find(model => model.metadata.id === intent.modelId);
		if (model && !(models.length === 1 && model.metadata.id.toLocaleLowerCase() === 'auto')) {
			this._intent = undefined;
			this._model.setSelectionReason(ModelSelectionReason.SessionRestore);
			this._runtime.applyModel(model);
			return true;
		}
		return false;
	}

	private _clearIntent(): void {
		const intent = this._intent;
		this._intent = undefined;
		if (intent?.kind === 'programmatic') {
			intent.complete(false);
			if (this._model.selectionReason === ModelSelectionReason.ProgrammaticSelection) {
				this._model.setSelectionReason(undefined);
			}
		}
	}

	private _reportInitialization(configuredModel: string | undefined, rememberedModel: string | undefined, selection: InitialModelSelectionResult): void {
		this._diagnostics.report('initialize', {
			configuredModel,
			rememberedModel,
			availableModels: this._runtime.getModels(this._runtime.getCurrentSessionType()).map(model => model.identifier).join(','),
			selection: selection.kind,
			resultModel: selection.kind === 'apply' ? selection.model.identifier : undefined,
			resultReason: selection.kind === 'apply' ? selection.reason : undefined,
			pendingReference: selection.kind === 'pending' ? selection.selection.reference : undefined,
		}, selection.kind === 'none' ? 'debug' : 'info');
	}
}
