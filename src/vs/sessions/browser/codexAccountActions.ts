/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../base/browser/dom.js';
import { BaseActionViewItem, type IActionViewItemOptions } from '../../base/browser/ui/actionbar/actionViewItems.js';
import { renderIcon } from '../../base/browser/ui/iconLabel/iconLabels.js';
import type { IAction } from '../../base/common/actions.js';
import { DeferredPromise, raceTimeout } from '../../base/common/async.js';
import { Codicon } from '../../base/common/codicons.js';
import { Event } from '../../base/common/event.js';
import { CancellationError } from '../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { autorun, type IObservable } from '../../base/common/observable.js';
import { URI } from '../../base/common/uri.js';
import { localize, localize2 } from '../../nls.js';
import { ActionListItemKind, type IActionListDelegate, type IActionListItem } from '../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../platform/actionWidget/browser/actionWidget.js';
import { IActionViewItemService } from '../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../platform/actions/common/actions.js';
import { IClipboardService } from '../../platform/clipboard/common/clipboardService.js';
import { AgentHostConfigKey, type CodexUsageSource } from '../../platform/agentHost/common/agentHostCustomizationConfig.js';
import { AgentHostCodexAgentUsageSourceSettingId, CODEX_AGENT_PROVIDER_ID, IAgentHostService } from '../../platform/agentHost/common/agentService.js';
import { ActionType } from '../../platform/agentHost/common/state/protocol/actions.js';
import type { StartAgentAccountLoginResult } from '../../platform/agentHost/common/state/protocol/commands.js';
import type { AgentAccountState, AgentInfo } from '../../platform/agentHost/common/state/protocol/state.js';
import { ROOT_STATE_URI } from '../../platform/agentHost/common/state/sessionState.js';
import { IConfigurationService, ConfigurationTarget } from '../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../platform/notification/common/notification.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { IProgressService, ProgressLocation } from '../../platform/progress/common/progress.js';
import { IQuickInputService, type IQuickPickItem } from '../../platform/quickinput/common/quickInput.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../workbench/common/contributions.js';
import { IsSessionsWindowContext } from '../../workbench/common/contextkeys.js';
import { IWorkbenchEnvironmentService } from '../../workbench/services/environment/common/environmentService.js';
import { Menus } from './menus.js';
import { isAgentHostProvider, type IAgentHostSessionsProvider } from '../common/agentHostSessionsProvider.js';
import { SessionTypeContext } from '../common/contextkeys.js';
import type { IActiveSession } from '../services/sessions/common/sessionsManagement.js';
import { ISessionContext } from '../services/sessions/browser/sessionContext.js';
import { ISessionsProvidersService } from '../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../services/sessions/browser/sessionsService.js';

const MANAGE_CODEX_ACCOUNT_COMMAND_ID = 'sessions.agentHost.manageCodexAccount';

interface ICodexAccountActionContext {
	readonly providerId?: string;
}

interface ICodexAccountPick extends IQuickPickItem {
	readonly action: 'current' | 'copilot' | 'openai' | 'signIn' | 'logout';
}

interface ICodexAccountPickerAction {
	readonly action: 'copilot' | 'openai' | 'signIn' | 'logout';
	readonly checked: boolean;
}

interface ICodexAccountTarget {
	readonly remoteAddress?: string;
	readonly onDidChangeAgentAccounts: Event<void>;
	getAgentInfo(provider: string): AgentInfo | undefined;
	setRootConfigValue(property: string, value: unknown): Promise<void>;
	readAgentAccount(provider: string): Promise<AgentAccountState>;
	startAgentAccountLogin(provider: string, method: 'browser' | 'deviceCode'): Promise<StartAgentAccountLoginResult>;
	cancelAgentAccountLogin(provider: string, loginId: string): Promise<void>;
	logoutAgentAccount(provider: string): Promise<void>;
}

