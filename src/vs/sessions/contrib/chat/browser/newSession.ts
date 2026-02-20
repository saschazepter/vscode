/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { isEqual } from '../../../../base/common/resources.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatSessionProviderOptionItem, IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { IsolationMode } from './sessionTargetPicker.js';
import { IActiveSessionItem } from '../../sessions/browser/sessionsManagementService.js';

/**
 * A new session represents a session being configured before the first
 * request is sent. It holds the user's selections (repoUri, isolationMode)
 * and fires a single event when any property changes.
 */
export interface INewSession {
	readonly resource: URI;
	readonly activeSessionItem: IActiveSessionItem;
	readonly repoUri: URI | undefined;
	readonly isolationMode: IsolationMode;
	readonly branch: string | undefined;
	readonly onDidChange: Event<void>;
	setRepoUri(uri: URI): void;
	setIsolationMode(mode: IsolationMode): void;
	setBranch(branch: string | undefined): void;
	setOption(optionId: string, value: IChatSessionProviderOptionItem): void;
}

const REPOSITORY_OPTION_ID = 'repository';
const BRANCH_OPTION_ID = 'branch';
const ISOLATION_OPTION_ID = 'isolation';

/**
 * Local new session for Background agent sessions.
 * Fires `onDidChange` for both `repoUri` and `isolationMode` changes.
 * Notifies the extension service with session options for each property change.
 */
export class LocalNewSession extends Disposable implements INewSession {

	private _repoUri: URI | undefined;
	private _isolationMode: IsolationMode = 'worktree';
	private _branch: string | undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	get resource(): URI { return this.activeSessionItem.resource; }
	get repoUri(): URI | undefined { return this._repoUri; }
	get isolationMode(): IsolationMode { return this._isolationMode; }
	get branch(): string | undefined { return this._branch; }

	constructor(
		readonly activeSessionItem: IActiveSessionItem,
		defaultRepoUri: URI | undefined,
		private readonly chatSessionsService: IChatSessionsService,
		private readonly logService: ILogService,
	) {
		super();
		this._repoUri = defaultRepoUri;
	}

	setRepoUri(uri: URI): void {
		this._repoUri = uri;
		this._onDidChange.fire();
		this._notifyOptionChange(REPOSITORY_OPTION_ID, uri.fsPath);
	}

	setIsolationMode(mode: IsolationMode): void {
		if (this._isolationMode !== mode) {
			this._isolationMode = mode;
			this._onDidChange.fire();
			this._notifyOptionChange(ISOLATION_OPTION_ID, mode);
		}
	}

	setBranch(branch: string | undefined): void {
		if (this._branch !== branch) {
			this._branch = branch;
			this._onDidChange.fire();
			this._notifyOptionChange(BRANCH_OPTION_ID, branch ?? '');
		}
	}

	setOption(_optionId: string, _value: IChatSessionProviderOptionItem): void {
		// No-op for local sessions
	}

	private _notifyOptionChange(optionId: string, value: string): void {
		this.chatSessionsService.notifySessionOptionsChange(
			this.resource,
			[{ optionId, value }]
		).catch((err) => this.logService.error(`Failed to notify session option ${optionId} change:`, err));
	}
}

/**
 * Remote new session for Cloud agent sessions.
 * Fires `onDidChange` and notifies the extension service when `repoUri` changes.
 * Ignores `isolationMode` (not relevant for cloud).
 */
export class RemoteNewSession extends Disposable implements INewSession {

	private _repoUri: URI | undefined;
	private _isolationMode: IsolationMode = 'worktree';

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	get resource(): URI { return this.activeSessionItem.resource; }
	get repoUri(): URI | undefined { return this._repoUri; }
	get isolationMode(): IsolationMode { return this._isolationMode; }
	get branch(): string | undefined { return undefined; }

	constructor(
		readonly activeSessionItem: IActiveSessionItem,
		private readonly chatSessionsService: IChatSessionsService,
		private readonly logService: ILogService,
	) {
		super();

		// Listen for extension-driven option group and session option changes
		this._register(this.chatSessionsService.onDidChangeOptionGroups(() => {
			this._onDidChange.fire();
		}));
		this._register(this.chatSessionsService.onDidChangeSessionOptions((e: URI | undefined) => {
			if (isEqual(this.resource, e)) {
				this._onDidChange.fire();
			}
		}));
	}

	setRepoUri(uri: URI): void {
		this._repoUri = uri;
		this._onDidChange.fire();
		this.chatSessionsService.notifySessionOptionsChange(
			this.resource,
			[{ optionId: 'repository', value: uri.fsPath }]
		).catch((err) => this.logService.error('Failed to notify extension of repo change:', err));
	}

	setIsolationMode(_mode: IsolationMode): void {
		// No-op for remote sessions — isolation mode is not relevant
	}

	setBranch(_branch: string | undefined): void {
		// No-op for remote sessions — branch is not relevant
	}

	setOption(optionId: string, value: IChatSessionProviderOptionItem): void {
		this._onDidChange.fire();
		this.chatSessionsService.notifySessionOptionsChange(
			this.resource,
			[{ optionId, value }]
		).catch((err) => this.logService.error(`Failed to notify extension of ${optionId} change:`, err));
	}
}
