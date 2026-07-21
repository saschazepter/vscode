/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IAgentHostService, AgentHostCodexAgentUsageSourceSettingId } from '../../../../../../platform/agentHost/common/agentService.js';
import { IAgentHostEnablementService } from '../../../../../../platform/agentHost/common/agentHostEnablementService.js';
import { AgentHostConfigKey, type CodexUsageSource } from '../../../../../../platform/agentHost/common/agentHostCustomizationConfig.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution } from '../../../../../../workbench/common/contributions.js';
import { AgentHostRootConfigForwarder, type IForwardedRootConfigKey } from './agentHostRootConfigForwarder.js';

export class AgentHostCodexSettingsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.agentHostCodexSettings';

	constructor(
		@IAgentHostService agentHostService: IAgentHostService,
		@IConfigurationService configurationService: IConfigurationService,
		@IAgentHostEnablementService agentHostEnablementService: IAgentHostEnablementService,
	) {
		super();
		const readUsageSource = (): CodexUsageSource | undefined => {
			const rootState = agentHostService.rootState.value;
			return rootState && !(rootState instanceof Error)
				? rootState.config?.values[AgentHostConfigKey.CodexUsageSource] as CodexUsageSource | undefined
				: undefined;
		};
		let previousUsageSource = readUsageSource();
		this._register(agentHostService.rootState.onDidChange(() => {
			const usageSource = readUsageSource();
			if (previousUsageSource === 'openai' && usageSource === 'copilot' && configurationService.getValue<CodexUsageSource>(AgentHostCodexAgentUsageSourceSettingId) === 'openai') {
				void configurationService.updateValue(AgentHostCodexAgentUsageSourceSettingId, 'copilot', ConfigurationTarget.USER);
			}
			previousUsageSource = usageSource;
		}));
		const keys: readonly IForwardedRootConfigKey[] = [{
			key: AgentHostConfigKey.CodexUsageSource,
			computeValue: () => configurationService.getValue<CodexUsageSource>(AgentHostCodexAgentUsageSourceSettingId) ?? 'copilot',
			registerTriggers: (store: DisposableStore, push: () => void) => store.add(configurationService.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(AgentHostCodexAgentUsageSourceSettingId)) {
					push();
				}
			})),
		}];
		const forwarder = this._register(new AgentHostRootConfigForwarder(keys, agentHostService));
		if (agentHostEnablementService.enabled) {
			forwarder.start();
		}
	}
}