function getAgentHostCodexTarget(agentHostService: IAgentHostService): ICodexAccountTarget | undefined {
	const getAgentInfo = (provider: string) => {
		const rootState = agentHostService.rootState.value;
		return rootState && !(rootState instanceof Error) ? rootState.agents.find(agent => agent.provider === provider) : undefined;
	};
	if (!agentHostService.readAgentAccount
		|| !agentHostService.startAgentAccountLogin
		|| !agentHostService.cancelAgentAccountLogin
		|| !agentHostService.logoutAgentAccount) {
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
	};
}

function getCodexProvider(accessor: ServicesAccessor, providerId?: string): ICodexAccountTarget | undefined {
	if (!accessor.get(IWorkbenchEnvironmentService).isSessionsWindow) {
		const target = getAgentHostCodexTarget(accessor.get(IAgentHostService));
		return target?.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.capabilities?.accountManagement !== undefined ? target : undefined;
	}
	const providersService = accessor.get(ISessionsProvidersService);
	if (providerId) {
		const provider = providersService.getProvider(providerId);
		if (provider && isAgentHostProvider(provider) && provider.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.capabilities?.accountManagement !== undefined) {
			return provider;
		}
	}
	const active = accessor.get(ISessionsService).activeSession.get();
	if (active?.sessionType === CODEX_AGENT_PROVIDER_ID) {
		const provider = providersService.getProvider(active.providerId);
		if (provider && isAgentHostProvider(provider) && provider.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.capabilities?.accountManagement !== undefined) {
			return provider;
		}
	}
	return providersService.getProviders().find(provider => isAgentHostProvider(provider) && provider.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.capabilities?.accountManagement !== undefined) as IAgentHostSessionsProvider | undefined;
}

function currentAccountLabel(provider: ICodexAccountTarget, source: CodexUsageSource): string {
	if (source === 'copilot') {
		return localize('codexAccount.currentCopilot', "Using GitHub Copilot");
	}
	const account = provider.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.account;
	if (account?.status === 'signingIn') {
		return localize('codexAccount.currentSigningIn', "Signing in to ChatGPT…");
	}
	if (account?.authType === 'chatgpt') {
		return account.planType && account.planType !== 'unknown'
			? localize('codexAccount.currentChatgptPlan', "Using ChatGPT · {0}", planLabel(account.planType))
			: localize('codexAccount.currentChatgpt', "Using ChatGPT");
	}
	if (account?.authType === 'apiKey') {
		return localize('codexAccount.currentApiKey', "Using OpenAI API key");
	}
	return localize('codexAccount.currentOpenAISignedOut', "OpenAI account · Not signed in");
}

function accountChipLabel(provider: ICodexAccountTarget | undefined, fallback: string): string {
	const account = provider?.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.account;
	if (!account) {
		return fallback;
	}
	if (account.usageSource === 'copilot' || account.status === 'signedOut') {
		return localize('codexAccount.chipCopilot', "Copilot account");
	}
	return localize('codexAccount.chipOpenAI', "OpenAI account");
}

class CodexAccountActionViewItem extends BaseActionViewItem {
	private readonly _providerListener = this._register(new MutableDisposable<IDisposable>());
	private _provider: ICodexAccountTarget | undefined;
	private _iconElement: HTMLElement | undefined;
	private _labelElement: HTMLElement | undefined;

	constructor(
		action: IAction,
		options: IActionViewItemOptions | undefined,
		private readonly _session: IObservable<IActiveSession | undefined> | undefined,
		@ISessionsProvidersService private readonly _providersService: ISessionsProvidersService,
		@IAgentHostService agentHostService: IAgentHostService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IActionWidgetService private readonly _actionWidgetService: IActionWidgetService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IProgressService private readonly _progressService: IProgressService,
	) {
		super(undefined, action, options);
		if (environmentService.isSessionsWindow && this._session) {
			this._register(autorun(reader => {
				const session = this._session!.read(reader);
				const candidate = session ? this._providersService.getProvider(session.providerId) : undefined;
				const provider = candidate && isAgentHostProvider(candidate) ? candidate : undefined;
				this._setProvider(provider);
			}));
		} else {
			this._setProvider(getAgentHostCodexTarget(agentHostService));
		}
	}

