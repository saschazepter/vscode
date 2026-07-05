/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { ChatModelFamily } from '../../../../platform/endpoint/common/endpointProvider';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { Event } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { PromptCategorizerService } from '../promptCategorizer';
import { afterEach, beforeEach, suite, test } from 'vitest';

suite('PromptCategorizerService', () => {

	/**
	 * Mock endpoint provider that records the arguments passed to
	 * getChatEndpoint and can be configured to throw for the utility model,
	 * mimicking the BYOK-with-no-utility-model case.
	 */
	class RecordingEndpointProvider implements IEndpointProvider {
		declare readonly _serviceBrand: undefined;
		readonly onDidModelsRefresh = Event.None;

		readonly requests: unknown[] = [];
		throwForUtilityModel = false;

		private readonly _endpoint = { model: 'copilot-utility-small' } as IChatEndpoint;

		async getChatEndpoint(requestOrFamily: unknown): Promise<IChatEndpoint> {
			this.requests.push(requestOrFamily);
			if (this.throwForUtilityModel && requestOrFamily === 'copilot-utility-small') {
				throw new Error(`No utility model is configured for 'copilot-utility-small' while the selected main model is BYOK.`);
			}
			return this._endpoint;
		}

		async getEmbeddingsEndpoint(): Promise<never> {
			throw new Error('Not implemented');
		}

		async getAllChatEndpoints(): Promise<IChatEndpoint[]> {
			return [this._endpoint];
		}

		async getAllCompletionModels(): Promise<never[]> {
			return [];
		}
	}

	// Exposes the private resolution helper for focused testing.
	type TestableCategorizer = { _resolveCategorizationEndpoint(): Promise<IChatEndpoint | undefined> };

	let disposables: DisposableStore;
	let endpointProvider: RecordingEndpointProvider;
	let categorizer: PromptCategorizerService;

	beforeEach(() => {
		disposables = new DisposableStore();
		endpointProvider = new RecordingEndpointProvider();

		const serviceCollection = disposables.add(createExtensionUnitTestingServices());
		serviceCollection.define(IEndpointProvider, endpointProvider);
		const instantiationService = serviceCollection.createTestingAccessor().get(IInstantiationService);
		categorizer = instantiationService.createInstance(PromptCategorizerService);
	});

	afterEach(() => {
		disposables.dispose();
	});

	test('resolves the utility model when it is available', async () => {
		const endpoint = await (categorizer as unknown as TestableCategorizer)._resolveCategorizationEndpoint();

		assert.strictEqual(endpoint?.model, 'copilot-utility-small');
		assert.deepStrictEqual(endpointProvider.requests, ['copilot-utility-small' satisfies ChatModelFamily]);
	});

	test('skips categorization without falling back to the request model when the utility model is unavailable', async () => {
		endpointProvider.throwForUtilityModel = true;

		const endpoint = await (categorizer as unknown as TestableCategorizer)._resolveCategorizationEndpoint();

		assert.strictEqual(endpoint, undefined);
		// Only the utility model is requested; there must be no fallback to the request's main model.
		assert.deepStrictEqual(endpointProvider.requests, ['copilot-utility-small' satisfies ChatModelFamily]);
	});
});
