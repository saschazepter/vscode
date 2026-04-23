/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Uri } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { ResourceMap } from '../../../util/vs/base/common/map';
import { ChatSessionWorktreeProperties } from './chatSessionWorktreeService';

interface SessionEntry {
	readonly folder: Uri;
	readonly folderKind: 'worktree' | 'folder';
}
export const ISessionWorkingDirectoryStore = createServiceIdentifier<ISessionWorkingDirectoryStore>('ISessionWorkingDirectoryStore');

export interface ISessionWorkingDirectoryStore {
	readonly _serviceBrand: undefined;
	getSessionIdsForFolder(folder: Uri): string[];
	getWorktreeSessions(folder: Uri): string[];
	addEntry(sessionId: string, folder: Uri, folderKind: 'worktree' | 'folder'): void;
}

export class SessionWorkingDirectoryStore implements ISessionWorkingDirectoryStore {
	declare readonly _serviceBrand: undefined;
	/** Session id → entry. */
	private readonly _byId = new Map<string, SessionEntry>();
	/** Worktree folder URI → session id. Uses URI-aware comparison so path casing is handled correctly. */
	private readonly _byFolder = new ResourceMap<Set<string>>();

	getSessionIdsForFolder(folder: Uri): string[] {
		const sessionIds = new Set<string>();
		const entry = this._byFolder.get(folder);
		if (entry) {
			for (const sessionId of entry) {
				sessionIds.add(sessionId);
			}
		}
		return Array.from(sessionIds);
	}

	getWorktreeSessions(folder: Uri): string[] {
		const sessionIds = new Set<string>();
		const entry = this._byFolder.get(folder);
		if (entry) {
			for (const sessionId of entry) {
				const sessionEntry = this._byId.get(sessionId);
				if (sessionEntry?.folderKind === 'worktree') {
					sessionIds.add(sessionId);
				}
			}
		}
		return Array.from(sessionIds);
	}

	addEntry(sessionId: string, folder: Uri, folderKind: 'worktree' | 'folder'): void {
		if (!this._byId.get(sessionId)) {
			this._byId.set(sessionId, { folder, folderKind });
		}
		const folderEntry = this._byFolder.get(folder) ?? new Set<string>();
		folderEntry.add(sessionId);
		this._byFolder.set(folder, folderEntry);
	}
}
