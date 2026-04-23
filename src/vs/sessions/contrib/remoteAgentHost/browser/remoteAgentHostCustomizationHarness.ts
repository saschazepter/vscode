/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { basename, extname } from '../../../../base/common/path.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { autorun } from '../../../../base/common/observable.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { AICustomizationManagementSection, type IStorageSourceFilter } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { IPromptsService, PromptsStorage } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { PromptsType } from '../../../../workbench/contrib/chat/common/promptSyntax/promptTypes.js';
import { type IHarnessDescriptor, type ICustomizationItem, type ICustomizationItemProvider } from '../../../../workbench/contrib/chat/common/customizationHarnessService.js';
import type { IAgentConnection } from '../../../../platform/agentHost/common/agentService.js';
import { ActionType } from '../../../../platform/agentHost/common/state/sessionActions.js';
import { type AgentInfo, type CustomizationRef, type SessionCustomization, CustomizationStatus } from '../../../../platform/agentHost/common/state/sessionState.js';
import { BUILTIN_STORAGE, REMOTE_GROUP_KEY } from '../../chat/common/builtinPromptsStorage.js';
import { AgentCustomizationDisableProvider } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentCustomizationDisableProvider.js';
import { LocalAgentHostCustomizationItemProvider } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentHostLocalCustomizations.js';
import { toAgentHostUri } from '../../../../platform/agentHost/common/agentHostUri.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

export { AgentCustomizationDisableProvider as RemoteAgentDisableProvider } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentCustomizationDisableProvider.js';

/**
 * Maps a {@link CustomizationStatus} enum value to the string literal
 * expected by {@link ICustomizationItem.status}.
 */
function toStatusString(status: CustomizationStatus | undefined): 'loading' | 'loaded' | 'degraded' | 'error' | undefined {
	switch (status) {
		case CustomizationStatus.Loading: return 'loading';
		case CustomizationStatus.Loaded: return 'loaded';
		case CustomizationStatus.Degraded: return 'degraded';
		case CustomizationStatus.Error: return 'error';
		default: return undefined;
	}
}

/**
 * Reverse of {@link pluginDirForType} in `syncedCustomizationBundler`.
 * Maps a directory name inside an Open Plugin to the {@link PromptsType}
 * its files represent. Returns `undefined` for unknown directories.
 */
function promptsTypeForPluginDir(dir: string): PromptsType | undefined {
	switch (dir) {
		case 'rules': return PromptsType.instructions;
		case 'commands': return PromptsType.prompt;
		case 'agents': return PromptsType.agent;
		case 'skills': return PromptsType.skill;
		default: return undefined;
	}
}

interface IExpandedPlugin {
	readonly nonce: string | undefined;
	readonly children: readonly ICustomizationItem[];
}

/**
 * Provider that exposes a remote agent's customizations as
 * {@link ICustomizationItem} entries for the list widget.
 *
 * Baseline items come from {@link AgentInfo.customizations} (available
 * without an active session). When a session is active, the provider
 * overlays {@link SessionCustomization} data, which includes loading
 * status and enabled state.
 *
 * Each Open Plugin is also **expanded** into its individual customization
 * files (agents, skills, instructions, prompts) by reading the plugin
 * directory through the agent-host filesystem provider. The expanded
 * children inherit the parent plugin's status/enabled state and are
 * grouped under the {@link REMOTE_GROUP_KEY} "Remote" header in each
 * per-type section.
 */
export class RemoteAgentCustomizationItemProvider extends Disposable implements ICustomizationItemProvider {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _agentCustomizations: readonly CustomizationRef[];
	private _sessionCustomizations: readonly SessionCustomization[] | undefined;
	private readonly _localItemProvider: LocalAgentHostCustomizationItemProvider;

	/** Cache: pluginUri -> last expansion (keyed by nonce so we re-fetch on content change). */
	private readonly _expansionCache = new ResourceMap<IExpandedPlugin>();
	/** Cache for the last client-side workspace scan keyed by cwd. */
	private _workspaceScanCache: { cwd: URI; items: readonly ICustomizationItem[] } | undefined;