	override render(container: HTMLElement): void {
		this.element = container;
		container.classList.add('sessions-chat-picker-slot', 'codex-account-picker');
		const trigger = dom.append(container, dom.$('a.action-label'));
		trigger.role = 'button';
		trigger.tabIndex = 0;
		trigger.setAttribute('aria-haspopup', 'listbox');
		this._iconElement = renderIcon(Codicon.openai);
		trigger.appendChild(this._iconElement);
		this._labelElement = dom.append(trigger, dom.$('span.chat-session-option-label'));
		this._register(dom.addDisposableListener(trigger, dom.EventType.CLICK, event => {
			dom.EventHelper.stop(event, true);
			this._showPicker(trigger);
		}));
		this._register(dom.addDisposableListener(trigger, dom.EventType.KEY_DOWN, event => {
			if (event.key === 'Enter' || event.key === ' ') {
				dom.EventHelper.stop(event, true);
				this._showPicker(trigger);
			}
		}));
		this._updateLabel();
	}

	private _setProvider(provider: ICodexAccountTarget | undefined): void {
		if (provider !== this._provider) {
			this._provider = provider;
			this._providerListener.value = provider?.onDidChangeAgentAccounts(() => this._updateLabel());
		}
		this._updateLabel();
	}

	private _showPicker(trigger: HTMLElement): void {
		const provider = this._provider;
		if (!provider || this._actionWidgetService.isVisible) {
			return;
		}

		const account = provider.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.account;
		const source = account?.usageSource === 'openai' && account.status !== 'signedOut' ? 'openai' : 'copilot';
		const openAIAction: IActionListItem<ICodexAccountPickerAction> = account?.status === 'signedIn'
			? {
				kind: ActionListItemKind.Action,
				label: localize('codexAccount.openAIAccount', "OpenAI account"),
				detail: openAIAccountDetail(account),
				group: { title: '', icon: Codicon.openai },
				item: { action: 'openai', checked: source === 'openai' },
			}
			: {
				kind: ActionListItemKind.Action,
				label: account?.status === 'signingIn'
					? localize('codexAccount.signingInToOpenAI', "Signing in to OpenAI…")
					: localize('codexAccount.signInToOpenAI', "Sign in to OpenAI"),
				detail: openAIAccountDetail(account),
				group: { title: '', icon: Codicon.openai },
				disabled: account?.status === 'signingIn',
				item: { action: 'signIn', checked: false },
			};
		const actionItems: IActionListItem<ICodexAccountPickerAction>[] = [openAIAction, {
			kind: ActionListItemKind.Action,
			label: localize('codexAccount.copilotAccount', "Copilot account"),
			detail: localize('codexAccount.copilotAccountDetail', "Uses quota from your GitHub Copilot subscription."),
			group: { title: '', icon: Codicon.copilot },
			item: { action: 'copilot', checked: source === 'copilot' },
		}];
		if (account?.status === 'signedIn') {
			actionItems.push({ kind: ActionListItemKind.Separator });
			actionItems.push({
				kind: ActionListItemKind.Action,
				label: localize('codexAccount.signOut', "Sign out of OpenAI"),
				group: { title: '', icon: Codicon.signOut },
				item: { action: 'logout', checked: false },
			});
		}

		const delegate: IActionListDelegate<ICodexAccountPickerAction> = {
			onSelect: item => {
				this._actionWidgetService.hide();
				void this._runPickerAction(provider, item.action);
			},
			onHide: () => trigger.focus(),
		};
		this._actionWidgetService.show(
			'codexAccount',
			false,
			actionItems,
			delegate,
			trigger,
			undefined,
			[],
			{
				getAriaLabel: item => item.label ?? '',
				getWidgetAriaLabel: () => localize('codexAccount.pickerAriaLabel', "Codex account picker"),
			},
			{ minWidth: 320 },
		);
	}

