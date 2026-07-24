/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IPolicyData } from '../../../base/common/defaultAccount.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isWeb } from '../../../base/common/platform.js';
import { PolicyCategory } from '../../../base/common/policy.js';
import * as nls from '../../../nls.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { IContextKeyService } from '../../contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { Registry } from '../../registry/common/platform.js';
import { AGENT_HOST_ENABLED_CONTEXT_KEY, IAgentHostEnablementService } from '../common/agentHostEnablementService.js';

// The setting ID is intentionally not exported — all runtime checks go through
// IAgentHostEnablementService. The string is needed here only to register
// and apply the policy.
const agentHostEnabledSettingId = 'chat.agentHost.enabled';
const aiFeaturesDisabledSettingId = 'chat.disableAIFeatures';

// Add the `policy` block to `chat.agentHost.enabled`. The base registration
// (type, default, description) is done in the common layer as a side-effect of
// importing `../common/agentHostEnablementService.js`. The policy `value`
// callback cannot be structured-cloned over Electron IPC, so it is added here
// in the browser layer only.
const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
const existingProp = configurationRegistry.getConfigurationProperties()[agentHostEnabledSettingId];
const oldNode: IConfigurationNode = { id: 'chatAgentHost', properties: { [agentHostEnabledSettingId]: existingProp } };
const newNode: IConfigurationNode = {
	id: 'chatAgentHost',
	properties: {
		[agentHostEnabledSettingId]: {
			...existingProp,
			policy: {
				name: 'ChatAgentHostEnabled',
				category: PolicyCategory.InteractiveSession,
				minimumVersion: '1.126',
				value: (policyData: IPolicyData) => policyData.chat_preview_features_enabled === false ? false : undefined,
				localization: {
					description: {
						key: 'chat.agentHost.enabled',
						value: nls.localize('chat.agentHost.enabled', "When enabled, some agents run in a separate agent host process.")
					}
				},
			}
		},
	}
};
configurationRegistry.updateConfigurations({ remove: [oldNode], add: [newNode] });

export class AgentHostEnablementService extends Disposable implements IAgentHostEnablementService {

	declare readonly _serviceBrand: undefined;

	private readonly _agentHostConfigured: boolean;
	private readonly _enabledContextKey;
	private readonly _onDidChangeEnabled = this._register(new Emitter<boolean>());
	readonly onDidChangeEnabled = this._onDidChangeEnabled.event;

	private _enabled: boolean;
	get enabled(): boolean {
		return this._enabled;
	}

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this._agentHostConfigured = !isWeb && (configurationService.getValue<boolean>(agentHostEnabledSettingId) ?? false);
		this._enabled = this._agentHostConfigured && configurationService.getValue<boolean>(aiFeaturesDisabledSettingId) !== true;
		this._enabledContextKey = AGENT_HOST_ENABLED_CONTEXT_KEY.bindTo(contextKeyService);
		this._enabledContextKey.set(this._enabled);

		this._register(configurationService.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration(aiFeaturesDisabledSettingId)) {
				return;
			}

			const enabled = this._agentHostConfigured && configurationService.getValue<boolean>(aiFeaturesDisabledSettingId) !== true;
			if (enabled === this._enabled) {
				return;
			}

			this._enabled = enabled;
			this._enabledContextKey.set(enabled);
			this._onDidChangeEnabled.fire(enabled);
		}));
	}
}

registerSingleton(IAgentHostEnablementService, AgentHostEnablementService, InstantiationType.Eager);
