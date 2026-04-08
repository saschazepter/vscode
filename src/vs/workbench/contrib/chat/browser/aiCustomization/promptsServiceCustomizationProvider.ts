/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { basename, dirname } from '../../../../../base/common/resources.js';
import { ResourceMap, ResourceSet } from '../../../../../base/common/map.js';
import { localize } from '../../../../../nls.js';
import { IPromptsService, PromptsStorage } from '../../common/promptSyntax/service/promptsService.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { HookType, HOOK_METADATA } from '../../common/promptSyntax/hookTypes.js';
import { formatHookCommandLabel } from '../../common/promptSyntax/hookSchema.js';
import { Schemas } from '../../../../../base/common/network.js';
import { OS } from '../../../../../base/common/platform.js';
import { IExternalCustomizationItem, IExternalCustomizationItemProvider, matchesWorkspaceSubpath, matchesInstructionFileFilter, IHarnessDescriptor } from '../../common/customizationHarnessService.js';
import { IAICustomizationWorkspaceService, BUILTIN_STORAGE } from '../../common/aiCustomizationWorkspaceService.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { URI } from '../../../../../base/common/uri.js';

/**
 * Derives a friendly name from a filename by removing extension suffixes.
 */
function getFriendlyName(filename: string): string {
	let name = filename
		.replace(/\.instructions\.md$/i, '')
		.replace(/\.prompt\.md$/i, '')
		.replace(/\.agent\.md$/i, '')
		.replace(/\.md$/i, '');

	name = name
		.replace(/[-_]/g, ' ')
		.replace(/\b\w/g, c => c.toUpperCase());

	return name || filename;
}

/**
 * An {@link IExternalCustomizationItemProvider} backed by {@link IPromptsService}.
 *
 * Produces the same rich items (semantic groupKeys, applyTo badges,
 * disabled state, built-in extension grouping) that the list widget's
 * legacy `fetchCoreItemsForSection` code path produced, but shaped as
 * `IExternalCustomizationItem[]` so they flow through the single
 * provider-based code path in the widget.
 *
 * Used by the Local (VS Code) and Sessions (CLI) harnesses.
 */
