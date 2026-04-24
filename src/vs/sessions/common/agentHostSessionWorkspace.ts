/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../base/common/codicons.js';
import { extUri, basename } from '../../base/common/resources.js';
import { ThemeIcon } from '../../base/common/themables.js';
import { URI } from '../../base/common/uri.js';
import type { ISessionGitState } from '../../platform/agentHost/common/state/sessionState.js';
import { ISessionWorkspace } from '../services/sessions/common/session.js';

export interface IAgentHostSessionProjectSummary {
	readonly uri: URI;
	readonly displayName: string;
}

export interface IAgentHostSessionWorkspaceOptions {
	readonly providerLabel?: string;
	readonly fallbackIcon: ThemeIcon;
	readonly requiresWorkspaceTrust: boolean;
	readonly description?: string;
}

export function agentHostSessionWorkspaceKey(workspace: ISessionWorkspace | undefined): string | undefined {
	const repository = workspace?.repositories[0];
	if (!workspace || !repository) {
		return undefined;
	}
	return [
		workspace.label,
		extUri.getComparisonKey(repository.uri),
		repository.workingDirectory ? extUri.getComparisonKey(repository.workingDirectory) : '',
		repository.baseBranchName ?? '',
		String(repository.baseBranchProtected ?? ''),
		String(repository.hasGitHubRemote ?? ''),
		repository.upstreamBranchName ?? '',
		String(repository.incomingChanges ?? ''),
		String(repository.outgoingChanges ?? ''),
		String(repository.uncommittedChanges ?? ''),
	].join('\n');
}

export function buildAgentHostSessionWorkspace(project: IAgentHostSessionProjectSummary | undefined, workingDirectory: URI | undefined, options: IAgentHostSessionWorkspaceOptions, gitState?: ISessionGitState): ISessionWorkspace | undefined {
	const baseBranchName = gitState?.baseBranchName;
	const baseBranchProtected = gitState?.baseBranchProtected;
	const hasGitHubRemote = gitState?.hasGitHubRemote;
	const upstreamBranchName = gitState?.upstreamBranchName;
	const incomingChanges = gitState?.incomingChanges;
	const outgoingChanges = gitState?.outgoingChanges;
	const uncommittedChanges = gitState?.uncommittedChanges;
	const gitFields = { baseBranchName, baseBranchProtected, hasGitHubRemote, upstreamBranchName, incomingChanges, outgoingChanges, uncommittedChanges };
	if (project) {
		const repositoryWorkingDirectory = extUri.isEqual(workingDirectory, project.uri) ? undefined : workingDirectory;
		return {
			label: options.providerLabel ? `${project.displayName} [${options.providerLabel}]` : project.displayName,
			description: options.description,
			icon: Codicon.repo,
			repositories: [{ uri: project.uri, workingDirectory: repositoryWorkingDirectory, detail: undefined, ...gitFields }],
			requiresWorkspaceTrust: options.requiresWorkspaceTrust,
		};
	}

	if (!workingDirectory) {
		return undefined;
	}

	const folderName = basename(workingDirectory) || workingDirectory.path;
	return {
		label: options.providerLabel ? `${folderName} [${options.providerLabel}]` : folderName,
		description: options.description,
		icon: options.fallbackIcon,
		repositories: [{ uri: workingDirectory, workingDirectory: undefined, detail: undefined, ...gitFields }],
		requiresWorkspaceTrust: options.requiresWorkspaceTrust,
	};
}
