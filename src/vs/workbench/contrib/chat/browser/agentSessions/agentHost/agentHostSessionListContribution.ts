/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap, DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { affectsAgentHostProviderPreference, IAgentHostService, shouldSurfaceLocalAgentHostProvider, type AgentProvider } from '../../../../../../platform/agentHost/common/agentService.js';
import { IAgentHostEnablementService } from '../../../../../../platform/agentHost/common/agentHostEnablementService.js';
import { type AgentInfo, type RootState } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../../services/environment/common/environmentService.js';
import { IChatSessionsService } from '../../../common/chatSessionsService.js';
import { IAgentHostSessionWorkingDirectoryResolver } from './agentHostSessionWorkingDirectoryResolver.js';
import { AgentHostSessionListController } from './agentHostSessionListController.js';
import { AgentHostSessionListStore } from './agentHostSessionListStore.js';

export class AgentHostSessionListContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentHostSessionListContribution';

	private readonly _agentRegistrations = this._register(new DisposableMap<AgentProvider, DisposableStore>());
	private readonly _enabledStore = this._register(new MutableDisposable<DisposableStore>());

	private readonly _isSessionsWindow: boolean;

	constructor(
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IChatSessionsService private readonly _chatSessionsService: IChatSessionsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IAgentHostSessionWorkingDirectoryResolver private readonly _workingDirectoryResolver: IAgentHostSessionWorkingDirectoryResolver,
		@IAgentHostEnablementService private readonly _agentHostEnablementService: IAgentHostEnablementService,
	) {
		super();

		this._isSessionsWindow = environmentService.isSessionsWindow;
		if (this._isSessionsWindow) {
			return;
		}

		this._register(this._agentHostEnablementService.onDidChangeEnabled(() => this._updateEnabled()));
		this._updateEnabled();
	}

	private _updateEnabled(): void {
		if (!this._agentHostEnablementService.enabled) {
			this._enabledStore.clear();
			this._agentRegistrations.clearAndDisposeAll();
			return;
		}
		if (this._enabledStore.value) {
			return;
		}

		const store = new DisposableStore();
		this._enabledStore.value = store;
		const sessionListStore = store.add(this._instantiationService.createInstance(AgentHostSessionListStore, this._agentHostService));

		store.add(this._agentHostService.rootState.onDidChange(rootState => {
			this._handleRootStateChange(rootState, sessionListStore);
		}));

		store.add(this._agentHostService.onAgentHostStart(() => {
			sessionListStore.resetCache();
		}));

		const initialRootState = this._agentHostService.rootState.value;
		if (this._agentHostService.initializeResult.get() && initialRootState && !(initialRootState instanceof Error)) {
			this._handleRootStateChange(initialRootState, sessionListStore);
		}

		store.add(this._configurationService.onDidChangeConfiguration(e => {
			if (!affectsAgentHostProviderPreference(e, this._isSessionsWindow)) {
				return;
			}
			const current = this._agentHostService.rootState.value;
			if (current && !(current instanceof Error)) {
				this._handleRootStateChange(current, sessionListStore);
			}
		}));
	}

	private _shouldRegisterAgent(provider: AgentProvider): boolean {
		return shouldSurfaceLocalAgentHostProvider(provider, this._configurationService, this._isSessionsWindow);
	}

	private _handleRootStateChange(rootState: RootState, sessionListStore: AgentHostSessionListStore): void {
		const allowed = rootState.agents.filter(agent => this._shouldRegisterAgent(agent.provider));
		const incoming = new Set(allowed.map(agent => agent.provider));

		for (const [provider] of this._agentRegistrations) {
			if (!incoming.has(provider)) {
				this._agentRegistrations.deleteAndDispose(provider);
			}
		}

		for (const agent of allowed) {
			if (!this._agentRegistrations.has(agent.provider)) {
				this._registerAgent(agent, sessionListStore);
			}
		}
	}

	private _registerAgent(agent: AgentInfo, sessionListStore: AgentHostSessionListStore): void {
		const store = new DisposableStore();
		this._agentRegistrations.set(agent.provider, store);

		const sessionType = `agent-host-${agent.provider}`;
		const listController = store.add(this._instantiationService.createInstance(AgentHostSessionListController, sessionType, agent.provider, sessionListStore, undefined, 'local'));

		store.add(this._chatSessionsService.registerChatSessionItemController(sessionType, listController));
		store.add(this._workingDirectoryResolver.registerResolver(sessionType, _sessionResource => undefined, sessionResource => listController.isNewSession(sessionResource)));
	}
}