	private async _runPickerAction(provider: ICodexAccountTarget, action: ICodexAccountPickerAction['action']): Promise<void> {
		try {
			if (action === 'logout') {
				await confirmLogoutAndUseCopilot(this._configurationService, this._notificationService, this._dialogService, provider);
				return;
			}
			if (action === 'signIn') {
				try {
					await signIn({
						openerService: this._openerService,
						clipboardService: this._clipboardService,
						notificationService: this._notificationService,
						progressService: this._progressService,
					}, provider);
					await setUsageSource(this._configurationService, this._notificationService, provider, 'openai');
				} catch (error) {
					if (provider.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.account?.usageSource !== 'copilot') {
						await setUsageSource(this._configurationService, this._notificationService, provider, 'copilot');
					}
					throw error;
				}
				return;
			}
			if (action === 'openai') {
				const currentAccount = await provider.readAgentAccount(CODEX_AGENT_PROVIDER_ID);
				if (currentAccount.status !== 'signedIn') {
					await signIn({
						openerService: this._openerService,
						clipboardService: this._clipboardService,
						notificationService: this._notificationService,
						progressService: this._progressService,
					}, provider);
				}
			}
			if (provider.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.account?.usageSource !== action) {
				await setUsageSource(this._configurationService, this._notificationService, provider, action);
			}
		} catch (error) {
			this._notificationService.error(error);
		}
	}

	private _updateLabel(): void {
		const label = accountChipLabel(this._provider, this._action.label);
		if (this._iconElement) {
			const account = this._provider?.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.account;
			const source = account?.usageSource === 'openai' && account.status !== 'signedOut'
				? 'openai'
				: 'copilot';
			const iconElement = renderIcon(source === 'openai' ? Codicon.openai : Codicon.copilot);
			this._iconElement.replaceWith(iconElement);
			this._iconElement = iconElement;
		}
		if (this._labelElement) {
			this._labelElement.textContent = label;
			this._labelElement.parentElement?.setAttribute('aria-label', label);
		}
	}
}

