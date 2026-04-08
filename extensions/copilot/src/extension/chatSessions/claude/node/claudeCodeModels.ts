/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../../platform/log/common/logService';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { createServiceIdentifier } from '../../../../util/common/services';
import { Emitter } from '../../../../util/vs/base/common/event';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';

export interface IClaudeCodeModels {
	readonly _serviceBrand: undefined;
	/**
	 * Gets the filtered list of Claude chat endpoints that support the Messages API.
	 */
	getEndpoints(): Promise<IChatEndpoint[]>;
	/**
	 * Registers a LanguageModelChatProvider so that Claude models appear in
	 * VS Code's built-in model picker for the claude-code session type.
	 */
	registerLanguageModelChatProvider(lm: typeof vscode['lm']): void;
}

export const IClaudeCodeModels = createServiceIdentifier<IClaudeCodeModels>('IClaudeCodeModels');

export class ClaudeCodeModels extends Disposable implements IClaudeCodeModels {
	declare _serviceBrand: undefined;
	private _cachedEndpoints: Promise<IChatEndpoint[]> | undefined;
	private readonly _onDidChange = this._register(new Emitter<void>());

	constructor(
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.endpointProvider.onDidModelsRefresh(() => {
			this._cachedEndpoints = undefined;
			this._onDidChange.fire();
		}));
	}

	public registerLanguageModelChatProvider(lm: typeof vscode['lm']): void {
		const provider: vscode.LanguageModelChatProvider = {
			onDidChangeLanguageModelChatInformation: this._onDidChange.event,
			provideLanguageModelChatInformation: async (_options, _token) => {
				return this._provideLanguageModelChatInfo();
			},
			provideLanguageModelChatResponse: async (_model, _messages, _options, _progress, _token) => {
				// Implemented via chat participants.
			},
			provideTokenCount: async (_model, _text, _token) => {
				// Token counting is not currently supported for the claude provider.
				return 0;
			}
		};
		this._register(lm.registerLanguageModelChatProvider('claude-code', provider));

		void this._getEndpoints().then(() => this._onDidChange.fire());
	}

	private _getEndpoints(): Promise<IChatEndpoint[]> {
		if (!this._cachedEndpoints) {
			this._cachedEndpoints = this._fetchAvailableEndpoints();
		}
		return this._cachedEndpoints;
	}

	private async _provideLanguageModelChatInfo(): Promise<vscode.LanguageModelChatInformation[]> {
		const endpoints = await this._getEndpoints();
		return endpoints.map(endpoint => {
			const multiplier = endpoint.multiplier === undefined ? undefined : `${endpoint.multiplier}x`;
			return {
				id: endpoint.model,
				name: endpoint.name,
				family: endpoint.family,
				version: endpoint.version,
				maxInputTokens: endpoint.modelMaxPromptTokens,
				maxOutputTokens: endpoint.maxOutputTokens,
				multiplier,
				multiplierNumeric: endpoint.multiplier,
				isUserSelectable: true,
				capabilities: {
					imageInput: endpoint.supportsVision,
					toolCalling: endpoint.supportsToolCalls,
					editTools: endpoint.supportedEditTools ? [...endpoint.supportedEditTools] : undefined,
				},
				targetChatSessionType: 'claude-code'
			};
		});
	}

	public async getEndpoints(): Promise<IChatEndpoint[]> {
		return this._getEndpoints();
	}

	private async _fetchAvailableEndpoints(): Promise<IChatEndpoint[]> {
		try {
			const endpoints = await this.endpointProvider.getAllChatEndpoints();

			// Filter for Claude/Anthropic models that are available in the model picker
			// and use the Messages API (required for Claude Code)
			const claudeEndpoints = endpoints.filter(e =>
				e.supportsToolCalls &&
				e.showInModelPicker &&
				(e.family?.toLowerCase().includes('claude') || e.model?.toLowerCase().includes('claude')) &&
				e.apiType === 'messages'
			);

			if (claudeEndpoints.length === 0) {
				this.logService.trace('[ClaudeCodeModels] No Claude models with Messages API found');
				return [];
			}

			return claudeEndpoints.sort((a, b) => b.name.localeCompare(a.name));
		} catch (ex) {
			this.logService.error(`[ClaudeCodeModels] Failed to fetch models`, ex);
			return [];
		}
	}
}
