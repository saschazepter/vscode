/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { equals } from '../../../../../base/common/objects.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { AgentSessionStatus, IAgentSession } from './agentSessionsModel.js';

export interface IAgentSessionsFilterExcludes {
	readonly providers: readonly string[];
	readonly states: readonly AgentSessionStatus[];
	readonly archived: boolean;
	readonly read: boolean;
}

export const DEFAULT_FILTER_EXCLUDES: IAgentSessionsFilterExcludes = Object.freeze({
	providers: [] as const,
	states: [] as const,
	archived: true as const /* archived are never excluded but toggle between expanded and collapsed */,
	read: false as const,
});

export interface IAgentSessionsViewerService {

	readonly _serviceBrand: undefined;

	/**
	 * Event that fires when the filter excludes change.
	 */
	readonly onDidChangeFilterExcludes: Event<void>;

	/**
	 * Get the current filter excludes.
	 */
	getFilterExcludes(): IAgentSessionsFilterExcludes;

	/**
	 * Set the filter excludes.
	 */
	setFilterExcludes(excludes: IAgentSessionsFilterExcludes): void;

	/**
	 * Reset the filter excludes to the default.
	 */
	resetFilterExcludes(): void;

	/**
	 * Check if the current filter excludes are the default.
	 */
	isDefaultFilterExcludes(): boolean;

	/**
	 * Check if a session should be excluded based on the current filter excludes.
	 * This only applies the core filtering logic (read, provider, status).
	 */
	excludeSession(session: IAgentSession): boolean;
}

export class AgentSessionsViewerService extends Disposable implements IAgentSessionsViewerService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this.loadFilterExcludes(false);
		this.registerListeners();
	}

	private static readonly STORAGE_KEY = 'agentSessions.filterExcludes.agentsessionsviewerfiltersubmenu';

	private readonly _onDidChangeFilterExcludes = this._register(new Emitter<void>());
	readonly onDidChangeFilterExcludes = this._onDidChangeFilterExcludes.event;

	private filterExcludes = DEFAULT_FILTER_EXCLUDES;
	private isStoringExcludes = false;

	private registerListeners(): void {
		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, AgentSessionsViewerService.STORAGE_KEY, this._store)(() => this.loadFilterExcludes(true)));
	}

	private loadFilterExcludes(fromEvent: boolean): void {
		if (!this.isStoringExcludes) {
			const excludesRaw = this.storageService.get(AgentSessionsViewerService.STORAGE_KEY, StorageScope.PROFILE);
			if (excludesRaw) {
				try {
					this.filterExcludes = JSON.parse(excludesRaw) as IAgentSessionsFilterExcludes;
				} catch {
					this.filterExcludes = { ...DEFAULT_FILTER_EXCLUDES };
				}
			} else {
				this.filterExcludes = { ...DEFAULT_FILTER_EXCLUDES };
			}
		}

		if (fromEvent) {
			this._onDidChangeFilterExcludes.fire();
		}
	}

	getFilterExcludes(): IAgentSessionsFilterExcludes {
		return this.filterExcludes;
	}

	setFilterExcludes(excludes: IAgentSessionsFilterExcludes): void {
		if (equals(this.filterExcludes, excludes)) {
			return;
		}

		this.filterExcludes = excludes;

		// Set guard before storage operation to prevent our own listener from
		// re-triggering loadFilterExcludes
		this.isStoringExcludes = true;
		try {
			if (equals(this.filterExcludes, DEFAULT_FILTER_EXCLUDES)) {
				this.storageService.remove(AgentSessionsViewerService.STORAGE_KEY, StorageScope.PROFILE);
			} else {
				this.storageService.store(AgentSessionsViewerService.STORAGE_KEY, JSON.stringify(this.filterExcludes), StorageScope.PROFILE, StorageTarget.USER);
			}
		} finally {
			this.isStoringExcludes = false;
		}

		this._onDidChangeFilterExcludes.fire();
	}

	resetFilterExcludes(): void {
		this.setFilterExcludes({ ...DEFAULT_FILTER_EXCLUDES });
	}

	isDefaultFilterExcludes(): boolean {
		return equals(this.filterExcludes, DEFAULT_FILTER_EXCLUDES);
	}

	excludeSession(session: IAgentSession): boolean {
		const excludes = this.filterExcludes;

		if (excludes.read && session.isRead()) {
			return true;
		}

		if (excludes.providers.includes(session.providerType)) {
			return true;
		}

		if (excludes.states.includes(session.status)) {
			return true;
		}

		return false;
	}
}

export const IAgentSessionsViewerService = createDecorator<IAgentSessionsViewerService>('agentSessionsViewerService');
