/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, raceTimeout } from '../../base/common/async.js';
import { CancellationError } from '../../base/common/errors.js';
import { Event } from '../../base/common/event.js';
import { DisposableStore } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
import { localize } from '../../nls.js';
import { AgentHostConfigKey, type CodexUsageSource } from '../../platform/agentHost/common/agentHostCustomizationConfig.js';
import { AgentHostCodexAgentUsageSourceSettingId, CODEX_AGENT_PROVIDER_ID, IAgentHostService } from '../../platform/agentHost/common/agentService.js';
import { ActionType } from '../../platform/agentHost/common/state/protocol/actions.js';
import type { AgentGlobalConfigurationEdit, AgentGlobalConfigurationState, StartAgentAccountLoginResult } from '../../platform/agentHost/common/state/protocol/commands.js';
import type { AgentAccountState, AgentInfo } from '../../platform/agentHost/common/state/protocol/state.js';
import { ROOT_STATE_URI } from '../../platform/agentHost/common/state/sessionState.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { ConfigurationTarget, IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../platform/notification/common/notification.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { IProgressService, ProgressLocation } from '../../platform/progress/common/progress.js';
import { IWorkbenchEnvironmentService } from '../../workbench/services/environment/common/environmentService.js';
import { isAgentHostProvider, type IAgentHostSessionsProvider } from '../common/agentHostSessionsProvider.js';
import { activateOpenAIAccount } from '../common/codexAccountFlow.js';
import { ISessionsProvidersService } from '../services/sessions/browser/sessionsProvidersService.js';

export interface ICodexAccountTarget {
	readonly remoteAddress?: string;
	readonly onDidChangeAgentAccounts: Event<void>;
	getAgentInfo(provider: string): AgentInfo | undefined;
	setRootConfigValue(property: string, value: unknown): Promise<void>;
	readAgentAccount(provider: string): Promise<AgentAccountState>;
	startAgentAccountLogin(provider: string, method: 'browser' | 'deviceCode'): Promise<StartAgentAccountLoginResult>;
	cancelAgentAccountLogin(provider: string, loginId: string): Promise<void>;
	logoutAgentAccount(provider: string): Promise<void>;
	readAgentGlobalConfiguration(provider: string, keyPaths: readonly string[]): Promise<AgentGlobalConfigurationState>;
	writeAgentGlobalConfiguration(provider: string, edits: readonly AgentGlobalConfigurationEdit[], expectedVersion?: string): Promise<AgentGlobalConfigurationState>;
}

function getAgentHostCodexTarget(agentHostService: IAgentHostService): ICodexAccountTarget | undefined {
	const getAgentInfo = (provider: string) => {
		const rootState = agentHostService.rootState.value;
		return rootState && !(rootState instanceof Error) ? rootState.agents.find(agent => agent.provider === provider) : undefined;
	};
	if (!agentHostService.readAgentAccount
		|| !agentHostService.startAgentAccountLogin
		|| !agentHostService.cancelAgentAccountLogin
		|| !agentHostService.logoutAgentAccount
		|| !agentHostService.readAgentGlobalConfiguration
		|| !agentHostService.writeAgentGlobalConfiguration) {
		return undefined;
	}
	return {
		onDidChangeAgentAccounts: Event.map(agentHostService.rootState.onDidChange, () => undefined),
		getAgentInfo,
		setRootConfigValue: async (property, value) => agentHostService.dispatch(ROOT_STATE_URI, { type: ActionType.RootConfigChanged, config: { [property]: value } }),
		readAgentAccount: provider => agentHostService.readAgentAccount!(provider),
		startAgentAccountLogin: (provider, method) => agentHostService.startAgentAccountLogin!(provider, method),
		cancelAgentAccountLogin: (provider, loginId) => agentHostService.cancelAgentAccountLogin!(provider, loginId),
		logoutAgentAccount: provider => agentHostService.logoutAgentAccount!(provider),
		readAgentGlobalConfiguration: (provider, keyPaths) => agentHostService.readAgentGlobalConfiguration!(provider, keyPaths),
		writeAgentGlobalConfiguration: (provider, edits, expectedVersion) => agentHostService.writeAgentGlobalConfiguration!(provider, edits, expectedVersion),
	};
}

export class CodexAccountManager {
	constructor(
		@IAgentHostService private readonly agentHostService: IAgentHostService,
		@ISessionsProvidersService private readonly sessionsProvidersService: ISessionsProvidersService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IProgressService private readonly progressService: IProgressService,
	) { }

	getTarget(providerId?: string): ICodexAccountTarget | undefined {
		if (!this.environmentService.isSessionsWindow) {
			const target = getAgentHostCodexTarget(this.agentHostService);
			return target?.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.capabilities?.accountManagement !== undefined ? target : undefined;
		}
		if (providerId) {
			const provider = this.sessionsProvidersService.getProvider(providerId);
			if (provider && isAgentHostProvider(provider) && provider.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.capabilities?.accountManagement !== undefined) {
				return provider;
			}
		}
		return this.sessionsProvidersService.getProviders().find(provider => isAgentHostProvider(provider) && provider.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.capabilities?.accountManagement !== undefined) as IAgentHostSessionsProvider | undefined;
	}

