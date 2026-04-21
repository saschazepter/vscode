/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IMcpService } from '../../../mcp/common/mcpTypes.js';
import { AICustomizationManagementSection, IAICustomizationWorkspaceService } from '../../common/aiCustomizationWorkspaceService.js';
import { ICustomizationHarnessService, ICustomizationItemProvider, IHarnessDescriptor } from '../../common/customizationHarnessService.js';
import { IAgentPluginService } from '../../common/plugins/agentPluginService.js';
import { IPromptsService } from '../../common/promptSyntax/service/promptsService.js';
import { AICustomizationItemNormalizer, IAICustomizationItemSource, ProviderCustomizationItemSource } from './aiCustomizationItemSource.js';
import { PromptsServiceCustomizationItemProvider } from './promptsServiceCustomizationItemProvider.js';
import { sectionToPromptType } from './sectionToPromptType.js';

export const ICustomizationCountsService = createDecorator<ICustomizationCountsService>('customizationCountsService');

/**
 * Reactive counts for the AI customization sections.
 *
 * The numbers exposed here always match what the customization
 * management editor renders for the same section under the currently
 * active harness, because both surfaces share the same underlying
 * item-source pipeline.
 */
export interface ICustomizationCountsService {
	readonly _serviceBrand: undefined;

	/**
	 * Observable count for a single section under the active harness.
	 *
	 * For prompt-type sections (Agents, Skills, Instructions, Prompts,
	 * Hooks) the count comes from the same item source the management
	 * editor's list widget consumes, so harness filters, hook
	 * expansion, builtin merging and instruction reclassification are
	 * applied automatically.
	 *
	 * For McpServers and Plugins the count is derived from the
	 * respective platform service.
	 */
	observeCount(section: AICustomizationManagementSection): IObservable<number>;

	/**
	 * Observable total across the given sections (or every section
	 * exposed by the active workspace's `managementSections` when the
	 * argument is omitted).
	 */
	observeTotalCount(sections?: readonly AICustomizationManagementSection[]): IObservable<number>;

	/**
	 * Returns the cached item source for the given descriptor. Both
	 * the management editor's list widget and the count surfaces share
	 * the same instance so item fetches and event subscriptions are
	 * not duplicated.
	 */
	getItemSource(descriptor: IHarnessDescriptor): IAICustomizationItemSource;

	/**
	 * The default {@link ICustomizationItemProvider} that wraps the core
	 * `IPromptsService`. Used by harnesses that don't supply their own
	 * provider, and by debug tooling that needs to inspect the fallback.
	 */
	readonly defaultItemProvider: ICustomizationItemProvider;
}

/**
 * Sections backed by a prompt-type item source.
 */
const PROMPT_TYPE_SECTIONS: readonly AICustomizationManagementSection[] = [
	AICustomizationManagementSection.Agents,
	AICustomizationManagementSection.Skills,
	AICustomizationManagementSection.Instructions,
	AICustomizationManagementSection.Prompts,
	AICustomizationManagementSection.Hooks,
];

export class CustomizationCountsService extends Disposable implements ICustomizationCountsService {

	declare readonly _serviceBrand: undefined;

	private readonly itemNormalizer: AICustomizationItemNormalizer;
	readonly defaultItemProvider: PromptsServiceCustomizationItemProvider;
	private cachedItemSource: { descriptorId: string; source: IAICustomizationItemSource } | undefined;

	private readonly sectionCounts = new Map<AICustomizationManagementSection, ISettableObservable<number>>();
	private readonly mcpCount: IObservable<number>;
	private readonly pluginCount: IObservable<number>;

	private readonly itemSourceChangeDisposable = this._register(new MutableDisposable());

	private fetchSeq = 0;

