/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import picomatch from 'picomatch';
import * as vscode from 'vscode';
import { INativeEnvService } from '../../../platform/env/common/envService';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { basename, dirname } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import type { Settings as ClaudeSettings } from '@anthropic-ai/claude-agent-sdk';
import { IClaudeRuntimeDataService } from '../claude/common/claudeRuntimeDataService';
import { ClaudeSessionUri } from '../claude/common/claudeSessionUri';
import { IPromptsService } from '../../../platform/promptFiles/common/promptsService';

// TODO: Consider reporting Claude slash commands (from Query.supportedCommands()) when appropriate
// TODO: Report MCP servers when ChatSessionCustomizationType.Mcp is available (use Query.mcpServerStatus())

/**
 * Hard-coded CLAUDE.md instruction file names that Claude recognizes.
 * Per workspace folder: CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md, .claude/CLAUDE.local.md
 * User home: ~/.claude/CLAUDE.md
 */
const WORKSPACE_INSTRUCTION_PATHS = [
	'CLAUDE.md',
	'CLAUDE.local.md',
	['.claude', 'CLAUDE.md'] as const,
	['.claude', 'CLAUDE.local.md'] as const,
] as const;

const HOME_INSTRUCTION_PATHS = [
	['.claude', 'CLAUDE.md'] as const,
] as const;

/**
 * Hook event IDs that Claude supports, matching the HookEvent types from
 * the Claude Agent SDK. Used to discover hooks from .claude/settings.json.
 */
const HOOK_EVENT_IDS = [
	'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
	'UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop',
	'PreCompact', 'SessionStart', 'SessionEnd', 'Notification',
] as const;

interface HookConfig {
	readonly type: string;
	readonly command: string;
}

interface MatcherConfig {
	readonly matcher: string;
	readonly hooks: HookConfig[];
}

interface HooksSettings {
	readonly hooks?: Partial<Record<string, MatcherConfig[]>>;
}

