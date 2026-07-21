/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { autorun } from '../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AgentHostEnablementService } from '../../browser/agentHostEnablementService.js';
import { AGENT_HOST_ENABLED_CONTEXT_KEY } from '../../common/agentHostEnablementService.js';
import { ConfigurationTarget, IConfigurationChangeEvent } from '../../../configuration/common/configuration.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { MockContextKeyService } from '../../../keybinding/test/common/mockKeybindingService.js';

class AgentHostTestConfigurationService extends TestConfigurationService {

	constructor(private enabled: boolean) {
		super();
	}

	override getValue<T>(): T | undefined {
		return this.enabled as T;
	}

	setEnabled(enabled: boolean, source: ConfigurationTarget): void {
		this.enabled = enabled;
		const event: IConfigurationChangeEvent = {
			source,
			affectedKeys: new Set(),
			change: { keys: [], overrides: [] },
			affectsConfiguration: () => true,
		};
		this.onDidChangeConfigurationEmitter.fire(event);
	}
}

suite('AgentHostEnablementService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(enabled: boolean): {
		readonly service: AgentHostEnablementService;
		readonly configurationService: AgentHostTestConfigurationService;
		readonly contextKeyService: MockContextKeyService;
	} {
		const configurationService = new AgentHostTestConfigurationService(enabled);
		disposables.add(configurationService.onDidChangeConfigurationEmitter);
		const contextKeyService = disposables.add(new MockContextKeyService());
		const service = disposables.add(new AgentHostEnablementService(configurationService, contextKeyService));
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

	test('updates when an experiment default changes', () => {
		const { service, configurationService, contextKeyService } = createService(false);
		const changes: boolean[] = [];
		disposables.add(autorun(reader => changes.push(service.enabled.read(reader))));

		configurationService.setEnabled(true, ConfigurationTarget.DEFAULT);

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

		configurationService.setEnabled(true, ConfigurationTarget.USER);

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
});
