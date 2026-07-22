/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DeferredPromise, raceTimeout } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { CODEX_AGENT_PROVIDER_ID } from '../../../platform/agentHost/common/agentService.js';
import type { AgentGlobalConfigurationState } from '../../../platform/agentHost/common/state/protocol/commands.js';
import type { AgentAccountState, AgentInfo } from '../../../platform/agentHost/common/state/protocol/state.js';
import type { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import type { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import type { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import type { INotificationService } from '../../../platform/notification/common/notification.js';
import type { IOpenerService } from '../../../platform/opener/common/opener.js';
import type { IProgressService } from '../../../platform/progress/common/progress.js';
import type { IWorkbenchEnvironmentService } from '../../../workbench/services/environment/common/environmentService.js';
import { CodexAccountManager, type ICodexAccountTarget } from '../../browser/codexAccountManager.js';
import type { ISessionsProvidersService } from '../../services/sessions/browser/sessionsProvidersService.js';

suite('CodexAccountManager', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('waits for account login cancellation before completing the action', async () => {
		const onDidChangeAgentAccounts = store.add(new Emitter<void>());
		const cancel = new DeferredPromise<void>();
		let account: AgentAccountState = { usageSource: 'openai', status: 'signedOut' };
		let cancelStarted = false;
		const target: ICodexAccountTarget = {
			onDidChangeAgentAccounts: onDidChangeAgentAccounts.event,
			getAgentInfo: provider => provider === CODEX_AGENT_PROVIDER_ID ? { provider, account } as AgentInfo : undefined,
			setRootConfigValue: async () => undefined,
			readAgentAccount: async () => account,
			startAgentAccountLogin: async () => {
				account = { usageSource: 'openai', status: 'signingIn', loginId: 'login-1' };
				onDidChangeAgentAccounts.fire();
				return { type: 'browser', loginId: 'login-1', authUrl: 'https://example.com/login' };
			},
			cancelAgentAccountLogin: async () => {
				cancelStarted = true;
				await cancel.p;
				account = { usageSource: 'openai', status: 'signedOut' };
				onDidChangeAgentAccounts.fire();
			},
			logoutAgentAccount: async () => undefined,
			readAgentGlobalConfiguration: async () => ({ file: '', values: {} }) as AgentGlobalConfigurationState,
			writeAgentGlobalConfiguration: async () => ({ file: '', values: {} }) as AgentGlobalConfigurationState,
		};
		const progressService = {
			withProgress: async (_options: unknown, task: () => Promise<void>, onDidCancel: () => void) => {
				const result = task();
				onDidCancel();
				return result;
			},
		} as IProgressService;
		const manager = new CodexAccountManager(
			{} as never,
			{} as ISessionsProvidersService,
			{} as IWorkbenchEnvironmentService,
			{} as IConfigurationService,
			{} as INotificationService,
			{} as IDialogService,
			{ open: async () => true } as unknown as IOpenerService,
			{} as IClipboardService,
			progressService,
		);

		const signIn = (manager as unknown as { signIn(target: ICodexAccountTarget): Promise<void> }).signIn(target);
		const settledBeforeCancelFinished = await raceTimeout(signIn.then(() => true, () => true), 50) === true;

		assert.strictEqual(cancelStarted, true);
		cancel.complete();
		await assert.rejects(signIn);
		assert.strictEqual(settledBeforeCancelFinished, false, 'sign-in action completed before account cancellation finished');
		assert.strictEqual(account.status, 'signedOut');
	});
});
