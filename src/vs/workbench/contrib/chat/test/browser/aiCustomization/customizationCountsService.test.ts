/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ResourceSet } from '../../../../../../base/common/map.js';
import { autorun, IObservable, observableValue } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { workbenchInstantiationService } from '../../../../../test/browser/workbenchTestServices.js';
import { CustomizationCountsService } from '../../../browser/aiCustomization/customizationCountsService.js';
import { AICustomizationManagementSection, IAICustomizationWorkspaceService, IStorageSourceFilter } from '../../../common/aiCustomizationWorkspaceService.js';
import { ICustomizationHarnessService, ICustomizationItem, IHarnessDescriptor } from '../../../common/customizationHarnessService.js';
import { ContributionEnablementState } from '../../../common/enablement.js';
import { IAgentPlugin, IAgentPluginService } from '../../../common/plugins/agentPluginService.js';
import { PromptsType } from '../../../common/promptSyntax/promptTypes.js';
import { IPromptsService, PromptsStorage } from '../../../common/promptSyntax/service/promptsService.js';
import { IMcpServer, IMcpService } from '../../../../mcp/common/mcpTypes.js';

/**
 * Subscribes to an observable until a predicate matches, returning the
 * matching value. Resolves immediately if the current value matches.
 */
function waitForValue<T>(disposables: DisposableStore, obs: IObservable<T>, predicate: (v: T) => boolean): Promise<T> {
	return new Promise<T>(resolve => {
		const sub = autorun(reader => {
			const v = obs.read(reader);
			if (predicate(v)) {
				queueMicrotask(() => sub.dispose());
				resolve(v);
			}
		});
		disposables.add(sub);
	});
}