	constructor(
		agentInfo: AgentInfo,
		connection: IAgentConnection,
		private readonly _connectionAuthority: string,
		disableProvider: AgentCustomizationDisableProvider,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		@IPromptsService promptsService: IPromptsService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
	) {
		super();
		this._agentCustomizations = agentInfo.customizations ?? [];
		this._localItemProvider = this._register(new LocalAgentHostCustomizationItemProvider(promptsService, disableProvider));

		// Listen for customization changes from any session via action events
		this._register(connection.onDidAction(envelope => {
			if (envelope.action.type === ActionType.SessionCustomizationsChanged) {
				const customizations = (envelope.action as { customizations?: SessionCustomization[] }).customizations;
				if (customizations && customizations !== this._sessionCustomizations) {
					this._sessionCustomizations = customizations;
					this._onDidChange.fire();
				}
			}
		}));

		// Re-scan when the active session (and thus cwd) changes, so the
		// "new session" page immediately shows workspace customizations.
		this._register(autorun(reader => {
			const session = this._sessionsManagementService.activeSession.read(reader);
			session?.workspace.read(reader);
			this._workspaceScanCache = undefined;
			this._onDidChange.fire();
		}));

		// Surface local-side changes (disable toggles, file add/remove) too.
		this._register(this._localItemProvider.onDidChange(() => this._onDidChange.fire()));
	}

	/**
	 * Updates the baseline agent customizations (e.g. when root state
	 * changes and agent info is refreshed).
	 */
	updateAgentCustomizations(customizations: readonly CustomizationRef[]): void {
		this._agentCustomizations = customizations;
		this._onDidChange.fire();
	}

	async provideChatSessionCustomizations(token: CancellationToken): Promise<ICustomizationItem[]> {
		// Build a parent + per-plugin expansion task list, then await all
		// expansions in parallel so first-load latency scales with the
		// slowest plugin rather than the sum.
		type ParentMeta = { parent: ICustomizationItem; nonce: string | undefined; status: 'loading' | 'loaded' | 'degraded' | 'error' | undefined; statusMessage: string | undefined; enabled: boolean | undefined };
		const parents: ParentMeta[] = [];

		const sessionCustomizations = this._sessionCustomizations;
		if (sessionCustomizations) {
			for (const sc of sessionCustomizations) {
				const pluginUri = URI.isUri(sc.customization.uri) ? sc.customization.uri : URI.parse(sc.customization.uri);
				const status = toStatusString(sc.status);
				parents.push({
					parent: { uri: pluginUri, type: 'plugin', name: sc.customization.displayName, description: sc.customization.description, status, statusMessage: sc.statusMessage, enabled: sc.enabled },
					nonce: sc.customization.nonce,
					status,
					statusMessage: sc.statusMessage,
					enabled: sc.enabled,
				});
			}
		} else {
			// Baseline (no active session): agent-level customizations only.
			// Status/nonce aren't available, but we can still expand if reachable.
			for (const ref of this._agentCustomizations) {
				const pluginUri = URI.isUri(ref.uri) ? ref.uri : URI.parse(ref.uri as unknown as string);
				parents.push({
					parent: { uri: pluginUri, type: 'plugin', name: ref.displayName, description: ref.description },
					nonce: ref.nonce,
					status: undefined,
					statusMessage: undefined,
					enabled: undefined,
				});
			}
		}

		const expansions = await Promise.all(parents.map(p => this._expandPluginContents(p.parent.uri, p.nonce, token)));
		if (token.isCancellationRequested) {
			return [];
		}

		const items: ICustomizationItem[] = [];
		for (let i = 0; i < parents.length; i++) {
			const p = parents[i];
			items.push(p.parent);
			for (const child of expansions[i]) {
				// Children inherit parent status/enabled so a degraded
				// plugin surfaces the same badge on every file it contributed.
				items.push({ ...child, status: p.status, statusMessage: p.statusMessage, enabled: p.enabled });
			}
		}

		// When no server-dispatched session customizations are available
		// (e.g. on the "new session" page), proactively scan the remote
		// workspace for well-known customization files so the user sees
		// what will be picked up once the session starts.
		if (!sessionCustomizations) {
			const workspaceItems = await this._getWorkspaceCustomizations(token);
			if (!token.isCancellationRequested) {
				items.push(...workspaceItems);
			}
		}

		// Local customizations: every eligible file is shown, with the
		// user's per-URI opt-out reflected via `enabled`. The disable
		// affordance in the list widget toggles `disableProvider`.
		const local = await this._localItemProvider.provideChatSessionCustomizations(token);
		if (token.isCancellationRequested) {
			return items;
		}
		items.push(...local);

		return items;
	}