function planLabel(planType: string): string {
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

function openAIAccountDetail(account: AgentAccountState | undefined): string {
	if (account?.status === 'signingIn') {
		return localize('codexAccount.openAIAccountSigningIn', "Signing in with ChatGPT…");
	}
	if (account?.authType === 'apiKey') {
		return localize('codexAccount.openAIAccountApiKeyDetail', "Usage is billed to your OpenAI API account.");
	}
	if (account?.status === 'signedOut') {
		return localize('codexAccount.openAIAccountSignedOutDetail', "Sign in with ChatGPT to use quota from your OpenAI subscription.");
	}
	return localize('codexAccount.openAIAccountDetail', "Uses quota from your OpenAI subscription.");
}

async function setUsageSource(configurationService: IConfigurationService, notificationService: INotificationService, provider: ICodexAccountTarget, source: CodexUsageSource): Promise<void> {
	await provider.setRootConfigValue(AgentHostConfigKey.CodexUsageSource, source);
	if (provider.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.account?.usageSource !== source) {
		const changed = Event.toPromise(Event.filter(provider.onDidChangeAgentAccounts, () => provider.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.account?.usageSource === source)).then(() => true);
		if (await raceTimeout(changed, 10_000) !== true) {
			throw new Error(localize('codexAccount.sourceTimeout', "Codex did not finish switching its usage source."));
		}
	}
	try {
		await configurationService.updateValue(AgentHostCodexAgentUsageSourceSettingId, source, ConfigurationTarget.USER);
	} catch {
		notificationService.warn(localize('codexAccount.sourceNotSaved', "Codex switched its usage source for this session, but the preference could not be saved in your user settings."));
	}
}

interface ISignInServices {
	readonly openerService: IOpenerService;
	readonly clipboardService: IClipboardService;
	readonly notificationService: INotificationService;
	readonly progressService: IProgressService;
}

async function signIn(services: ISignInServices, provider: ICodexAccountTarget): Promise<void> {
	const method = provider.remoteAddress ? 'deviceCode' : 'browser';
	const login = await provider.startAgentAccountLogin(CODEX_AGENT_PROVIDER_ID, method);
	if (login.type === 'browser') {
		await services.openerService.open(URI.parse(login.authUrl), { openExternal: true });
	} else {
		await services.clipboardService.writeText(login.userCode);
		services.notificationService.prompt(
			Severity.Info,
			localize('codexAccount.deviceCode', "Enter code {0} to sign in to ChatGPT. The code has been copied.", login.userCode),
			[{
				label: localize('codexAccount.openSignIn', "Open Sign-In Page"),
				run: () => services.openerService.open(URI.parse(login.verificationUrl), { openExternal: true }),
			}, {
				label: localize('codexAccount.copyCode', "Copy Code"),
				run: () => services.clipboardService.writeText(login.userCode),
			}],
		);
		await services.openerService.open(URI.parse(login.verificationUrl), { openExternal: true });
	}

	const completion = new DeferredPromise<void>();
	const disposables = new DisposableStore();
	const updateCompletion = () => {
		const account = provider.getAgentInfo(CODEX_AGENT_PROVIDER_ID)?.account;
		if (account?.status === 'signedIn') {
			void completion.complete();
		} else if (account?.status === 'error') {
			void completion.error(new Error(account.error ?? localize('codexAccount.loginFailed', "ChatGPT sign-in failed.")));
		}
	};
	disposables.add(provider.onDidChangeAgentAccounts(updateCompletion));
	updateCompletion();
	await services.progressService.withProgress({
		location: ProgressLocation.Notification,
		title: localize('codexAccount.waiting', "Waiting for ChatGPT sign-in"),
		cancellable: true,
	}, async () => completion.p.finally(() => disposables.dispose()), () => {
		void provider.cancelAgentAccountLogin(CODEX_AGENT_PROVIDER_ID, login.loginId);
		void completion.error(new CancellationError());
	});
}

async function confirmLogoutAndUseCopilot(configurationService: IConfigurationService, notificationService: INotificationService, dialogService: IDialogService, provider: ICodexAccountTarget): Promise<void> {
	const confirmation = await dialogService.confirm({
		type: 'warning',
		message: localize('codexAccount.logoutConfirm', "Sign out of OpenAI in Codex?"),
		detail: localize('codexAccount.logoutDetail', "This removes the credentials from the shared Codex home. Codex CLI and other integrations using the same CODEX_HOME will also be signed out."),
		primaryButton: localize('codexAccount.signOutButton', "Sign Out"),
	});
	if (confirmation.confirmed) {
		await provider.logoutAgentAccount(CODEX_AGENT_PROVIDER_ID);
		await setUsageSource(configurationService, notificationService, provider, 'copilot');
	}
}

async function manageCodexAccount(accessor: ServicesAccessor, providerId?: string): Promise<void> {
	const provider = getCodexProvider(accessor, providerId);
	const notificationService = accessor.get(INotificationService);
	const configurationService = accessor.get(IConfigurationService);
	const quickInputService = accessor.get(IQuickInputService);
	const dialogService = accessor.get(IDialogService);
	const signInServices: ISignInServices = {
		openerService: accessor.get(IOpenerService),
		clipboardService: accessor.get(IClipboardService),
		notificationService,
		progressService: accessor.get(IProgressService),
	};
	if (!provider) {
		notificationService.warn(localize('codexAccount.noHost', "No connected agent host with Codex is available."));
		return;
	}
	const info = provider.getAgentInfo(CODEX_AGENT_PROVIDER_ID);
	const source = info?.account?.usageSource === 'openai' ? 'openai' : 'copilot';
	const picks: ICodexAccountPick[] = [{
		action: 'current',
		label: currentAccountLabel(provider, source),
		pickable: false,
	}];
	if (info?.account?.status === 'signedIn') {
		if (source === 'copilot') {
			picks.push({
				action: 'openai',
				label: localize('codexAccount.useOpenAI', "Use OpenAI account"),
				description: localize('codexAccount.useChatgptSubscription', "Use your ChatGPT subscription or OpenAI API key"),
			});
		}
	} else {
		picks.push({ action: 'signIn', label: localize('codexAccount.signInToOpenAI', "Sign in to OpenAI"), description: localize('codexAccount.subscription', "Use quota from your OpenAI subscription") });
	}
	if (source === 'openai') {
		picks.push({
			action: 'copilot',
			label: localize('codexAccount.useCopilot', "Use GitHub Copilot"),
			description: localize('codexAccount.useCopilotSubscription', "Use your Copilot subscription"),
		});
	}
	if (info?.account?.status === 'signedIn') {
		picks.push({ action: 'logout', label: localize('codexAccount.signOut', "Sign out of OpenAI") });
	}

	const picked = await quickInputService.pick(picks, {
		title: localize('codexAccount.title', "Codex Usage and Account"),
		placeHolder: localize('codexAccount.placeholder', "Choose which subscription Codex uses"),
	});
	if (!picked) {
		return;
	}
	if (picked.action === 'current') {
		return;
	}
	if (picked.action === 'copilot' || picked.action === 'openai') {
		await setUsageSource(configurationService, notificationService, provider, picked.action);
		if (picked.action === 'openai') {
			const account = await provider.readAgentAccount(CODEX_AGENT_PROVIDER_ID);
			if (account.status === 'signedOut') {
				await signIn(signInServices, provider);
			}
		}
		return;
	}
	if (picked.action === 'signIn') {
		await signIn(signInServices, provider);
		await setUsageSource(configurationService, notificationService, provider, 'openai');
		return;
	}
	await confirmLogoutAndUseCopilot(configurationService, notificationService, dialogService, provider);
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: MANAGE_CODEX_ACCOUNT_COMMAND_ID, title: localize2('manageCodexAccount', "Codex: Manage Usage and Account"), f1: true });
	}
	override run(accessor: ServicesAccessor, context?: ICodexAccountActionContext): Promise<void> {
		return manageCodexAccount(accessor, context?.providerId);
	}
});