export class PromptsServiceCustomizationProvider extends Disposable implements IExternalCustomizationItemProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _chatExtensionId: string | undefined;

	constructor(
		private readonly _descriptor: IHarnessDescriptor,
		@IPromptsService private readonly _promptsService: IPromptsService,
		@IAICustomizationWorkspaceService private readonly _workspaceService: IAICustomizationWorkspaceService,
		@IProductService productService: IProductService,
	) {
		super();
		this._chatExtensionId = productService.defaultChatAgent?.chatExtensionId;

		this._register(Event.any(
			_promptsService.onDidChangeCustomAgents,
			_promptsService.onDidChangeSlashCommands,
			_promptsService.onDidChangeSkills,
			_promptsService.onDidChangeHooks,
			_promptsService.onDidChangeInstructions,
		)(() => this._onDidChange.fire()));
	}

	async provideChatSessionCustomizations(token: CancellationToken): Promise<IExternalCustomizationItem[] | undefined> {
		const items: IExternalCustomizationItem[] = [];

		const [agents, skills, instructions, agentInstructions, prompts, hooks] = await Promise.all([
			this._promptsService.getCustomAgents(token),
			this._promptsService.findAgentSkills(token),
			this._promptsService.getInstructionFiles(token),
			this._promptsService.listAgentInstructions(token, undefined),
			this._promptsService.getPromptSlashCommands(token),
			this._promptsService.listPromptFiles(PromptsType.hook, token),
		]);

		const extensionInfoByUri = new ResourceMap<{ id: ExtensionIdentifier; displayName?: string }>();

		// --- Agents ---
		const allAgentFiles = await this._promptsService.listPromptFiles(PromptsType.agent, token);
		for (const file of allAgentFiles) {
			if (file.extension) {
				extensionInfoByUri.set(file.uri, { id: file.extension.identifier, displayName: file.extension.displayName });
			}
		}
		const disabledAgents = this._promptsService.getDisabledPromptFiles(PromptsType.agent);
		for (const agent of agents ?? []) {
			items.push({
				uri: agent.uri,
				type: PromptsType.agent,
				name: agent.name,
				description: agent.description,
				enabled: !disabledAgents.has(agent.uri),
				groupKey: this._getBuiltinGroupKey(agent.uri, agent.source.storage, extensionInfoByUri),
			});
			if (agent.source.storage === PromptsStorage.extension && !extensionInfoByUri.has(agent.uri)) {
				extensionInfoByUri.set(agent.uri, { id: agent.source.extensionId });
			}
		}

		// --- Skills ---
		const allSkillFiles = await this._promptsService.listPromptFiles(PromptsType.skill, token);
		for (const file of allSkillFiles) {
			if (file.extension) {
				extensionInfoByUri.set(file.uri, { id: file.extension.identifier, displayName: file.extension.displayName });
			}
		}
		const uiIntegrations = this._workspaceService.getSkillUIIntegrations();
		const disabledSkills = this._promptsService.getDisabledPromptFiles(PromptsType.skill);
		const seenSkillUris = new ResourceSet();
		for (const skill of skills ?? []) {
			const skillName = skill.name || basename(dirname(skill.uri)) || basename(skill.uri);
			seenSkillUris.add(skill.uri);
			const skillFolderName = basename(dirname(skill.uri));
			const uiTooltip = uiIntegrations.get(skillFolderName);
			items.push({
				uri: skill.uri,
				type: PromptsType.skill,
				name: skillName,
				description: skill.description,
				enabled: true,
				badge: uiTooltip ? localize('uiIntegrationBadge', "UI Integration") : undefined,
				badgeTooltip: uiTooltip,
				groupKey: this._getBuiltinGroupKey(skill.uri, skill.storage, extensionInfoByUri),
			});
		}
		// Disabled skills from raw file list
		if (disabledSkills.size > 0) {
			for (const file of allSkillFiles) {
				if (!seenSkillUris.has(file.uri) && disabledSkills.has(file.uri)) {
					const disabledName = file.name || basename(dirname(file.uri)) || basename(file.uri);
					const disabledFolderName = basename(dirname(file.uri));
					const uiTooltip = uiIntegrations.get(disabledFolderName);
					items.push({
						uri: file.uri,
						type: PromptsType.skill,
						name: disabledName,
						description: file.description,
						enabled: false,
						badge: uiTooltip ? localize('uiIntegrationBadge', "UI Integration") : undefined,
						badgeTooltip: uiTooltip,
						groupKey: this._getBuiltinGroupKey(file.uri, file.storage, extensionInfoByUri),
					});
				}
			}
		}

		// --- Prompts ---
		const disabledPrompts = this._promptsService.getDisabledPromptFiles(PromptsType.prompt);
		for (const command of prompts) {
			if (command.type === PromptsType.skill) {
				continue;
			}
			items.push({
				uri: command.uri,
				type: PromptsType.prompt,
				name: command.name,
				description: command.description,
				enabled: !disabledPrompts.has(command.uri),
				groupKey: this._getBuiltinGroupKey(command.uri, command.storage, extensionInfoByUri),
			});
			if (command.extension) {
				extensionInfoByUri.set(command.uri, { id: command.extension.identifier, displayName: command.extension.displayName });
			}
		}

		// --- Hooks (file-level — widget's _expandProviderHookItems handles parsing) ---
		const disabledHooks = this._promptsService.getDisabledPromptFiles(PromptsType.hook);
		for (const hookFile of hooks) {
			items.push({
				uri: hookFile.uri,
				type: PromptsType.hook,
				name: hookFile.name || getFriendlyName(basename(hookFile.uri)),
				enabled: !disabledHooks.has(hookFile.uri),
			});
		}
		// Agent-frontmatter hooks (not in sessions window)
		if (!this._workspaceService.isSessionsWindow) {
			for (const agent of agents ?? []) {
				if (!agent.hooks) {
					continue;
				}
				for (const hookType of Object.values(HookType)) {
					const hookCommands = agent.hooks[hookType];
					if (!hookCommands || hookCommands.length === 0) {
						continue;
					}
					const hookMeta = HOOK_METADATA[hookType];
					for (let i = 0; i < hookCommands.length; i++) {
						const hook = hookCommands[i];
						const cmdLabel = formatHookCommandLabel(hook, OS);
						const truncatedCmd = cmdLabel.length > 60 ? cmdLabel.substring(0, 57) + '...' : cmdLabel;
						items.push({
							uri: agent.uri,
							type: PromptsType.hook,
							name: hookMeta?.label ?? hookType,
							description: `${agent.name}: ${truncatedCmd || localize('hookUnset', "(unset)")}`,
							groupKey: 'agents',
							enabled: !disabledHooks.has(agent.uri),
						});
					}
				}
			}
		}

		// --- Instructions (semantic grouping) ---
		const disabledInstructions = this._promptsService.getDisabledPromptFiles(PromptsType.instructions);
		const agentInstructionUris = new ResourceSet(agentInstructions.map(f => f.uri));
		for (const file of instructions) {
			if (file.extension) {
				extensionInfoByUri.set(file.uri, { id: file.extension.identifier, displayName: file.extension.displayName });
			}
		}

		// Agent instruction files (AGENTS.md, CLAUDE.md, copilot-instructions.md)
		for (const file of agentInstructions) {
			items.push({
				uri: file.uri,
				type: PromptsType.instructions,
				name: basename(file.uri),
				groupKey: 'agent-instructions',
				enabled: !disabledInstructions.has(file.uri),
			});
		}

		// Context + on-demand instructions
		for (const { uri, pattern, name, description, storage } of instructions) {
			if (agentInstructionUris.has(uri)) {
				continue;
			}

			const friendlyName = getFriendlyName(name);
			const builtinGroupKey = this._getBuiltinGroupKey(uri, storage, extensionInfoByUri);

			if (pattern !== undefined) {
				const badge = pattern === '**'
					? localize('alwaysAdded', "always added")
					: pattern;
				const badgeTooltip = pattern === '**'
					? localize('alwaysAddedTooltip', "This instruction is automatically included in every interaction.")
					: localize('onContextTooltip', "This instruction is automatically included when files matching '{0}' are in context.", pattern);
				items.push({
					uri,
					type: PromptsType.instructions,
					name: friendlyName,
					description,
					badge,
					badgeTooltip,
					groupKey: builtinGroupKey ?? 'context-instructions',
					enabled: !disabledInstructions.has(uri),
				});
			} else {
				items.push({
					uri,
					type: PromptsType.instructions,
					name: friendlyName,
					description,
					groupKey: builtinGroupKey ?? 'on-demand-instructions',
					enabled: !disabledInstructions.has(uri),
				});
			}
		}

		// --- Post-processing: storage source filter ---
		const filteredItems = this._applyFilters(items);

		return filteredItems;
	}

	/**
	 * Returns `BUILTIN_STORAGE` as groupKey if the item comes from the
	 * default chat extension; `undefined` otherwise (let the widget infer).
	 */
	private _getBuiltinGroupKey(uri: URI, storage: PromptsStorage | string, extensionInfoByUri: ResourceMap<{ id: ExtensionIdentifier; displayName?: string }>): string | undefined {
		if (storage !== PromptsStorage.extension) {
			return undefined;
		}
		const extInfo = extensionInfoByUri.get(uri);
		if (!extInfo || !this._chatExtensionId) {
			return undefined;
		}
		return ExtensionIdentifier.equals(extInfo.id, this._chatExtensionId) ? BUILTIN_STORAGE : undefined;
	}

	/**
	 * Applies harness-descriptor-driven filters that were previously
	 * at the end of `fetchCoreItemsForSection`.
	 */
	private _applyFilters(items: IExternalCustomizationItem[]): IExternalCustomizationItem[] {
		let result = items;

		// Workspace subpath filter
		const subpaths = this._descriptor.workspaceSubpaths;
		const instrFilter = this._descriptor.instructionFileFilter;
		if (subpaths) {
			const projectRoot = this._workspaceService.getActiveProjectRoot();
			result = result.filter(item => {
				if (item.uri.scheme !== Schemas.file || !projectRoot || !item.uri.path.startsWith(projectRoot.path)) {
					return true;
				}
				if (matchesWorkspaceSubpath(item.uri.path, subpaths)) {
					return true;
				}
				// Keep instruction files matching the harness's native patterns
				if (instrFilter && item.type === PromptsType.instructions && matchesInstructionFileFilter(item.uri.path, instrFilter)) {
					return true;
				}
				// Keep agent instruction files at workspace root
				if (item.groupKey === 'agent-instructions') {
					return true;
				}
				return false;
			});
		}

		// Instruction file filter
		if (instrFilter) {
			result = result.filter(item => {
				if (item.type !== PromptsType.instructions) {
					return true;
				}
				return matchesInstructionFileFilter(item.uri.path, instrFilter);
			});
		}

		return result;
	}
}