	/**
	 * Returns the cwd URI for the active session's workspace, or
	 * `undefined` if no session or workspace is available.
	 */
	private _getActiveWorkspaceCwd(): URI | undefined {
		const session = this._sessionsManagementService.activeSession.get();
		if (!session) {
			return undefined;
		}
		const workspace = session.workspace.get();
		const repo = workspace?.repositories[0];
		return repo?.workingDirectory ?? repo?.uri;
	}

	/**
	 * Client-side scan of the remote workspace for well-known
	 * customization files. Used on the "new session" page (before
	 * the server dispatches `SessionCustomizationsChanged`) so users
	 * see what workspace customizations will be picked up.
	 */
	private async _getWorkspaceCustomizations(token: CancellationToken): Promise<readonly ICustomizationItem[]> {
		const cwd = this._getActiveWorkspaceCwd();
		if (!cwd) {
			return [];
		}
		const cached = this._workspaceScanCache;
		if (cached && cached.cwd.toString() === cwd.toString()) {
			return cached.items;
		}
		const items = await this._scanWorkspaceCustomizations(cwd, token);
		if (!token.isCancellationRequested) {
			this._workspaceScanCache = { cwd, items };
		}
		return items;
	}

	/**
	 * Scans the remote working directory for well-known customization
	 * files (e.g. `.github/copilot-instructions.md`, `AGENTS.md`) via
	 * the agent-host filesystem provider.
	 */
	private async _scanWorkspaceCustomizations(cwd: URI, token: CancellationToken): Promise<readonly ICustomizationItem[]> {
		const fsRoot = toAgentHostUri(cwd, this._connectionAuthority);
		const items: ICustomizationItem[] = [];

		try {
			if (!await this._fileService.canHandleResource(fsRoot)) {
				return [];
			}

			// Well-known single files
			const singleFiles: { path: string; type: PromptsType }[] = [
				{ path: '.github/copilot-instructions.md', type: PromptsType.instructions },
				{ path: '.github/AGENTS.md', type: PromptsType.instructions },
				{ path: 'AGENTS.md', type: PromptsType.instructions },
				{ path: 'CLAUDE.md', type: PromptsType.instructions },
			];
			for (const f of singleFiles) {
				if (token.isCancellationRequested) { return []; }
				const uri = URI.joinPath(fsRoot, f.path);
				try {
					const stat = await this._fileService.stat(uri);
					if (!stat.isDirectory) {
						items.push({
							uri,
							type: f.type,
							name: basename(f.path),
							storage: PromptsStorage.plugin,
							groupKey: REMOTE_GROUP_KEY,
						});
					}
				} catch {
					// doesn't exist — skip
				}
			}

			// Directories of typed files
			const typedDirs: { path: string; type: PromptsType }[] = [
				{ path: '.github/agents', type: PromptsType.agent },
				{ path: '.github/prompts', type: PromptsType.prompt },
			];
			for (const td of typedDirs) {
				if (token.isCancellationRequested) { return []; }
				const dirUri = URI.joinPath(fsRoot, td.path);
				try {
					const stat = await this._fileService.resolve(dirUri);
					if (stat.isDirectory && stat.children) {
						for (const child of stat.children) {
							if (!child.isDirectory) {
								items.push({
									uri: child.resource,
									type: td.type,
									name: stripPromptFileExtensions(child.name),
									storage: PromptsStorage.plugin,
									groupKey: REMOTE_GROUP_KEY,
								});
							}
						}
					}
				} catch {
					// doesn't exist — skip
				}
			}
		} catch (err) {
			this._logService.trace(`[RemoteAgentCustomizationItemProvider] Workspace scan failed for ${cwd.toString()}: ${err}`);
		}

		return items;
	}

