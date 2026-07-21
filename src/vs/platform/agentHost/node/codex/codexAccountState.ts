/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentAccountState } from '../../common/state/protocol/channels-root/state.js';
import type { CodexUsageSource } from '../../common/agentHostCustomizationConfig.js';
import type { GetAccountResponse } from './protocol/generated/v2/GetAccountResponse.js';

export function codexAccountStateFromResponse(response: GetAccountResponse): AgentAccountState {
	if (response.account?.type === 'chatgpt') {
		return { usageSource: 'openai', status: 'signedIn', authType: 'chatgpt', planType: response.account.planType };
	}
	if (response.account?.type === 'apiKey') {
		return { usageSource: 'openai', status: 'signedIn', authType: 'apiKey' };
	}
	if (response.account) {
		return { usageSource: 'openai', status: 'signedIn', authType: 'other' };
	}
	return { usageSource: 'openai', status: 'signedOut' };
}

export function resolveCodexUsageSourceAfterAccountRead(source: CodexUsageSource, account: AgentAccountState): CodexUsageSource {
	return source === 'openai' && account.status === 'signedOut' ? 'copilot' : source;
}

export function codexAccountStateForUsageSource(source: CodexUsageSource, openAIAccount: AgentAccountState): AgentAccountState {
	return source === 'openai' ? openAIAccount : { ...openAIAccount, usageSource: 'copilot' };
}
