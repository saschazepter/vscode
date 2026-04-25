/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { commands, LanguageModelChatInformation, LanguageModelChatProvider, lm } from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKKnownModels } from '../../byok/common/byokProvider';
import { IExtensionContribution } from '../../common/contributions';
import { AnthropicLMProvider } from './anthropicProvider';
import { AzureBYOKModelProvider } from './azureProvider';
import { BYOKStorageService, IBYOKStorageService } from './byokStorageService';
import { CustomOAIBYOKModelProvider } from './customOAIProvider';
import { GeminiNativeBYOKLMProvider } from './geminiNativeProvider';
import { OllamaLMProvider } from './ollamaProvider';
import { OAIBYOKLMProvider } from './openAIProvider';
import { OpenRouterLMProvider } from './openRouterProvider';
import { XAIBYOKLMProvider } from './xAIProvider';

export const hasByokModelsContextKey = 'github.copilot.hasByokModels';

export const byokVendorIds = [
	OllamaLMProvider.providerId,
	AnthropicLMProvider.providerId,
	GeminiNativeBYOKLMProvider.providerId,
	XAIBYOKLMProvider.providerId,
	OAIBYOKLMProvider.providerId,
	OpenRouterLMProvider.providerId,
	AzureBYOKModelProvider.providerId,
	CustomOAIBYOKModelProvider.providerId,
];

export class BYOKContrib extends Disposable implements IExtensionContribution {
	public readonly id: string = 'byok-contribution';
	private readonly _byokStorageService: IBYOKStorageService;
	private readonly _providers: Map<string, LanguageModelChatProvider<LanguageModelChatInformation>> = new Map();
	private readonly _byokRegistrations = this._register(new DisposableStore());
	private _byokProvidersRegistered = false;

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._byokStorageService = new BYOKStorageService(extensionContext);
		void this._registerProviders().catch(err => {
			this._byokProvidersRegistered = false;
			this._logService.error(err instanceof Error ? err : String(err), 'BYOK: Failed to register providers.');
		});
	}

	private async _registerProviders() {
		if (this._byokProvidersRegistered) {
			return;
		}

		this._byokProvidersRegistered = true;
		const instantiationService = this._instantiationService;

		// Fetch known models from CDN for model metadata (capabilities, token limits).
		// Uses a timeout to avoid blocking provider registration in air-gapped/offline environments.
		const knownModels = await this._fetchKnownModelListWithTimeout(this._fetcherService);
		if (this._store.isDisposed) {
			return;
		}

		this._providers.set(OllamaLMProvider.providerId, instantiationService.createInstance(OllamaLMProvider, this._byokStorageService));
		this._providers.set(AnthropicLMProvider.providerId, instantiationService.createInstance(AnthropicLMProvider, knownModels[AnthropicLMProvider.providerName], this._byokStorageService));
		this._providers.set(GeminiNativeBYOKLMProvider.providerId, instantiationService.createInstance(GeminiNativeBYOKLMProvider, knownModels[GeminiNativeBYOKLMProvider.providerName], this._byokStorageService));
		this._providers.set(XAIBYOKLMProvider.providerId, instantiationService.createInstance(XAIBYOKLMProvider, knownModels[XAIBYOKLMProvider.providerName], this._byokStorageService));
		this._providers.set(OAIBYOKLMProvider.providerId, instantiationService.createInstance(OAIBYOKLMProvider, knownModels[OAIBYOKLMProvider.providerName], this._byokStorageService));
		this._providers.set(OpenRouterLMProvider.providerId, instantiationService.createInstance(OpenRouterLMProvider, this._byokStorageService));
		this._providers.set(AzureBYOKModelProvider.providerId, instantiationService.createInstance(AzureBYOKModelProvider, this._byokStorageService));
		this._providers.set(CustomOAIBYOKModelProvider.providerId, instantiationService.createInstance(CustomOAIBYOKModelProvider, this._byokStorageService));

		for (const [providerName, provider] of this._providers) {
			this._byokRegistrations.add(lm.registerLanguageModelChatProvider(providerName, provider));
		}

		await this._updateHasByokModelsContext();

		// Update context key when language models change (e.g., model configured/removed)
		this._register(lm.onDidChangeChatModels(() => {
			void this._updateHasByokModelsContext().catch(err => {
				this._logService.error(err instanceof Error ? err : String(err), 'BYOK: Failed to update BYOK models context.');
			});
		}));
	}

	async _updateHasByokModelsContext(): Promise<void> {
		try {
			let hasModels = false;
			for (const vendor of this._providers.keys()) {
				const models = await lm.selectChatModels({ vendor });
				if (models.length > 0) {
					hasModels = true;
					break;
				}
			}
			commands.executeCommand('setContext', hasByokModelsContextKey, hasModels);
		} catch (err) {
			this._logService.error(err instanceof Error ? err : String(err), 'BYOK: Failed to update BYOK models context.');
			commands.executeCommand('setContext', hasByokModelsContextKey, false);
		}
	}

	private async _fetchKnownModelListWithTimeout(fetcherService: IFetcherService): Promise<Record<string, BYOKKnownModels>> {
		const CDN_FETCH_TIMEOUT_MS = 5000;
		return Promise.race([
			this.fetchKnownModelList(fetcherService),
			new Promise<Record<string, BYOKKnownModels>>(resolve => setTimeout(() => {
				this._logService.warn('BYOK: CDN fetch timed out. Registering providers with empty known models list.');
				resolve({});
			}, CDN_FETCH_TIMEOUT_MS))
		]);
	}

	private async fetchKnownModelList(fetcherService: IFetcherService): Promise<Record<string, BYOKKnownModels>> {
		try {
			const data = await (await fetcherService.fetch('https://main.vscode-cdn.net/extensions/copilotChat.json', { method: 'GET', callSite: 'byok-known-models' })).json();
			// Use this for testing with changes from a local file. Don't check in
			// const data = JSON.parse((await this._fileSystemService.readFile(URI.file('/Users/roblou/code/vscode-engineering/chat/copilotChat.json'))).toString());
			if (data.version !== 1) {
				this._logService.warn('BYOK: Copilot Chat known models list is not in the expected format. Defaulting to empty list.');
				return {};
			}
			this._logService.info('BYOK: Copilot Chat known models list fetched successfully.');
			return data.modelInfo;
		} catch (err) {
			this._logService.warn(`BYOK: Failed to fetch known models list. Defaulting to empty list. ${err}`);
			return {};
		}
	}
}