	/**
	 * Reads a plugin's directory contents through the agent-host
	 * filesystem provider and returns one {@link ICustomizationItem} per
	 * supported file (agents/skills/instructions/prompts).
	 *
	 * Cached by `(uri, nonce)`; a different nonce invalidates the entry.
	 * When the server does not provide a nonce we still cache, but the
	 * cache is keyed on `nonce === undefined` so a later session that
	 * advertises a real nonce will refresh it.
	 *
	 * Plugin manifests live one directory level below `pluginUri`:
	 * ```
	 * <pluginUri>/agents/<file>
	 * <pluginUri>/skills/<dir>/SKILL.md  (or <pluginUri>/skills/<file>)
	 * <pluginUri>/commands/<file>
	 * <pluginUri>/rules/<file>
	 * ```
	 *
	 * `IFileService.resolve()` only descends one level by default, so we
	 * resolve each known sub-folder directly (in parallel) instead of
	 * resolving the root and walking the (unpopulated) grandchild list.
	 *
	 * If the plugin URI is not reachable through the filesystem (e.g. an
	 * HTTPS marketplace ref) expansion is silently skipped.
	 */
	private async _expandPluginContents(pluginUri: URI, nonce: string | undefined, token: CancellationToken): Promise<readonly ICustomizationItem[]> {
		const cached = this._expansionCache.get(pluginUri);
		if (cached && cached.nonce === nonce) {
			return cached.children;
		}

		const fsRoot = toAgentHostUri(pluginUri, this._connectionAuthority);
		const children: ICustomizationItem[] = [];
		try {
			if (!await this._fileService.canHandleResource(fsRoot)) {
				return [];
			}
			if (token.isCancellationRequested) {
				return [];
			}

			const dirNames = ['agents', 'skills', 'commands', 'rules'] as const;
			const subdirs = dirNames.map(name => ({ name, resource: URI.joinPath(fsRoot, name) }));
			const stats = await this._fileService.resolveAll(subdirs.map(s => ({ resource: s.resource })));

			if (token.isCancellationRequested) {
				return [];
			}

			for (let i = 0; i < subdirs.length; i++) {
				const stat = stats[i];
				if (!stat.success || !stat.stat?.isDirectory || !stat.stat.children) {
					continue;
				}
				const promptType = promptsTypeForPluginDir(subdirs[i].name);
				if (!promptType) {
					continue;
				}
				children.push(...this._collectFromTypeDir(stat.stat.children, promptType));
			}
			children.sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
		} catch (err) {
			this._logService.trace(`[RemoteAgentCustomizationItemProvider] Failed to expand plugin ${pluginUri.toString()}: ${err}`);
			return [];
		}

		this._expansionCache.set(pluginUri, { nonce, children });
		return children;
	}

	/**
	 * Emits one {@link ICustomizationItem} per child of a per-type
	 * sub-folder. Skills are conventionally folders containing
	 * `SKILL.md`, but the local-sync bundler currently writes them as
	 * flat files; both layouts are accepted.
	 */
	private _collectFromTypeDir(entries: readonly { name: string; resource: URI; isDirectory: boolean }[], promptType: PromptsType): ICustomizationItem[] {
		const items: ICustomizationItem[] = [];
		for (const child of entries) {
			let displayName: string;
			if (promptType === PromptsType.skill) {
				if (child.isDirectory) {
					displayName = child.name;
				} else {
					displayName = stripPromptFileExtensions(child.name);
				}
			} else {
				if (child.isDirectory) {
					continue;
				}
				displayName = stripPromptFileExtensions(child.name);
			}
			items.push({
				uri: child.resource,
				type: promptType,
				name: displayName,
				storage: PromptsStorage.plugin,
				groupKey: REMOTE_GROUP_KEY,
			});
		}
		return items;
	}
}

/**
 * Strips the conventional prompt file extensions from a filename so we
 * can show `foo` for `foo.prompt.md` / `foo.instructions.md` etc.
 */
function stripPromptFileExtensions(filename: string): string {
	const ext = extname(filename);
	if (!ext) {
		return filename;
	}
	const stem = filename.slice(0, -ext.length);
	const dotInStem = stem.lastIndexOf('.');
	return dotInStem > 0 ? stem.slice(0, dotInStem) : stem;
}

/**
 * Creates a {@link IHarnessDescriptor} for a remote agent discovered via
 * the agent host protocol.
 *
 * The descriptor exposes the agent's server-provided customizations through
 * an {@link ICustomizationItemProvider} and allows the user to
 * select local customizations for syncing via an {@link ICustomizationDisableProvider}.
 */
export function createRemoteAgentHarnessDescriptor(
	harnessId: string,
	displayName: string,
	itemProvider: RemoteAgentCustomizationItemProvider,
	disableProvider: AgentCustomizationDisableProvider,
): IHarnessDescriptor {
	const allSources = [PromptsStorage.local, PromptsStorage.user, PromptsStorage.plugin, BUILTIN_STORAGE];
	const filter: IStorageSourceFilter = { sources: allSources };

	return {
		id: harnessId,
		label: displayName,
		icon: ThemeIcon.fromId(Codicon.remote.id),
		hiddenSections: [
			AICustomizationManagementSection.Models,
			AICustomizationManagementSection.McpServers,
		],
		hideGenerateButton: true,
		getStorageSourceFilter(_type: PromptsType): IStorageSourceFilter {
			return filter;
		},
		itemProvider,
		disableProvider,
	};
}
