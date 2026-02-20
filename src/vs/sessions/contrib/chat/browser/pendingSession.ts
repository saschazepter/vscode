/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatSessionsService } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { IsolationMode } from './sessionTargetPicker.js';

/**
 * A pending session represents a session being configured before the first
 * request is sent. It holds the user's selections (repoUri, isolationMode)
 * and fires a single event when any property changes.
 */
export interface IPendingSession {
	readonly resource: URI;
	readonly repoUri: URI | undefined;
	readonly isolationMode: IsolationMode;
	readonly onDidChange: Event<void>;
	setRepoUri(uri: URI): void;
	setIsolationMode(mode: IsolationMode): void;
}

/**
 * Local pending session for Background agent sessions.
 * Fires `onDidChange` for both `repoUri` and `isolationMode` changes.
 * Does not notify the extension service.
 */
export class LocalPendingSession extends Disposable implements IPendingSession {

	private _repoUri: URI | undefined;
	private _isolationMode: IsolationMode = 'worktree';

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	get repoUri(): URI | undefined { return this._repoUri; }
	get isolationMode(): IsolationMode { return this._isolationMode; }

	constructor(
		readonly resource: URI,
		defaultRepoUri: URI | undefined,
	) {
		super();
		this._repoUri = defaultRepoUri;
	}

	setRepoUri(uri: URI): void {
		this._repoUri = uri;
		this._onDidChange.fire();
	}

	setIsolationMode(mode: IsolationMode): void {
		if (this._isolationMode !== mode) {
			this._isolationMode = mode;
			this._onDidChange.fire();
		}
	}
}

/**
 * Remote pending session for Cloud agent sessions.
 * Fires `onDidChange` and notifies the extension service when `repoUri` changes.
 * Ignores `isolationMode` (not relevant for cloud).
 */
export class RemotePendingSession extends Disposable implements IPendingSession {

	private _repoUri: URI | undefined;
	private _isolationMode: IsolationMode = 'worktree';

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	get repoUri(): URI | undefined { return this._repoUri; }
	get isolationMode(): IsolationMode { return this._isolationMode; }

	constructor(
		readonly resource: URI,
		private readonly chatSessionsService: IChatSessionsService,
		private readonly logService: ILogService,
	) {
		super();
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
}
