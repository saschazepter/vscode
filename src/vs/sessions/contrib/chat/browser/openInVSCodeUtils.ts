/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { encodeHex, VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { AGENT_HOST_SCHEME, fromAgentHostUri } from '../../../../platform/agentHost/common/agentHostUri.js';
import { IRemoteAgentHostService, IRemoteAgentHostSSHConnection, RemoteAgentHostEntryType } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { isAgentHostProvider } from '../../../common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { IActiveSession, ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionWorkspace } from '../../../services/sessions/common/session.js';

/**
 * Resolves the VS Code remote authority for the given session provider,
 * e.g. `ssh-remote+myhost` or `tunnel+myTunnel`.
 *
 * Returns `undefined` for local or WebSocket-only providers where no
 * VS Code remote extension can handle the connection.
 */
export function resolveRemoteAuthority(
	providerId: string,
	sessionsProvidersService: ISessionsProvidersService,
	remoteAgentHostService: IRemoteAgentHostService,
): string | undefined {
	const provider = sessionsProvidersService.getProvider(providerId);
	if (!provider || !isAgentHostProvider(provider) || !provider.remoteAddress) {
		return undefined;
	}

	const entry = remoteAgentHostService.getEntryByAddress(provider.remoteAddress);
	if (!entry) {
		return undefined;
	}

	switch (entry.connection.type) {
		case RemoteAgentHostEntryType.SSH:
			if (entry.connection.sshConfigHost) {
				return `ssh-remote+${entry.connection.sshConfigHost}`;
			}
			return `ssh-remote+${sshAuthorityString(entry.connection)}`;
		case RemoteAgentHostEntryType.Tunnel:
			return `tunnel+${entry.connection.label ?? `${entry.connection.tunnelId}.${entry.connection.clusterId}`}`;
		default:
			return undefined;
	}
}

export const OpenInDropdownMenuId = MenuId.for('AgentSessionsOpenInDropdown');
export const OPEN_IN_TARGET_STORAGE_KEY = 'sessions.openInTarget';

// Keep in sync with the workspace picker's checked-recent selection storage.
const RECENT_WORKSPACES_STORAGE_KEY = 'sessions.recentlyPickedWorkspaces';

interface IStoredRecentWorkspace {
	readonly uri: UriComponents;
	readonly providerId: string;
	readonly checked: boolean;
}

export const enum OpenInTarget {
	VSCodeStable = 'vscodeStable',
	VSCodeInsiders = 'vscodeInsiders',
	Finder = 'finder',
	CopyPath = 'copyPath',
}

export interface IResolvedOpenInTarget {
	readonly folderUri: URI;
	readonly remoteAuthority: string | undefined;
	readonly filePath: string | undefined;
	readonly sessionResource: URI | undefined;
}

export function readStoredOpenInTarget(storageService: IStorageService): OpenInTarget {
	const storedTarget = storageService.get(OPEN_IN_TARGET_STORAGE_KEY, StorageScope.PROFILE);
	switch (storedTarget) {
		case OpenInTarget.VSCodeStable:
		case OpenInTarget.VSCodeInsiders:
		case OpenInTarget.Finder:
		case OpenInTarget.CopyPath:
			return storedTarget;
		default:
			return OpenInTarget.VSCodeStable;
	}
}

export function resolveOpenInTarget(
	sessionsManagementService: ISessionsManagementService,
	sessionsProvidersService: ISessionsProvidersService,
	remoteAgentHostService: IRemoteAgentHostService,
	storageService: IStorageService,
): IResolvedOpenInTarget | undefined {
	return resolveOpenInTargetFromSession(
		sessionsManagementService.activeSession.get(),
		sessionsProvidersService,
		remoteAgentHostService,
	) ?? resolveOpenInTargetFromWorkspaceSelection(
		restoreSelectedWorkspace(storageService, sessionsManagementService, sessionsProvidersService),
		sessionsProvidersService,
		remoteAgentHostService,
	);
}

export function canOpenInVSCode(target: IResolvedOpenInTarget | undefined): boolean {
	return !!target && (!!target.remoteAuthority || target.folderUri.scheme === Schemas.file);
}

export function canUseLocalPath(target: IResolvedOpenInTarget | undefined): target is IResolvedOpenInTarget & { readonly filePath: string } {
	return !!target?.filePath;
}

export function createVSCodeOpenUri(target: OpenInTarget.VSCodeStable | OpenInTarget.VSCodeInsiders, openTarget: IResolvedOpenInTarget): URI | undefined {
	if (!canOpenInVSCode(openTarget)) {
		return undefined;
	}

	const params = new URLSearchParams();
	params.set('windowId', '_blank');

	if (openTarget.sessionResource) {
		params.set('session', openTarget.sessionResource.toString());
	}

	const scheme = target === OpenInTarget.VSCodeInsiders ? 'vscode-insiders' : 'vscode';
	if (openTarget.remoteAuthority) {
		return URI.from({
			scheme,
			authority: Schemas.vscodeRemote,
			path: `/${openTarget.remoteAuthority}${openTarget.folderUri.path}`,
			query: params.toString(),
		});
	}

	return URI.from({
		scheme,
		authority: Schemas.file,
		path: openTarget.folderUri.path,
		query: params.toString(),
	});
}

function restoreSelectedWorkspace(
	storageService: IStorageService,
	sessionsManagementService: ISessionsManagementService,
	sessionsProvidersService: ISessionsProvidersService,
): { readonly providerId: string; readonly workspace: ISessionWorkspace } | undefined {
	const storedRecents = storageService.get(RECENT_WORKSPACES_STORAGE_KEY, StorageScope.PROFILE);
	if (!storedRecents) {
		return undefined;
	}

	let parsed: IStoredRecentWorkspace[];
	try {
		parsed = JSON.parse(storedRecents) as IStoredRecentWorkspace[];
	} catch {
		return undefined;
	}

	const activeProviderId = sessionsManagementService.activeProviderId.get();
	const providers = activeProviderId
		? sessionsProvidersService.getProviders().filter(provider => provider.id === activeProviderId)
		: sessionsProvidersService.getProviders();
	const providerIds = new Set(providers.map(provider => provider.id));

	for (const stored of parsed) {
		if (!stored.checked || !providerIds.has(stored.providerId)) {
			continue;
		}

		const provider = sessionsProvidersService.getProvider(stored.providerId);
		if (!provider) {
			continue;
		}

		try {
			const workspace = provider.resolveWorkspace(URI.revive(stored.uri));
			if (workspace) {
				return { providerId: stored.providerId, workspace };
			}
		} catch {
			continue;
		}
	}

	return undefined;
}

function resolveOpenInTargetFromSession(
	activeSession: IActiveSession | undefined,
	sessionsProvidersService: ISessionsProvidersService,
	remoteAgentHostService: IRemoteAgentHostService,
): IResolvedOpenInTarget | undefined {
	if (!activeSession) {
		return undefined;
	}

	return resolveOpenInTargetFromWorkspaceSelection(
		{
			providerId: activeSession.providerId,
			workspace: activeSession.workspace.get(),
			sessionResource: activeSession.resource,
		},
		sessionsProvidersService,
		remoteAgentHostService,
	);
}

function resolveOpenInTargetFromWorkspaceSelection(
	selection: { readonly providerId: string; readonly workspace: ISessionWorkspace | undefined; readonly sessionResource?: URI } | undefined,
	sessionsProvidersService: ISessionsProvidersService,
	remoteAgentHostService: IRemoteAgentHostService,
): IResolvedOpenInTarget | undefined {
	if (!selection) {
		return undefined;
	}

	const repo = selection?.workspace?.repositories[0];
	const rawFolderUri = repo?.workingDirectory ?? repo?.uri;
	if (!rawFolderUri) {
		return undefined;
	}

	const folderUri = rawFolderUri.scheme === AGENT_HOST_SCHEME ? fromAgentHostUri(rawFolderUri) : rawFolderUri;
	const remoteAuthority = resolveRemoteAuthority(selection.providerId, sessionsProvidersService, remoteAgentHostService);
	const filePath = !remoteAuthority && folderUri.scheme === Schemas.file ? folderUri.fsPath : undefined;

	return {
		folderUri,
		remoteAuthority,
		filePath,
		sessionResource: selection.sessionResource,
	};
}

/**
 * Encodes an SSH connection into the authority string format expected by
 * the Remote SSH extension.
 */
export function sshAuthorityString(connection: IRemoteAgentHostSSHConnection): string {
	const hostName = connection.hostName;
	const needsEncoding = connection.user || connection.port
		|| /[A-Z/\\+]/.test(hostName) || !/^[a-zA-Z0-9.:\-]+$/.test(hostName);
	if (!needsEncoding) {
		return hostName;
	}

	const obj: Record<string, string | number> = { hostName };
	if (connection.user) {
		obj.user = connection.user;
	}
	if (connection.port) {
		obj.port = connection.port;
	}

	const json = JSON.stringify(obj);
	return encodeHex(VSBuffer.fromString(json));
}