	constructor(
		@IPromptsService private readonly promptsService: IPromptsService,
		@IAICustomizationWorkspaceService private readonly workspaceService: IAICustomizationWorkspaceService,
		@ICustomizationHarnessService private readonly harnessService: ICustomizationHarnessService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ILabelService labelService: ILabelService,
		@IAgentPluginService private readonly agentPluginService: IAgentPluginService,
		@IProductService productService: IProductService,
		@IMcpService private readonly mcpService: IMcpService,
	) {
		super();

		this.itemNormalizer = new AICustomizationItemNormalizer(
			this.workspaceContextService,
			this.workspaceService,
			labelService,
			this.agentPluginService,
			productService,
		);
		this.defaultItemProvider = new PromptsServiceCustomizationItemProvider(
			() => this.harnessService.getActiveDescriptor(),
			this.promptsService,
			this.workspaceService,
			productService,
		);

		for (const section of PROMPT_TYPE_SECTIONS) {
			this.sectionCounts.set(section, observableValue<number>(`customizationCount.${section}`, 0));
		}

		this.mcpCount = derived(reader => this.mcpService.servers.read(reader).length);
		this.pluginCount = derived(reader => this.agentPluginService.plugins.read(reader).length);

		// Re-establish item-source subscription whenever the active harness
		// or the set of registered harnesses changes; refresh counts on any
		// item-source change, workspace folder change, or active project
		// root change.
		this._register(autorun(reader => {
			this.harnessService.activeHarness.read(reader);
			this.harnessService.availableHarnesses.read(reader);
			this.cachedItemSource = undefined;
			const source = this.getItemSource(this.harnessService.getActiveDescriptor());
			this.itemSourceChangeDisposable.value = source.onDidChange(() => this.refreshAll());
			this.refreshAll();
		}));

		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.refreshAll()));
		this._register(autorun(reader => {
			this.workspaceService.activeProjectRoot.read(reader);
			this.refreshAll();
		}));
	}

	observeCount(section: AICustomizationManagementSection): IObservable<number> {
		if (section === AICustomizationManagementSection.McpServers) {
			return this.mcpCount;
		}
		if (section === AICustomizationManagementSection.Plugins) {
			return this.pluginCount;
		}
		const obs = this.sectionCounts.get(section);
		if (obs) {
			return obs;
		}
		// Unknown section (e.g. Models) always 0.
		return derived(_ => 0);
	}

	observeTotalCount(sections?: readonly AICustomizationManagementSection[]): IObservable<number> {
		const requested = sections ?? this.workspaceService.managementSections;
		const observables = requested.map(s => this.observeCount(s));
		return derived(reader => {
			let total = 0;
			for (const obs of observables) {
				total += obs.read(reader);
			}
			return total;
		});
	}

	getItemSource(descriptor: IHarnessDescriptor): IAICustomizationItemSource {
		if (this.cachedItemSource && this.cachedItemSource.descriptorId === descriptor.id) {
			return this.cachedItemSource.source;
		}
		const itemProvider = descriptor.itemProvider ?? (descriptor.syncProvider ? undefined : this.defaultItemProvider);
		const source = new ProviderCustomizationItemSource(
			itemProvider,
			descriptor.syncProvider,
			this.promptsService,
			this.workspaceService,
			this.fileService,
			this.pathService,
			this.itemNormalizer,
		);
		this.cachedItemSource = { descriptorId: descriptor.id, source };
		return source;
	}

	private refreshAll(): void {
		const seq = ++this.fetchSeq;
		const descriptor = this.harnessService.getActiveDescriptor();
		const source = this.getItemSource(descriptor);
		for (const [section, obs] of this.sectionCounts) {
			const promptType = sectionToPromptType(section);
			source.fetchItems(promptType).then(items => {
				if (this._store.isDisposed || seq !== this.fetchSeq) {
					return;
				}
				obs.set(items.length, undefined);
			}, err => {
				if (this._store.isDisposed || seq !== this.fetchSeq) {
					return;
				}
				onUnexpectedError(err);
				obs.set(0, undefined);
			});
		}
	}
}

registerSingleton(ICustomizationCountsService, CustomizationCountsService, InstantiationType.Delayed);
