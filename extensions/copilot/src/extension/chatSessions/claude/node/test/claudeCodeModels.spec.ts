/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { IEndpointProvider } from '../../../../../platform/endpoint/common/endpointProvider';
import { IChatEndpoint } from '../../../../../platform/networking/common/networking';
import { Emitter } from '../../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { ClaudeCodeModels } from '../claudeCodeModels';

/**
 * Creates a minimal mock IChatEndpoint with required properties for testing
 */
function createMockEndpoint(overrides: {
	model: string;
	name: string;
	family: string;
	showInModelPicker?: boolean;
	multiplier?: number;
	apiType?: string;
}): IChatEndpoint {
	// Default to Messages API for Claude models
	const isClaude = overrides.family?.toLowerCase().includes('claude') || overrides.model?.toLowerCase().includes('claude');
	return {
		model: overrides.model,
		name: overrides.name,
		family: overrides.family,
		version: '1.0',
		showInModelPicker: overrides.showInModelPicker ?? true,
		multiplier: overrides.multiplier,
		apiType: overrides.apiType ?? (isClaude ? 'messages' : 'chatCompletions'),
		// Required properties with sensible defaults
		maxOutputTokens: 4096,
		supportsToolCalls: true,
		supportsVision: false,
		supportsPrediction: false,
		isDefault: false,
		isFallback: false,
		policy: 'enabled',
		urlOrRequestMetadata: 'mock://endpoint',
		modelMaxPromptTokens: 128000,
		tokenizer: 'cl100k_base',
		acquireTokenizer: () => ({ encode: () => [], free: () => { } }) as any,
		processResponseFromChatEndpoint: () => Promise.resolve({} as any),
		acceptChatPolicy: () => Promise.resolve(true),
		fetchChatResponse: () => Promise.resolve({} as any),
	} as unknown as IChatEndpoint;
}

/**
 * Mock endpoint provider that supports firing onDidModelsRefresh and updating endpoints.
 */
class RefreshableMockEndpointProvider implements IEndpointProvider {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidModelsRefresh = new Emitter<void>();
	readonly onDidModelsRefresh = this._onDidModelsRefresh.event;
	private _endpoints: IChatEndpoint[];

	constructor(endpoints: IChatEndpoint[]) {
		this._endpoints = endpoints;
	}

	setEndpoints(endpoints: IChatEndpoint[]): void {
		this._endpoints = endpoints;
	}

	fireRefresh(): void {
		this._onDidModelsRefresh.fire();
	}

	async getAllChatEndpoints(): Promise<IChatEndpoint[]> {
		return this._endpoints;
	}

	getChatEndpoint(): Promise<IChatEndpoint> {
		throw new Error('Not implemented');
	}
	getEmbeddingsEndpoint(): Promise<any> {
		throw new Error('Not implemented');
	}
	getAllCompletionModels(): Promise<any[]> {
		throw new Error('Not implemented');
	}
}

