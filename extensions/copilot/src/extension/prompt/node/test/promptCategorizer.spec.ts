/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as vscode from 'vscode';
import { type ChatModelFamily, IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { IExperimentationService, NullExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { Event } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { PromptCategorizerService } from '../promptCategorizer';
import { afterEach, beforeEach, suite, test } from 'vitest';

suite('PromptCategorizerService', () => {

	/**
	 * Mock endpoint provider that records the family argument passed to
	 * getChatEndpoint. Always throws after recording so the async chain
	 * terminates early without needing a full endpoint mock.
	 */
	class RecordingEndpointProvider implements IEndpointProvider {
		declare readonly _serviceBrand: undefined;
		readonly onDidModelsRefresh = Event.None;

		readonly requests: unknown[] = [];

		async getChatEndpoint(requestOrFamily: unknown): Promise<IChatEndpoint> {
			this.requests.push(requestOrFamily);
			throw new Error('RecordingEndpointProvider: no real endpoint');
		}

		async getEmbeddingsEndpoint(): Promise<never> {
			throw new Error('Not implemented');
		}

		async getAllChatEndpoints(): Promise<IChatEndpoint[]> {
			return [];
		}

		async getAllCompletionModels(): Promise<never[]> {
			return [];
		}
	}

	let disposables: DisposableStore;
	let endpointProvider: RecordingEndpointProvider;
	let categorizer: PromptCategorizerService;

	beforeEach(() => {
		disposables = new DisposableStore();
		endpointProvider = new RecordingEndpointProvider();

		const serviceCollection = disposables.add(createExtensionUnitTestingServices());
		serviceCollection.define(IEndpointProvider, endpointProvider);
		// Enable the categorization experiment so the service proceeds past the feature flag guard.
		serviceCollection.define(IExperimentationService, new class extends NullExperimentationService {
			override getTreatmentVariable<T extends boolean | number | string>(name: string): T | undefined {
				if (name === 'copilotchat.promptCategorization') { return true as T; }
				return undefined;
			}
		});
		const instantiationService = serviceCollection.createTestingAccessor().get(IInstantiationService);
		categorizer = instantiationService.createInstance(PromptCategorizerService);
	});

	afterEach(() => {
		disposables.dispose();
	});

	test('resolves copilot-utility-small when categorization fires', () => {
		// Build a minimal request that passes all guard conditions in categorizePrompt.
		const request = {
			attempt: 0,
			location2: undefined,
			subAgentName: undefined,
			prompt: 'hello world',
		} as unknown as vscode.ChatRequest;
		const context = { history: [] } as unknown as vscode.ChatContext;

		categorizer.categorizePrompt(request, context, 'test-telemetry-id');

		// getChatEndpoint runs synchronously inside the async helper before
		// the first actual await point, so the recorded requests are visible
		// immediately after the synchronous call above.
		assert.deepStrictEqual(endpointProvider.requests, ['copilot-utility-small' satisfies ChatModelFamily]);
	});
});
