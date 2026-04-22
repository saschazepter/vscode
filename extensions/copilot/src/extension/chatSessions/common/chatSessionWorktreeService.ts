/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';

export interface ChatSessionWorktreeFile {
	readonly filePath: string;
	readonly originalFilePath: string | undefined;
	readonly modifiedFilePath: string | undefined;
	readonly statistics: {
		readonly additions: number;
		readonly deletions: number;
	};
}

export interface ChatSessionWorktreeData {
	readonly data: string;
	readonly version: number;
}

interface ChatSessionWorktreeBaseProperties {
	readonly baseCommit: string;
	readonly branchName: string;
	readonly repositoryPath: string;
	readonly worktreePath: string;
	readonly changes?: readonly ChatSessionWorktreeFile[] | undefined;
}

export interface ChatSessionWorktreePropertiesV1 extends ChatSessionWorktreeBaseProperties {
	readonly version: 1;
	readonly autoCommit: boolean;
}

export interface ChatSessionWorktreePropertiesV2 extends ChatSessionWorktreeBaseProperties {
	readonly version: 2;
	readonly autoCommit?: boolean;
	readonly baseBranchName: string;
	readonly baseBranchProtected?: boolean;
	readonly upstreamBranchName?: string;
	readonly mergeBaseCommit?: string;
	readonly pullRequestUrl?: string;
	readonly pullRequestState?: string;
	readonly firstCheckpointRef?: string;
	readonly baseCheckpointRef?: string;
	readonly lastCheckpointRef?: string;
	readonly hasGitHubRemote?: boolean;
	readonly incomingChanges?: number;
	readonly outgoingChanges?: number;
	readonly uncommittedChanges?: number;
}

export type ChatSessionWorktreeProperties = ChatSessionWorktreePropertiesV1 | ChatSessionWorktreePropertiesV2;

export const IChatSessionWorktreeService = createServiceIdentifier<IChatSessionWorktreeService>('IChatSessionWorktreeService');

export interface IChatSessionWorktreeService {
	readonly _serviceBrand: undefined;

	createWorktree(repositoryPath: vscode.Uri, stream?: vscode.ChatResponseStream, baseBranch?: string, branchName?: string): Promise<ChatSessionWorktreeProperties | undefined>;

	getWorktreeProperties(sessionId: string): Promise<ChatSessionWorktreeProperties | undefined>;
	getWorktreeProperties(folder: vscode.Uri): Promise<ChatSessionWorktreeProperties | undefined>;
	setWorktreeProperties(sessionId: string, properties: string | ChatSessionWorktreeProperties): Promise<void>;

	getWorktreePath(sessionId: string): Promise<vscode.Uri | undefined>;

	applyWorktreeChanges(sessionId: string): Promise<void>;

	getSessionIdForWorktree(folder: vscode.Uri): Promise<string | undefined>;

	getWorktreeChanges(sessionId: string): Promise<readonly vscode.ChatSessionChangedFile[] | undefined>;

	handleRequestCompleted(sessionId: string): Promise<void>;

	/** Get worktree properties for all additional workspaces in a session. */
	getAdditionalWorktreeProperties(sessionId: string): Promise<ChatSessionWorktreeProperties[]>;

	/**
	 * Attempts to clean up a worktree when a session is archived.
	 * If auto-commit is enabled and there are uncommitted changes, commits them first.
	 * Returns whether the worktree was successfully deleted.
	 */
	cleanupWorktreeOnArchive(sessionId: string): Promise<{ cleaned: boolean; reason?: string }>;

	/**
	 * Recreates a worktree from the session branch when a session is unarchived.
	 * The branch must still exist (it is preserved during archive cleanup).
	 * Returns whether the worktree was successfully recreated.
	 */
	recreateWorktreeOnUnarchive(sessionId: string): Promise<{ recreated: boolean; reason?: string }>;
}