describe('ClaudeCodeModels', () => {
	const store = new DisposableStore();

	afterEach(() => {
		store.clear();
	});

	describe('registerLanguageModelChatProvider', () => {
		function createServiceWithRefreshableEndpoints(
			endpoints: IChatEndpoint[],
		): { service: ClaudeCodeModels; provider: RefreshableMockEndpointProvider } {
			const endpointProvider = new RefreshableMockEndpointProvider(endpoints);
			const serviceCollection = store.add(createExtensionUnitTestingServices());
			serviceCollection.set(IEndpointProvider, endpointProvider);
			const instantiationService = serviceCollection.createTestingAccessor().get(IInstantiationService);
			const service = store.add(instantiationService.createInstance(ClaudeCodeModels));
			return { service, provider: endpointProvider };
		}

		function createMockLm(): { lm: typeof vscode['lm']; getCapturedProvider: () => vscode.LanguageModelChatProvider | undefined } {
			let capturedProvider: vscode.LanguageModelChatProvider | undefined;
			const lm = {
				registerLanguageModelChatProvider(_id: string, provider: vscode.LanguageModelChatProvider) {
					capturedProvider = provider;
					return { dispose: () => { } };
				},
			} as unknown as typeof vscode['lm'];
			return { lm, getCapturedProvider: () => capturedProvider };
		}

		async function getProviderInfo(service: ClaudeCodeModels, lm: typeof vscode['lm'], getCapturedProvider: () => vscode.LanguageModelChatProvider | undefined): Promise<vscode.LanguageModelChatInformation[]> {
			service.registerLanguageModelChatProvider(lm);
			const provider = getCapturedProvider()!;
			const info = await provider.provideLanguageModelChatInformation!({} as any, {} as any);
			return info ?? [];
		}

		it('registers provider and surfaces endpoints as LanguageModelChatInformation', async () => {
			const { service } = createServiceWithRefreshableEndpoints([
				createMockEndpoint({ model: 'claude-sonnet-4-model', name: 'Claude Sonnet 4', family: 'claude-sonnet-4', multiplier: 1 }),
				createMockEndpoint({ model: 'claude-opus-4.5-model', name: 'Claude Opus 4.5', family: 'claude-opus-4.5', multiplier: 5 }),
			]);
			const { lm, getCapturedProvider } = createMockLm();

			const info = await getProviderInfo(service, lm, getCapturedProvider);
			expect(info).toHaveLength(2);

			const sonnet = info.find(i => i.id === 'claude-sonnet-4-model')!;
			expect(sonnet.name).toBe('Claude Sonnet 4');
			expect(sonnet.family).toBe('claude-sonnet-4');
			expect(sonnet.multiplier).toBe('1x');
			expect(sonnet.targetChatSessionType).toBe('claude-code');
			expect(sonnet.isUserSelectable).toBe(true);

			const opus = info.find(i => i.id === 'claude-opus-4.5-model')!;
			expect(opus.multiplier).toBe('5x');
		});

		it('returns undefined multiplier string when endpoint has no multiplier', async () => {
			const { service } = createServiceWithRefreshableEndpoints([
				createMockEndpoint({ model: 'claude-sonnet-4-model', name: 'Claude Sonnet 4', family: 'claude-sonnet-4' }),
			]);
			const { lm, getCapturedProvider } = createMockLm();

			const info = await getProviderInfo(service, lm, getCapturedProvider);
			expect(info[0].multiplier).toBeUndefined();
		});

		it('returns empty array when no endpoints are available', async () => {
			const { service } = createServiceWithRefreshableEndpoints([]);
			const { lm, getCapturedProvider } = createMockLm();

			const info = await getProviderInfo(service, lm, getCapturedProvider);
			expect(info).toHaveLength(0);
		});

		it('maps endpoint properties to LanguageModelChatInformation fields', async () => {
			const endpoint = createMockEndpoint({ model: 'claude-sonnet-4-model', name: 'Claude Sonnet 4', family: 'claude-sonnet-4' });
			const { service } = createServiceWithRefreshableEndpoints([endpoint]);
			const { lm, getCapturedProvider } = createMockLm();

			const info = await getProviderInfo(service, lm, getCapturedProvider);
			expect(info[0].maxInputTokens).toBe(endpoint.modelMaxPromptTokens);
			expect(info[0].maxOutputTokens).toBe(endpoint.maxOutputTokens);
			expect(info[0].version).toBe(endpoint.version);
		});
	});

	describe('cache invalidation on onDidModelsRefresh', () => {
		it('returns updated models after refresh', async () => {
			const initialEndpoints = [
				createMockEndpoint({ model: 'claude-sonnet-4-model', name: 'Claude Sonnet 4', family: 'claude-sonnet-4' }),
			];
			const endpointProvider = new RefreshableMockEndpointProvider(initialEndpoints);
			const serviceCollection = store.add(createExtensionUnitTestingServices());
			serviceCollection.set(IEndpointProvider, endpointProvider);
			const instantiationService = serviceCollection.createTestingAccessor().get(IInstantiationService);
			const service = store.add(instantiationService.createInstance(ClaudeCodeModels));

			// Initial fetch
			const endpointsBefore = await service.getEndpoints();
			expect(endpointsBefore).toHaveLength(1);

			// Update endpoints and fire refresh
			endpointProvider.setEndpoints([
				createMockEndpoint({ model: 'claude-sonnet-4-model', name: 'Claude Sonnet 4', family: 'claude-sonnet-4' }),
				createMockEndpoint({ model: 'claude-opus-4.5-model', name: 'Claude Opus 4.5', family: 'claude-opus-4.5' }),
			]);
			endpointProvider.fireRefresh();

			// After refresh, stale cache should be cleared
			const endpointsAfter = await service.getEndpoints();
			expect(endpointsAfter).toHaveLength(2);
		});

		it('returns cached models when no refresh has occurred', async () => {
			let fetchCount = 0;
			const endpointProvider = new RefreshableMockEndpointProvider([
				createMockEndpoint({ model: 'claude-sonnet-4-model', name: 'Claude Sonnet 4', family: 'claude-sonnet-4' }),
			]);
			const originalGetAll = endpointProvider.getAllChatEndpoints.bind(endpointProvider);
			endpointProvider.getAllChatEndpoints = async () => {
				fetchCount++;
				return originalGetAll();
			};

			const serviceCollection = store.add(createExtensionUnitTestingServices());
			serviceCollection.set(IEndpointProvider, endpointProvider);
			const instantiationService = serviceCollection.createTestingAccessor().get(IInstantiationService);
			const service = store.add(instantiationService.createInstance(ClaudeCodeModels));

			await service.getEndpoints();
			await service.getEndpoints();

			// Should only have fetched once due to caching
			expect(fetchCount).toBe(1);
		});
	});
});