export class ClaudeCustomizationProvider extends Disposable implements vscode.ChatSessionCustomizationProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	static get metadata(): vscode.ChatSessionCustomizationProviderMetadata {
		return {
			label: 'Claude',
			iconId: 'claude',
			supportedTypes: [
				vscode.ChatSessionCustomizationType.Agent,
				vscode.ChatSessionCustomizationType.Skill,
				vscode.ChatSessionCustomizationType.Instructions,
				vscode.ChatSessionCustomizationType.Hook,
			],
		};
	}

	constructor(
		@IPromptsService private readonly promptsService: IPromptsService,
		@IClaudeRuntimeDataService private readonly runtimeDataService: IClaudeRuntimeDataService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@INativeEnvService private readonly envService: INativeEnvService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.runtimeDataService.onDidChange(() => this._onDidChange.fire()));
		this._register(this.promptsService.onDidChangeCustomAgents(() => this._onDidChange.fire()));
		this._register(this.promptsService.onDidChangeSkills(() => this._onDidChange.fire()));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this._onDidChange.fire()));
	}

	async provideChatSessionCustomizations(token: vscode.CancellationToken): Promise<vscode.ChatSessionCustomizationItem[]> {
		const items: vscode.ChatSessionCustomizationItem[] = [];

		// Agents: hybrid approach — file-based .claude/ agents merged with SDK-provided agents.
		// File-based agents are available immediately; SDK agents appear once a session starts.
		const sdkAgents = this.runtimeDataService.getAgents();
		const sdkAgentNames = new Set(sdkAgents.map(a => a.name.toLowerCase()));

		// SDK agents (built-in subagents like "Explore") — preferred when available
		for (const agent of sdkAgents) {
			items.push({
				uri: URI.from({ scheme: ClaudeSessionUri.scheme, path: `/agents/${agent.name}` }),
				type: vscode.ChatSessionCustomizationType.Agent,
				name: agent.name,
				description: agent.description,
				// No groupKey — vscode infers Built-in from non-file: scheme
			});
		}

		// File-based agents from .claude/ paths — shown pre-session, deduplicated with SDK
		for (const agent of await this.promptsService.getCustomAgents(token)) {
			if (isEnabledForClaudeCode(agent) && this.isClaudePath(agent.uri)) {
				const name = agent.name;
				if (!sdkAgentNames.has(name.toLowerCase())) {
					items.push({
						uri: agent.uri,
						type: vscode.ChatSessionCustomizationType.Agent,
						name,
					});
				}
			}
		}

		const agentItems = items.filter(i => i.type === vscode.ChatSessionCustomizationType.Agent);
		this.logService.debug(`[ClaudeCustomizationProvider] agents (${agentItems.length}): ${agentItems.map(a => a.name).join(', ') || '(none)'}${sdkAgents.length ? ' [sdk]' : ' [files-only, no session]'}`);

		// Instructions from hard-coded CLAUDE.md paths (checked for existence)
		const settings = await this._readMergedSettings();
		const instructionItems = await this.discoverInstructions(settings);
		items.push(...instructionItems);
		this.logService.debug(`[ClaudeCustomizationProvider] instructions (${instructionItems.length}): ${instructionItems.map(i => i.name).join(', ') || '(none)'}`);

		// Skills from .claude/skills/ directories (user-defined SKILL.md files)
		const skillOverrides = settings.skillOverrides ?? {};
		const skillItems: vscode.ChatSessionCustomizationItem[] = [];
		for (const skill of await this.promptsService.getSkills(token)) {
			if (this.isClaudePath(skill.uri)) {
				const folderName = basename(dirname(skill.uri));
				const override = skillOverrides[folderName];
				const item: vscode.ChatSessionCustomizationItem = {
					uri: skill.uri,
					type: vscode.ChatSessionCustomizationType.Skill,
					name: skill.name,
					enabled: override !== 'off',
				};
				skillItems.push(item);
			}
		}
		items.push(...skillItems);
		this.logService.debug(`[ClaudeCustomizationProvider] skills (${skillItems.length}): ${skillItems.map(s => s.name).join(', ') || '(none)'}`);

		// Hooks from .claude/settings.json files
		const hookItems = await this.discoverHooks(settings);
		items.push(...hookItems);
		this.logService.debug(`[ClaudeCustomizationProvider] hooks (${hookItems.length}): ${hookItems.map(h => h.name).join(', ') || '(none)'}`);

		this.logService.debug(`[ClaudeCustomizationProvider] total: ${items.length} items`);
		return items;
	}

	private async discoverInstructions(settings: ClaudeSettings): Promise<vscode.ChatSessionCustomizationItem[]> {
		const items: vscode.ChatSessionCustomizationItem[] = [];
		const candidates: URI[] = [];
		const excludes = settings.claudeMdExcludes ?? [];

		for (const folder of this.workspaceService.getWorkspaceFolders()) {
			for (const entry of WORKSPACE_INSTRUCTION_PATHS) {
				if (typeof entry === 'string') {
					candidates.push(URI.joinPath(folder, entry));
				} else {
					candidates.push(URI.joinPath(folder, ...entry));
				}
			}
		}

		for (const entry of HOME_INSTRUCTION_PATHS) {
			candidates.push(URI.joinPath(this.envService.userHome, ...entry));
		}

		for (const uri of candidates) {
			if (await this.fileExists(uri)) {
				const name = basename(uri).replace(/\.md$/i, '');
				const excluded = excludes.some(pattern => this._matchesExclude(uri, pattern));
				// We can only toggle enablement for items excluded by the exact absolute
				// path we write (our known pattern). Glob-based excludes from the user's
				// settings are shown as disabled but cannot be toggled from the UI.
				const excludedByKnownPattern = excluded && excludes.includes(uri.path);
				items.push({
					uri,
					type: vscode.ChatSessionCustomizationType.Instructions,
					name,
					enablementScope: !excluded || excludedByKnownPattern
						? vscode.ChatSessionCustomizationEnablementScope.Workspace
						: vscode.ChatSessionCustomizationEnablementScope.None,
					enabled: !excluded,
				});
			}
		}

		return items;
	}

	private async fileExists(uri: URI): Promise<boolean> {
		try {
			await this.fileSystemService.stat(uri);
			return true;
		} catch {
			return false;
		}
	}

	private async discoverHooks(settings: ClaudeSettings): Promise<vscode.ChatSessionCustomizationItem[]> {
		const items: vscode.ChatSessionCustomizationItem[] = [];
		const settingsPaths = this.getSettingsFilePaths();
		const allHooksDisabled = settings.disableAllHooks === true;

		for (const settingsUri of settingsPaths) {
			try {
				const content = await this.fileSystemService.readFile(settingsUri);
				const fileSettings: HooksSettings = JSON.parse(new TextDecoder().decode(content));
				if (!fileSettings.hooks) {
					continue;
				}

				for (const eventId of HOOK_EVENT_IDS) {
					const matchers = fileSettings.hooks[eventId];
					if (!matchers || matchers.length === 0) {
						continue;
					}

					for (const matcher of matchers) {
						for (const hook of matcher.hooks) {
							const matcherLabel = matcher.matcher === '*' ? '' : ` (${matcher.matcher})`;
							items.push({
								uri: settingsUri,
								type: vscode.ChatSessionCustomizationType.Hook,
								name: `${eventId}${matcherLabel}`,
								description: hook.command,
								enabled: !allHooksDisabled,
								// Individual hooks can't be toggled — only disableAllHooks
							});
						}
					}
				}
			} catch {
				// Settings file doesn't exist or is invalid — skip
			}
		}

		return items;
	}

	private getSettingsFilePaths(): URI[] {
		const paths: URI[] = [];

		for (const folder of this.workspaceService.getWorkspaceFolders()) {
			paths.push(URI.joinPath(folder, '.claude', 'settings.json'));
			paths.push(URI.joinPath(folder, '.claude', 'settings.local.json'));
		}

		paths.push(URI.joinPath(this.envService.userHome, '.claude', 'settings.json'));
		return paths;
	}

	private isClaudePath(uri: URI): boolean {
		const folders = this.workspaceService.getWorkspaceFolders();
		for (const folder of folders) {
			const folderPath = folder.path.endsWith('/') ? folder.path : folder.path + '/';
			if (uri.path.startsWith(folderPath)) {
				const relative = uri.path.slice(folderPath.length);
				if (relative.startsWith('.claude/')) {
					return true;
				}
			}
		}

		// Also check user home .claude/ directory
		const homePath = this.envService.userHome.path;
		const homePrefix = homePath.endsWith('/') ? homePath : homePath + '/';
		if (uri.path.startsWith(homePrefix)) {
			const relative = uri.path.slice(homePrefix.length);
			if (relative.startsWith('.claude/')) {
				return true;
			}
		}

		return false;
	}

	// --- Settings ---

	/**
	 * Path to the user-level claude settings file (`~/.claude/settings.json`).
	 */
	private get _userSettingsUri(): URI {
		return URI.joinPath(this.envService.userHome, '.claude', 'settings.json');
	}

	/**
	 * Returns the workspace-local settings URI for the first workspace folder.
	 * Falls back to the user-level settings URI if no workspace folders exist.
	 */
	private get _workspaceSettingsUri(): URI {
		const folders = this.workspaceService.getWorkspaceFolders();
		if (folders.length > 0) {
			return URI.joinPath(folders[0], '.claude', 'settings.local.json');
		}
		return this._userSettingsUri;
	}

	/**
	 * Reads a single settings file as a typed object.
	 * Returns an empty object if the file doesn't exist or can't be parsed.
	 */
	private async _readSettingsFile(uri: URI): Promise<ClaudeSettings> {
		try {
			const bytes = await this.fileSystemService.readFile(uri);
			const parsed = JSON.parse(new TextDecoder().decode(bytes));
			return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
		} catch {
			return {};
		}
	}

	/**
	 * Reads and merges settings from all settings files (workspace + user-level).
	 * Workspace settings take precedence over user-level for object keys;
	 * array values (e.g. `claudeMdExcludes`) are concatenated.
	 */
	private async _readMergedSettings(): Promise<ClaudeSettings> {
		const allSettings = await Promise.all(
			this.getSettingsFilePaths().map(uri => this._readSettingsFile(uri))
		);

		const merged: Record<string, unknown> = {};
		for (const settings of allSettings) {
			for (const [key, value] of Object.entries(settings)) {
				if (value === undefined) {
					continue;
				}
				const existing = merged[key];
				if (Array.isArray(existing) && Array.isArray(value)) {
					merged[key] = [...existing, ...value];
				} else if (existing === undefined) {
					merged[key] = value;
				}
				// First-writer-wins for non-array scalar/object values
			}
		}

		return merged as ClaudeSettings;
	}

	/**
	 * Writes settings to the appropriate file based on scope.
	 * - `Workspace`: writes to `<workspace>/.claude/settings.local.json`
	 * - `Global` (or other): writes to `~/.claude/settings.json`
	 */
	private async _writeSettings(settings: ClaudeSettings, scope: vscode.ChatSessionCustomizationEnablementScope): Promise<void> {
		const targetUri = scope === vscode.ChatSessionCustomizationEnablementScope.Workspace
			? this._workspaceSettingsUri
			: this._userSettingsUri;
		const content = new TextEncoder().encode(JSON.stringify(settings, null, 4));
		await this.fileSystemService.writeFile(targetUri, content);
	}

	/**
	 * Checks whether a URI matches a claudeMdExcludes pattern.
	 * Patterns are matched against absolute file paths using picomatch,
	 * consistent with how Claude Code evaluates them.
	 */
	private _matchesExclude(uri: URI, pattern: string): boolean {
		return this._getExcludeMatcher(pattern)(uri.path);
	}

	private readonly _excludeMatcherCache = new Map<string, picomatch.Matcher>();

	private _getExcludeMatcher(pattern: string): picomatch.Matcher {
		let matcher = this._excludeMatcherCache.get(pattern);
		if (!matcher) {
			matcher = picomatch(pattern, { dot: true });
			this._excludeMatcherCache.set(pattern, matcher);
		}
		return matcher;
	}

	// --- Enablement ---

	async handleCustomizationEnablement(uri: vscode.Uri, type: vscode.ChatSessionCustomizationType, enabled: boolean, scope: vscode.ChatSessionCustomizationEnablementScope, _token: vscode.CancellationToken): Promise<void> {
		const settingsFileUri = scope === vscode.ChatSessionCustomizationEnablementScope.Workspace
			? this._workspaceSettingsUri
			: this._userSettingsUri;
		const settings = { ...await this._readSettingsFile(settingsFileUri) };

		if (type.id === vscode.ChatSessionCustomizationType.Skill.id) {
			// skillOverrides: Record<string, 'on' | 'name-only' | 'user-invocable-only' | 'off'>
			const folderName = basename(dirname(URI.from(uri))) || basename(URI.from(uri));
			const overrides = { ...settings.skillOverrides ?? {} };
			if (enabled) {
				delete overrides[folderName];
			} else {
				overrides[folderName] = 'off';
			}
			settings.skillOverrides = Object.keys(overrides).length > 0 ? overrides : undefined;
		} else if (type.id === vscode.ChatSessionCustomizationType.Instructions.id) {
			// claudeMdExcludes: string[] of absolute paths or glob patterns
			const targetUri = URI.from(uri);
			const currentExcludes = [...(settings.claudeMdExcludes ?? [])];
			if (enabled) {
				settings.claudeMdExcludes = currentExcludes.filter(p => !this._matchesExclude(targetUri, p));
			} else {
				if (!currentExcludes.some(p => this._matchesExclude(targetUri, p))) {
					currentExcludes.push(targetUri.path);
					settings.claudeMdExcludes = currentExcludes;
				}
			}
		} else {
			this.logService.warn(`[ClaudeCustomizationProvider] Per-item enablement not supported for type: ${type.id}`);
			return;
		}

		try {
			await this._writeSettings(settings, scope);
			this.logService.debug(`[ClaudeCustomizationProvider] ${enabled ? 'Enabled' : 'Disabled'} ${type.id} in ${settingsFileUri.toString()}`);
			this._onDidChange.fire();
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t('Failed to update Claude settings: {0}', err instanceof Error ? err.message : String(err)));
		}
	}
}

export function isEnabledForClaudeCode(customization: { sessionTypes?: readonly string[] }): boolean {
	const sessionTypes = customization.sessionTypes;
	return sessionTypes === undefined || sessionTypes.includes('claude-code') || false;
}