suite('CustomizationCountsService', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let disposables: DisposableStore;
	let instaService: TestInstantiationService;
	let providerItems: ICustomizationItem[];
	let providerOnDidChange: Emitter<void>;
	let activeHarness: ReturnType<typeof observableValue<string>>;
	let availableHarnesses: ReturnType<typeof observableValue<readonly IHarnessDescriptor[]>>;
	let mcpServers: ReturnType<typeof observableValue<readonly IMcpServer[]>>;
	let plugins: ReturnType<typeof observableValue<readonly IAgentPlugin[]>>;

	function makeDescriptor(id: string): IHarnessDescriptor {
		return {
			id,
			label: id,
			icon: Codicon.settingsGear,
			getStorageSourceFilter: (): IStorageSourceFilter => ({ sources: [PromptsStorage.local, PromptsStorage.user] }),
			itemProvider: {
				onDidChange: providerOnDidChange.event,
				provideChatSessionCustomizations: async (_token: CancellationToken) => providerItems,
			},
		};
	}

	setup(() => {
		disposables = new DisposableStore();
		providerItems = [];
		providerOnDidChange = disposables.add(new Emitter<void>());

		const initialDescriptor = makeDescriptor('test');
		activeHarness = observableValue<string>('test', 'test');
		availableHarnesses = observableValue<readonly IHarnessDescriptor[]>('test', [initialDescriptor]);
		mcpServers = observableValue<readonly IMcpServer[]>('test', []);
		plugins = observableValue<readonly IAgentPlugin[]>('test', []);

		instaService = workbenchInstantiationService({}, disposables);

		instaService.stub(IPromptsService, {
			onDidChangeCustomAgents: Event.None,
			onDidChangeSlashCommands: Event.None,
			onDidChangeSkills: Event.None,
			onDidChangeHooks: Event.None,
			onDidChangeInstructions: Event.None,
			listPromptFiles: async () => [],
			listPromptFilesForStorage: async () => [],
			getCustomAgents: async () => [],
			findAgentSkills: async () => [],
			getHooks: async () => undefined,
			getInstructionFiles: async () => [],
			getDisabledPromptFiles: () => new ResourceSet(),
		});

		instaService.stub(IAICustomizationWorkspaceService, {
			activeProjectRoot: observableValue('test', undefined),
			getActiveProjectRoot: () => undefined,
			managementSections: [
				AICustomizationManagementSection.Agents,
				AICustomizationManagementSection.Skills,
				AICustomizationManagementSection.Instructions,
				AICustomizationManagementSection.Hooks,
				AICustomizationManagementSection.McpServers,
				AICustomizationManagementSection.Plugins,
			],
			isSessionsWindow: false,
			welcomePageFeatures: { showGettingStartedBanner: false },
			getStorageSourceFilter: () => ({ sources: [PromptsStorage.local, PromptsStorage.user] }),
			getSkillUIIntegrations: () => new Map(),
			hasOverrideProjectRoot: observableValue('test', false),
			commitFiles: async () => { },
			deleteFiles: async () => { },
			generateCustomization: async () => { },
			setOverrideProjectRoot: () => { },
			clearOverrideProjectRoot: () => { },
		});

		instaService.stub(ICustomizationHarnessService, {
			activeHarness,
			availableHarnesses,
			setActiveHarness: (id: string) => { activeHarness.set(id, undefined); },
			getStorageSourceFilter: () => ({ sources: [PromptsStorage.local, PromptsStorage.user] }),
			getActiveDescriptor: () => availableHarnesses.get().find(h => h.id === activeHarness.get()) ?? availableHarnesses.get()[0],
			registerExternalHarness: () => ({ dispose() { } }),
		});

		instaService.stub(IAgentPluginService, {
			plugins,
			enablementModel: {
				readEnabled: () => ContributionEnablementState.EnabledProfile,
				setEnabled: () => { },
				remove: () => { },
			},
		});

		instaService.stub(IMcpService, {
			servers: mcpServers,
		});
	});

	teardown(() => {
		disposables.dispose();
	});

	function makeItem(type: PromptsType, name: string, storage: PromptsStorage = PromptsStorage.local): ICustomizationItem {
		return {
			uri: URI.file(`/items/${type}/${name}`),
			type,
			name,
			storage,
			enabled: true,
		};
	}

	test('observeCount reflects provider items per section', async () => {
		providerItems = [
			makeItem(PromptsType.agent, 'a1'),
			makeItem(PromptsType.agent, 'a2'),
			makeItem(PromptsType.skill, 's1'),
			makeItem(PromptsType.instructions, 'i1'),
			makeItem(PromptsType.instructions, 'i2'),
			makeItem(PromptsType.instructions, 'i3'),
		];

		const service = disposables.add(instaService.createInstance(CustomizationCountsService));

		assert.strictEqual(await waitForValue(disposables, service.observeCount(AICustomizationManagementSection.Agents), n => n === 2), 2);
		assert.strictEqual(await waitForValue(disposables, service.observeCount(AICustomizationManagementSection.Skills), n => n === 1), 1);
		assert.strictEqual(await waitForValue(disposables, service.observeCount(AICustomizationManagementSection.Instructions), n => n === 3), 3);
		assert.strictEqual(await waitForValue(disposables, service.observeCount(AICustomizationManagementSection.Hooks), n => n === 0), 0);
	});

	test('observeCount updates when provider fires onDidChange', async () => {
		providerItems = [makeItem(PromptsType.agent, 'a1')];
		const service = disposables.add(instaService.createInstance(CustomizationCountsService));
		await waitForValue(disposables, service.observeCount(AICustomizationManagementSection.Agents), n => n === 1);

		providerItems = [makeItem(PromptsType.agent, 'a1'), makeItem(PromptsType.agent, 'a2')];
		providerOnDidChange.fire();

		assert.strictEqual(await waitForValue(disposables, service.observeCount(AICustomizationManagementSection.Agents), n => n === 2), 2);
	});

	test('observeCount for McpServers reflects mcpService.servers', async () => {
		const service = disposables.add(instaService.createInstance(CustomizationCountsService));
		const count$ = service.observeCount(AICustomizationManagementSection.McpServers);

		assert.strictEqual(await waitForValue(disposables, count$, n => n === 0), 0);

		mcpServers.set([{ id: '1' }, { id: '2' }, { id: '3' }] as unknown as readonly IMcpServer[], undefined);
		assert.strictEqual(await waitForValue(disposables, count$, n => n === 3), 3);
	});

	test('observeCount for Plugins reflects agentPluginService.plugins', async () => {
		const service = disposables.add(instaService.createInstance(CustomizationCountsService));
		const count$ = service.observeCount(AICustomizationManagementSection.Plugins);

		assert.strictEqual(await waitForValue(disposables, count$, n => n === 0), 0);

		plugins.set([{ uri: URI.file('/p1') }] as unknown as readonly IAgentPlugin[], undefined);
		assert.strictEqual(await waitForValue(disposables, count$, n => n === 1), 1);
	});

	test('observeTotalCount sums sections (provider items + mcp + plugins)', async () => {
		providerItems = [
			makeItem(PromptsType.agent, 'a1'),
			makeItem(PromptsType.skill, 's1'),
			makeItem(PromptsType.instructions, 'i1'),
		];
		mcpServers.set([{ id: '1' }, { id: '2' }] as unknown as readonly IMcpServer[], undefined);
		plugins.set([{ uri: URI.file('/p1') }] as unknown as readonly IAgentPlugin[], undefined);

		const service = disposables.add(instaService.createInstance(CustomizationCountsService));

		// Expected: 1 agent + 1 skill + 1 instruction + 0 prompts + 0 hooks + 2 mcp + 1 plugin = 6
		const total = await waitForValue(disposables, service.observeTotalCount(), n => n === 6);
		assert.strictEqual(total, 6);
	});

	test('switching active harness invalidates cached item source', async () => {
		const altItems: ICustomizationItem[] = [makeItem(PromptsType.agent, 'alt1'), makeItem(PromptsType.agent, 'alt2'), makeItem(PromptsType.agent, 'alt3')];
		const altDescriptor: IHarnessDescriptor = {
			id: 'alt',
			label: 'Alt',
			icon: Codicon.settingsGear,
			getStorageSourceFilter: (): IStorageSourceFilter => ({ sources: [PromptsStorage.local, PromptsStorage.user] }),
			itemProvider: {
				onDidChange: Event.None,
				provideChatSessionCustomizations: async () => altItems,
			},
		};

		providerItems = [makeItem(PromptsType.agent, 'a1')];
		availableHarnesses.set([availableHarnesses.get()[0], altDescriptor], undefined);

		const service = disposables.add(instaService.createInstance(CustomizationCountsService));
		await waitForValue(disposables, service.observeCount(AICustomizationManagementSection.Agents), n => n === 1);

		activeHarness.set('alt', undefined);
		assert.strictEqual(await waitForValue(disposables, service.observeCount(AICustomizationManagementSection.Agents), n => n === 3), 3);
	});

	test('observeCount for unknown section returns 0', async () => {
		const service = disposables.add(instaService.createInstance(CustomizationCountsService));
		const count$ = service.observeCount(AICustomizationManagementSection.Models);
		assert.strictEqual(count$.get(), 0);
	});
});
