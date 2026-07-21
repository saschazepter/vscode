/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentAccountState } from '../../platform/agentHost/common/state/protocol/state.js';

export async function activateOpenAIAccount(
	setUsageSource: () => Promise<void>,
	readAccount: () => Promise<AgentAccountState>,
	signIn: () => Promise<void>,
): Promise<void> {
	await setUsageSource();
	const account = await readAccount();
	if (account.status === 'signedIn' || account.status === 'signingIn') {
		return;
	}
	if (account.status === 'error') {
		throw new Error(account.error ?? 'Unable to read the OpenAI account.');
	}
	await signIn();
}