for (const source of ['copilot', 'openai'] as const) {
	registerAction2(class extends Action2 {
		constructor() {
			const title = source === 'openai'
				? localize2('codexUsageOpenAI', "OpenAI account")
				: localize2('codexUsageCopilot', "Copilot account");
			const sourceMatches = ContextKeyExpr.equals(`config.${AgentHostCodexAgentUsageSourceSettingId}`, source);
			const isCodexSession = ContextKeyExpr.equals(SessionTypeContext.key, CODEX_AGENT_PROVIDER_ID);
			const isCodexWorkbenchChat = ContextKeyExpr.equals('chatAgentHostProviderId', CODEX_AGENT_PROVIDER_ID);
			super({
				id: `${MANAGE_CODEX_ACCOUNT_COMMAND_ID}.${source}`,
				title,
				f1: false,
				menu: [{
					id: Menus.NewSessionControl,
					group: 'navigation',
					order: 4,
					when: ContextKeyExpr.and(isCodexSession, sourceMatches),
				}, {
					id: MenuId.ChatInputSecondary,
					group: 'navigation',
					order: 13,
					when: ContextKeyExpr.and(isCodexSession, sourceMatches),
				}, {
					id: MenuId.ChatInputSecondary,
					group: 'navigation',
					order: 1.05,
					when: ContextKeyExpr.and(isCodexWorkbenchChat, IsSessionsWindowContext.negate(), sourceMatches),
				}],
			});
		}
		override run(accessor: ServicesAccessor): Promise<void> {
			return manageCodexAccount(accessor);
		}
	});
}

class CodexAccountActionViewItemContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.contrib.codexAccountActionViewItem';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
	) {
		super();
		for (const source of ['copilot', 'openai'] as const) {
			const actionId = `${MANAGE_CODEX_ACCOUNT_COMMAND_ID}.${source}`;
			for (const menu of [Menus.NewSessionControl, MenuId.ChatInputSecondary]) {
				this._register(actionViewItemService.register(
					menu,
					actionId,
					(action, options, scopedInstantiationService) => {
						const session = scopedInstantiationService.invokeFunction(accessor => accessor.get(IWorkbenchEnvironmentService).isSessionsWindow
							? accessor.get(ISessionContext).session
							: undefined);
						return scopedInstantiationService.createInstance(CodexAccountActionViewItem, action, options, session);
					},
				));
			}
		}
	}
}

registerWorkbenchContribution2(CodexAccountActionViewItemContribution.ID, CodexAccountActionViewItemContribution, WorkbenchPhase.AfterRestored);
