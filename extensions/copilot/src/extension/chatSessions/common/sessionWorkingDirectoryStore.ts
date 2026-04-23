/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Uri } from 'vscode';
import { ResourceMap } from '../../../../../../src/vs/base/common/map.js';
import { createServiceIdentifier } from '../../../util/common/services.js';

interface SessionEntry {
	readonly folder: Uri;
	readonly folderKind: 'worktree' | 'folder';
}
export const ISessionWorkingDirectoryStore = createServiceIdentifier<ISessionWorkingDirectoryStore>('ISessionWorkingDirectoryStore');

export interface ISessionWorkingDirectoryStore {
	readonly _serviceBrand: undefined;
	getSessionIdsForFolder(folder: Uri): string[];
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

	addEntry(sessionId: string, folder: Uri, folderKind: 'worktree' | 'folder'): void {
		if (!this._byId.get(sessionId)) {
			this._byId.set(sessionId, { folder, folderKind });
		}
		const folderEntry = this._byFolder.get(folder) ?? new Set<string>();
		folderEntry.add(sessionId);
		this._byFolder.set(folder, folderEntry);
	}

	deleteEntry(sessionId: string): void {
		const entry = this._byId.get(sessionId);
		if (!entry) {
			return;
		}
		const folderEntry = this._byFolder.get(entry.folder);
		this._byId.delete(sessionId);
		if (!folderEntry) {
			return;
		}
		folderEntry.delete(sessionId);
		if (folderEntry.size === 0) {
			this._byFolder.delete(entry.folder);
		}
	}

	clear(): void {
		this._byId.clear();
		this._byFolder.clear();
	}
}