	async useCopilot(target: ICodexAccountTarget): Promise<void> {
		await this.setUsageSource(target, 'copilot');
	}

	async useOpenAI(target: ICodexAccountTarget): Promise<void> {
		try {
			await activateOpenAIAccount(
				() => this.setUsageSource(target, 'openai'),
				() => target.readAgentAccount(CODEX_AGENT_PROVIDER_ID),
				() => this.signIn(target),
			);
		} catch (error) {
			if (target.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.account?.usageSource !== 'copilot') {
				await this.setUsageSource(target, 'copilot');
			}
			throw error;
		}
	}

	async signOut(target: ICodexAccountTarget): Promise<void> {
		const confirmation = await this.dialogService.confirm({
			type: 'warning',
			message: localize('codexAccount.logoutConfirm', "Sign out of OpenAI in Codex?"),
			detail: localize('codexAccount.logoutDetail', "This removes the credentials from the shared Codex home. Codex CLI and other integrations using the same CODEX_HOME will also be signed out."),
			primaryButton: localize('codexAccount.signOutButton', "Sign Out"),
		});
		if (confirmation.confirmed) {
			await target.logoutAgentAccount(CODEX_AGENT_PROVIDER_ID);
			await this.setUsageSource(target, 'copilot');
		}
	}

	private async setUsageSource(target: ICodexAccountTarget, source: CodexUsageSource): Promise<void> {
		if (target.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.account?.usageSource !== source) {
			await target.setRootConfigValue(AgentHostConfigKey.CodexUsageSource, source);
			const changed = Event.toPromise(Event.filter(target.onDidChangeAgentAccounts, () => target.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.account?.usageSource === source)).then(() => true);
			if (await raceTimeout(changed, 10_000) !== true) {
				throw new Error(localize('codexAccount.sourceTimeout', "Codex did not finish switching its usage source."));
			}
		}
		try {
			await this.configurationService.updateValue(AgentHostCodexAgentUsageSourceSettingId, source, ConfigurationTarget.USER);
		} catch {
			this.notificationService.warn(localize('codexAccount.sourceNotSaved', "Codex switched its usage source for this host, but the preference could not be saved in your user settings."));
		}
	}

	private async signIn(target: ICodexAccountTarget): Promise<void> {
		const method = target.remoteAddress ? 'deviceCode' : 'browser';
		const login = await target.startAgentAccountLogin(CODEX_AGENT_PROVIDER_ID, method);
		if (login.type === 'browser') {
			await this.openerService.open(URI.parse(login.authUrl), { openExternal: true });
		} else {
			await this.clipboardService.writeText(login.userCode);
			this.notificationService.prompt(
				Severity.Info,
				localize('codexAccount.deviceCode', "Enter code {0} to sign in to ChatGPT. The code has been copied.", login.userCode),
				[{
					label: localize('codexAccount.openSignIn', "Open Sign-In Page"),
					run: () => this.openerService.open(URI.parse(login.verificationUrl), { openExternal: true }),
				}, {
					label: localize('codexAccount.copyCode', "Copy Code"),
					run: () => this.clipboardService.writeText(login.userCode),
				}],
			);
			await this.openerService.open(URI.parse(login.verificationUrl), { openExternal: true });
		}

		const completion = new DeferredPromise<void>();
		const disposables = new DisposableStore();
		const updateCompletion = () => {
			const account = target.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.account;
			if (account?.status === 'signedIn') {
				void completion.complete();
			} else if (account?.status === 'error') {
				void completion.error(new Error(account.error ?? localize('codexAccount.loginFailed', "ChatGPT sign-in failed.")));
			}
		};
		disposables.add(target.onDidChangeAgentAccounts(updateCompletion));
		updateCompletion();
		await this.progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('codexAccount.waiting', "Waiting for ChatGPT sign-in"),
			cancellable: true,
		}, async () => completion.p.finally(() => disposables.dispose()), () => {
			void target.cancelAgentAccountLogin(CODEX_AGENT_PROVIDER_ID, login.loginId);
			void completion.error(new CancellationError());
		});
	}
}

export function codexPlanLabel(planType: string): string {
	switch (planType) {
		case 'free': return localize('codexAccount.plan.free', "Free");
		case 'go': return localize('codexAccount.plan.go', "Go");
		case 'plus': return localize('codexAccount.plan.plus', "Plus");
		case 'pro': return localize('codexAccount.plan.pro', "Pro");
		case 'prolite': return localize('codexAccount.plan.prolite', "Pro Lite");
		case 'team': return localize('codexAccount.plan.team', "Team");
		case 'business':
		case 'self_serve_business_usage_based': return localize('codexAccount.plan.business', "Business");
		case 'enterprise':
		case 'enterprise_cbp_usage_based': return localize('codexAccount.plan.enterprise', "Enterprise");
		case 'edu': return localize('codexAccount.plan.edu', "Education");
		default: return planType;
	}
}
