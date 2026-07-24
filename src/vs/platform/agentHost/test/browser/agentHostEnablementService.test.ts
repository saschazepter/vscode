/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { autorun } from '../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AgentHostEnablementService } from '../../browser/agentHostEnablementService.js';
import { AGENT_HOST_ENABLED_CONTEXT_KEY } from '../../common/agentHostEnablementService.js';
import { ConfigurationTarget, IConfigurationChangeEvent, IConfigurationOverrides, IConfigurationValue } from '../../../configuration/common/configuration.js';
import { ChatAIDisabledSettingId } from '../../../chat/common/chatSettings.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { MockContextKeyService } from '../../../keybinding/test/common/mockKeybindingService.js';

class AgentHostTestConfigurationService extends TestConfigurationService {

	private readonly values = new Map<string, boolean>();
	private aiDisabledUserValue: boolean;

	constructor(agentHostEnabled: boolean, aiDisabled = false, aiDisabledUserValue = aiDisabled) {
		super();
		this.values.set('chat.agentHost.enabled', agentHostEnabled);
		this.values.set(ChatAIDisabledSettingId, aiDisabled);
		this.aiDisabledUserValue = aiDisabledUserValue;
	}

	override getValue<T>(arg1?: string | IConfigurationOverrides): T | undefined {
		return (typeof arg1 === 'string' ? this.values.get(arg1) : undefined) as T | undefined;
	}

	override inspect<T>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<T> {
		const inspected = super.inspect<T>(key, overrides);
		return key === ChatAIDisabledSettingId
			? { ...inspected, userValue: this.aiDisabledUserValue as T, userLocalValue: this.aiDisabledUserValue as T }
			: inspected;
	}

	setValue(key: string, value: boolean, source: ConfigurationTarget): void {
		this.values.set(key, value);
		if (key === ChatAIDisabledSettingId && source === ConfigurationTarget.USER) {
			this.aiDisabledUserValue = value;
		}
		const event: IConfigurationChangeEvent = {
			source,
			affectedKeys: new Set([key]),
			change: { keys: [key], overrides: [] },
			affectsConfiguration: candidate => candidate === key,
		};
		this.onDidChangeConfigurationEmitter.fire(event);
	}
}

suite('AgentHostEnablementService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(enabled: boolean, aiDisabled = false, aiDisabledUserValue = aiDisabled): {
		readonly service: AgentHostEnablementService;
		readonly configurationService: AgentHostTestConfigurationService;
		readonly contextKeyService: MockContextKeyService;
	} {
		const configurationService = new AgentHostTestConfigurationService(enabled, aiDisabled, aiDisabledUserValue);
		disposables.add(configurationService.onDidChangeConfigurationEmitter);
		const contextKeyService = disposables.add(new MockContextKeyService());
		const service = disposables.add(new AgentHostEnablementService(false, configurationService, contextKeyService));
		return { service, configurationService, contextKeyService };
	}

	test('uses the initial configuration value', () => {
		const { service, contextKeyService } = createService(true);
		assert.deepStrictEqual({
			enabled: service.enabled.get(),
			contextKey: contextKeyService.getContextKeyValue(AGENT_HOST_ENABLED_CONTEXT_KEY.key),
		}, {
			enabled: true,
			contextKey: true,
		});
	});

	test('is disabled when AI features are disabled', () => {
		const { service, contextKeyService } = createService(true, true);
		assert.deepStrictEqual({
			enabled: service.enabled.get(),
			contextKey: contextKeyService.getContextKeyValue(AGENT_HOST_ENABLED_CONTEXT_KEY.key),
		}, {
			enabled: false,
			contextKey: false,
		});
	});

	test('is disabled when a user opt-out is masked by a workspace override', () => {
		const { service, contextKeyService } = createService(true, false, true);
		assert.deepStrictEqual({
			enabled: service.enabled.get(),
			contextKey: contextKeyService.getContextKeyValue(AGENT_HOST_ENABLED_CONTEXT_KEY.key),
		}, {
			enabled: false,
			contextKey: false,
		});
	});

	test('updates when an experiment default changes', () => {
		const { service, configurationService, contextKeyService } = createService(false);
		const changes: boolean[] = [];
		disposables.add(autorun(reader => changes.push(service.enabled.read(reader))));

		configurationService.setValue('chat.agentHost.enabled', true, ConfigurationTarget.DEFAULT);

		assert.deepStrictEqual({
			enabled: service.enabled.get(),
			contextKey: contextKeyService.getContextKeyValue(AGENT_HOST_ENABLED_CONTEXT_KEY.key),
			changes,
		}, {
			enabled: true,
			contextKey: true,
			changes: [false, true],
		});
	});

	test('ignores user configuration changes after startup', () => {
		const { service, configurationService, contextKeyService } = createService(false);
		const changes: boolean[] = [];
		disposables.add(autorun(reader => changes.push(service.enabled.read(reader))));

		configurationService.setValue('chat.agentHost.enabled', true, ConfigurationTarget.USER);

		assert.deepStrictEqual({
			enabled: service.enabled.get(),
			contextKey: contextKeyService.getContextKeyValue(AGENT_HOST_ENABLED_CONTEXT_KEY.key),
			changes,
		}, {
			enabled: false,
			contextKey: false,
			changes: [false],
		});
	});

	test('does not enable from experiment while AI features are disabled', () => {
		const { service, configurationService, contextKeyService } = createService(false, true);
		const changes: boolean[] = [];
		disposables.add(autorun(reader => changes.push(service.enabled.read(reader))));

		configurationService.setValue('chat.agentHost.enabled', true, ConfigurationTarget.DEFAULT);

		assert.deepStrictEqual({
			enabled: service.enabled.get(),
			contextKey: contextKeyService.getContextKeyValue(AGENT_HOST_ENABLED_CONTEXT_KEY.key),
			changes,
		}, {
			enabled: false,
			contextKey: false,
			changes: [false],
		});
	});

	test('can enable when AI features are re-enabled', () => {
		const { service, configurationService, contextKeyService } = createService(true, true);
		const changes: boolean[] = [];
		disposables.add(autorun(reader => changes.push(service.enabled.read(reader))));

		configurationService.setValue(ChatAIDisabledSettingId, false, ConfigurationTarget.USER);

		assert.deepStrictEqual({
			enabled: service.enabled.get(),
			contextKey: contextKeyService.getContextKeyValue(AGENT_HOST_ENABLED_CONTEXT_KEY.key),
			changes,
		}, {
			enabled: true,
			contextKey: true,
			changes: [false, true],
		});
	});

	test('can enable after clearing a masked user opt-out', () => {
		const { service, configurationService, contextKeyService } = createService(true, false, true);
		const changes: boolean[] = [];
		disposables.add(autorun(reader => changes.push(service.enabled.read(reader))));

		configurationService.setValue(ChatAIDisabledSettingId, false, ConfigurationTarget.USER);

		assert.deepStrictEqual({
			enabled: service.enabled.get(),
			contextKey: contextKeyService.getContextKeyValue(AGENT_HOST_ENABLED_CONTEXT_KEY.key),
			changes,
		}, {
			enabled: true,
			contextKey: true,
			changes: [false, true],
		});
	});
});
