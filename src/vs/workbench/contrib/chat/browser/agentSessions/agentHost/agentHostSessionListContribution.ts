/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { affectsAgentHostProviderPreference, AgentSession, IAgentHostService, shouldSurfaceLocalAgentHostProvider, type AgentProvider } from '../../../../../../platform/agentHost/common/agentService.js';
import { IAgentHostEnablementService } from '../../../../../../platform/agentHost/common/agentHostEnablementService.js';
import { ActionType } from '../../../../../../platform/agentHost/common/state/sessionActions.js';
import { type AgentInfo, type RootState } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../../services/environment/common/environmentService.js';
import { IChatSessionsService } from '../../../common/chatSessionsService.js';
import { type IAgentSession } from '../agentSessionsModel.js';
import { IAgentSessionsService } from '../agentSessionsService.js';
import { IAgentHostSessionWorkingDirectoryResolver } from './agentHostSessionWorkingDirectoryResolver.js';
import { AgentHostSessionListController } from './agentHostSessionListController.js';
import { AgentHostSessionListStore } from './agentHostSessionListStore.js';

export class AgentHostSessionListContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentHostSessionListContribution';

	private readonly _agentRegistrations = this._register(new DisposableMap<AgentProvider, DisposableStore>());
	private readonly _forwardedArchivedStates = new Map<string, boolean>();

	private readonly _isSessionsWindow: boolean;

	constructor(
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IChatSessionsService private readonly _chatSessionsService: IChatSessionsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IAgentHostSessionWorkingDirectoryResolver private readonly _workingDirectoryResolver: IAgentHostSessionWorkingDirectoryResolver,
		@IAgentHostEnablementService agentHostEnablementService: IAgentHostEnablementService,
		@IAgentSessionsService private readonly _agentSessionsService: IAgentSessionsService,
	) {
		super();

		this._isSessionsWindow = environmentService.isSessionsWindow;

		if (this._isSessionsWindow || !agentHostEnablementService.enabled) {
			return;
		}

		const sessionListStore = this._register(this._instantiationService.createInstance(AgentHostSessionListStore, this._agentHostService));

		this._register(this._agentSessionsService.onDidChangeSessionArchivedState(session => this._forwardArchivedState(session)));
		this._register(this._agentSessionsService.model.onDidChangeSessions(() => this._syncArchivedStates()));

		this._register(this._agentHostService.rootState.onDidChange(rootState => {
			this._handleRootStateChange(rootState, sessionListStore);
		}));

		this._register(this._agentHostService.onAgentHostStart(() => {
			sessionListStore.resetCache();
		}));

		const initialRootState = this._agentHostService.rootState.value;
		if (initialRootState && !(initialRootState instanceof Error)) {
			this._handleRootStateChange(initialRootState, sessionListStore);
		}

		this._register(this._configurationService.onDidChangeConfiguration(e => {
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
		this._syncArchivedStates();
	}

	private _syncArchivedStates(): void {
		const currentResources = new Set<string>();
		for (const session of this._agentSessionsService.model.sessions) {
			currentResources.add(session.resource.toString());
			if (session.isArchived()) {
				this._forwardArchivedState(session);
			}
		}
		for (const resource of this._forwardedArchivedStates.keys()) {
			if (!currentResources.has(resource)) {
				this._forwardedArchivedStates.delete(resource);
			}
		}
	}

	private _forwardArchivedState(session: IAgentSession): void {
		for (const provider of this._agentRegistrations.keys()) {
			if (session.providerType !== `agent-host-${provider}`) {
				continue;
			}

			const archived = session.isArchived();
			const key = session.resource.toString();
			if (this._forwardedArchivedStates.get(key) === archived) {
				return;
			}
			this._agentHostService.dispatch(AgentSession.uri(provider, AgentSession.id(session.resource)).toString(), {
				type: ActionType.SessionIsArchivedChanged,
				isArchived: archived,
			});
			this._forwardedArchivedStates.set(key, archived);
			return;
		}
	}
}
