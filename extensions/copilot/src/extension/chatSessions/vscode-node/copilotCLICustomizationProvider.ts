/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ICustomInstructionsService } from '../../../platform/customInstructions/common/customInstructionsService';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { IPromptsService } from '../../../platform/promptFiles/common/promptsService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { basename, dirname } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { ICopilotCLIAgents, isEnabledForCopilotCLI } from '../copilotcli/node/copilotCli';
import { CopilotCLISettingsLocationType, ICopilotCLISettingsService } from '../copilotcli/common/copilotCLISettingsService';

export class CopilotCLICustomizationProvider extends Disposable implements vscode.ChatSessionCustomizationProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	static get metadata(): vscode.ChatSessionCustomizationProviderMetadata {
		return {
			label: 'Copilot CLI',
			iconId: 'copilot',
			supportedTypes: [
				vscode.ChatSessionCustomizationType.Agent,
				vscode.ChatSessionCustomizationType.Skill,
				vscode.ChatSessionCustomizationType.Instructions,
				vscode.ChatSessionCustomizationType.Hook,
				vscode.ChatSessionCustomizationType.Plugins,
			].filter((t): t is vscode.ChatSessionCustomizationType => t !== undefined),
		};
	}

	constructor(
		@ICopilotCLIAgents private readonly copilotCLIAgents: ICopilotCLIAgents,
		@ICustomInstructionsService private readonly customInstructionsService: ICustomInstructionsService,
		@IPromptsService private readonly promptsService: IPromptsService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@ICopilotCLISettingsService private readonly copilotCLISettingsService: ICopilotCLISettingsService,
	) {
		super();

		this._register(this.promptsService.onDidChangeCustomAgents(() => this._onDidChange.fire()));
		this._register(this.promptsService.onDidChangeInstructions(() => this._onDidChange.fire()));
		this._register(this.promptsService.onDidChangeSkills(() => this._onDidChange.fire()));
		this._register(this.promptsService.onDidChangeHooks(() => this._onDidChange.fire()));
		this._register(this.promptsService.onDidChangePlugins(() => this._onDidChange.fire()));
		this._register(this.copilotCLIAgents.onDidChangeAgents(() => this._onDidChange.fire()));
		this._register(this.copilotCLISettingsService.onDidChange(() => this._onDidChange.fire()));
	}

	async provideChatSessionCustomizations(token: vscode.CancellationToken): Promise<vscode.ChatSessionCustomizationItem[]> {
		const [agents, instructions, skills, hooks, plugins] = await Promise.all([
			this.getAgentItems(token),
			this.getInstructionItems(token),
			this.getSkillItems(token),
			this.getHookItems(token),
			this.getPluginItems(token),
		].map(p => p.catch(err => {
			if (isCancellationError(err) || token.isCancellationRequested) {
				throw err;
			}
			this.logService.error(`[CopilotCLICustomizationProvider] failed to get customizations: ${err}`);
			return [];
		})));

		this.logService.debug(`[CopilotCLICustomizationProvider] agents (${agents.length}): ${agents.map(a => a.name).join(', ') || '(none)'}`);
		this.logService.debug(`[CopilotCLICustomizationProvider] instructions (${instructions.length}): ${instructions.map(i => i.name).join(', ') || '(none)'}`);
		this.logService.debug(`[CopilotCLICustomizationProvider] skills (${skills.length}): ${skills.map(s => s.name).join(', ') || '(none)'}`);
		this.logService.debug(`[CopilotCLICustomizationProvider] hooks (${hooks.length}): ${hooks.map(h => h.name).join(', ') || '(none)'}`);

		this.logService.debug(`[CopilotCLICustomizationProvider] plugins (${plugins.length}): ${plugins.map(p => p.name).join(', ') || '(none)'}`);

		const items = [...agents, ...instructions, ...skills, ...hooks, ...plugins];
		this.logService.debug(`[CopilotCLICustomizationProvider] total: ${items.length} items`);
		return items;
	}

	/**
	 * Builds agent items from ICopilotCLIAgents, which already merges SDK
	 * and prompt-file agents with source URIs.
	 */
	private async getAgentItems(_token: vscode.CancellationToken): Promise<vscode.ChatSessionCustomizationItem[]> {
		const agentInfos = await this.copilotCLIAgents.getAgents();
		return agentInfos.map(({ agent, sourceUri }) => ({
			uri: sourceUri,
			type: vscode.ChatSessionCustomizationType.Agent,
			name: agent.displayName || agent.name,
			description: agent.description,
			enablementScope: vscode.ChatSessionCustomizationEnablementScope.None,
		}));
	}

	/**
	 * Collects all instruction items from the prompt file service,
	 * categorizing them with groupKeys and badges matching the core
	 * implementation:
	 * - agent-instructions: AGENTS.md, CLAUDE.md, copilot-instructions.md
	 * - context-instructions: files with an applyTo pattern (badge = pattern)
	 * - on-demand-instructions: files without an applyTo pattern
	 */
	private async getInstructionItems(token: CancellationToken): Promise<vscode.ChatSessionCustomizationItem[]> {
		// Collect agent instruction URIs from customInstructionsService
		// (copilot-instructions.md) plus workspace-root AGENTS.md and CLAUDE.md
		const agentInstructionUriList = await this.customInstructionsService.getAgentInstructions();
		const rootFileNames = ['AGENTS.md', 'CLAUDE.md'];
		for (const folder of this.workspaceService.getWorkspaceFolders()) {
			for (const fileName of rootFileNames) {
				const uri = URI.joinPath(folder, fileName);
				try {
					await this.fileSystemService.stat(uri);
					agentInstructionUriList.push(uri);
				} catch {
					// file doesn't exist
				}
			}
		}

		const items: vscode.ChatSessionCustomizationItem[] = [];
		const seenUris = new Set<string>();

		// Emit agent instruction files (AGENTS.md, CLAUDE.md, copilot-instructions.md)
		// that come from customInstructionsService but may not appear in
		// promptsService.getInstructions().
		for (const uri of agentInstructionUriList) {
			seenUris.add(uri.toString());
			items.push({
				uri,
				type: vscode.ChatSessionCustomizationType.Instructions,
				name: basename(uri),
				groupKey: 'agent-instructions',
			});
		}

		for (const instruction of await this.promptsService.getInstructions(token)) {
			const uri = instruction.uri;
			if (!isEnabledForCopilotCLI(instruction)) {
				continue; // only include instructions that are relevant for copilotcli
			}

			if (seenUris.has(uri.toString())) {
				continue; // already emitted as agent instruction
			}

			const name = instruction.name;
			const pattern = instruction.pattern;
			const description = instruction.description;

			if (pattern !== undefined) {
				const badge = pattern === '**'
					? l10n.t('always added')
					: pattern;
				const badgeTooltip = pattern === '**'
					? l10n.t('This instruction is automatically included in every interaction.')
					: l10n.t('This instruction is automatically included when files matching \'{0}\' are in context.', pattern);
				items.push({
					uri,
					type: vscode.ChatSessionCustomizationType.Instructions,
					name,
					description,
					groupKey: 'context-instructions',
					badge,
					badgeTooltip,
					enablementScope: vscode.ChatSessionCustomizationEnablementScope.None,
				});
			} else {
				items.push({
					uri,
					type: vscode.ChatSessionCustomizationType.Instructions,
					name,
					description,
					groupKey: 'on-demand-instructions',
					enablementScope: vscode.ChatSessionCustomizationEnablementScope.None,
				});
			}
		}

		return items;
	}

	/**
	 * Collects all skill items from the prompt file service.
	 */
	private async getSkillItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionCustomizationItem[]> {
		const settings = await this._readUserSettings();
		const disabledSkills = Array.isArray(settings.disabledSkills) ? settings.disabledSkills.filter(s => typeof s === 'string') : [];
		const disabledSkillsSet = new Set<string>(disabledSkills);
		return (await this.promptsService.getSkills(token)).filter(isEnabledForCopilotCLI).map(s => {
			const name = s.name;
			const skillName = basename(dirname(s.uri));
			return {
				uri: s.uri,
				type: vscode.ChatSessionCustomizationType.Skill,
				name,
				enabled: !disabledSkillsSet.has(skillName),
				enablementScope: vscode.ChatSessionCustomizationEnablementScope.Global,
			};
		});
	}

	/**
	 * Collects all hook items from the prompt file service.
	 * Each item is a hook configuration file (JSON).
	 */
	private async getHookItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionCustomizationItem[]> {
		const settings = await this._readUserSettings();
		return (await this.promptsService.getHooks(token)).filter(isEnabledForCopilotCLI).map(h => ({
			uri: h.uri,
			type: vscode.ChatSessionCustomizationType.Hook,
			name: basename(h.uri).replace(/\.json$/i, ''),
			// TODO: This is best-effort for now. Each hook file itself can disable all hooks with disableAllHooks.
			enabled: settings.disableAllHooks === false,
			// TODO: There isn't a great way to toggle enablement for individual hooks
			enablementScope: vscode.ChatSessionCustomizationEnablementScope.None,
		}));
	}

	/**
	 * Collects all plugin items from the prompt file service.
	 */
	private async getPluginItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionCustomizationItem[]> {
		const settings = await this._readUserSettings();
		const enabledPlugins = typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {};
		return (await this.promptsService.getPlugins(token)).filter(isEnabledForCopilotCLI).map(p => {
			const name = basename(p.uri);
			return {
				uri: p.uri,
				type: vscode.ChatSessionCustomizationType.Plugins,
				name,
				enabled: enabledPlugins[name] !== false,
				enablementScope: vscode.ChatSessionCustomizationEnablementScope.Global,
			};
		});
	}

	// --- Enablement ---

	/**
	 * Reads the user-level settings from the settings service.
	 */
	private async _readUserSettings() {
		const allSettings = await this.copilotCLISettingsService.readAllSettings();
		return allSettings[0]?.settings ?? {};
	}

	/**
	 * Returns the URI of the user-level settings file.
	 */
	private get _settingsUri(): URI {
		return this.copilotCLISettingsService.getUris(CopilotCLISettingsLocationType.User)[0];
	}

	async handleCustomizationEnablement(uri: vscode.Uri, type: vscode.ChatSessionCustomizationType, enabled: boolean, _scope: vscode.ChatSessionCustomizationEnablementScope, _token: vscode.CancellationToken): Promise<void> {
		const settings = await this._readUserSettings();
		let name: string;

		if (type.id === vscode.ChatSessionCustomizationType.Skill.id) {
			// Skills use the folder name as the key in disabledSkills
			name = basename(dirname(URI.from(uri))) || basename(URI.from(uri));
			const currentList = Array.isArray(settings.disabledSkills) ? settings.disabledSkills as string[] : [];
			if (enabled) {
				settings.disabledSkills = currentList.filter(s => s !== name);
			} else if (!currentList.includes(name)) {
				settings.disabledSkills = [...currentList, name];
			}
		} else if (type.id === vscode.ChatSessionCustomizationType.Plugins?.id) {
			// Plugins use enabledPlugins map (Record<string, boolean>)
			name = basename(URI.from(uri));
			const map = (settings.enabledPlugins && typeof settings.enabledPlugins === 'object' && !Array.isArray(settings.enabledPlugins))
				? { ...settings.enabledPlugins as Record<string, boolean> }
				: {};
			if (enabled) {
				delete map[name];
			} else {
				map[name] = false;
			}
			settings.enabledPlugins = Object.keys(map).length > 0 ? map : undefined;
		} else {
			this.logService.warn(`[CopilotCLICustomizationProvider] Per-item enablement not supported for type: ${type.id}`);
			void vscode.window.showErrorMessage(vscode.l10n.t('Toggling {0} customizations is not supported.', type.id));
			return;
		}

		try {
			await this.copilotCLISettingsService.writeSettingsFile(this._settingsUri, settings);
			this.logService.debug(`[CopilotCLICustomizationProvider] ${enabled ? 'Enabled' : 'Disabled'} ${type.id} "${name}" in ${this._settingsUri.toString()}`);
			this._onDidChange.fire();
		} catch (err) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Failed to update Copilot settings: {0}', err instanceof Error ? err.message : String(err)));
		}
	}
}
