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

export interface IAgentSessionsFilter {
	readonly providers: readonly string[];
	readonly states: readonly AgentSessionStatus[];
	readonly archived: boolean;
	readonly read: boolean;
}

export const DEFAULT_FILTER: IAgentSessionsFilter = Object.freeze({
	providers: [] as const,
	states: [] as const,
	archived: true as const /* archived are never excluded but toggle between expanded and collapsed */,
	read: false as const,
});

export interface IAgentSessionsViewerService {

	readonly _serviceBrand: undefined;

	/**
	 * Event that fires when the filter changes^.
	 */
	readonly onDidChangeFilter: Event<void>;

	/**
	 * Get the current filter.
	 */
	getFilter(): IAgentSessionsFilter;

	/**
	 * Set the filter.
	 */
	setFilter(filter: IAgentSessionsFilter): void;

	/**
	 * Reset the filter to the default.
	 */
	resetFilter(): void;

	/**
	 * Check if the current filter is the default.
	 */
	isDefaultFilter(): boolean;

	/**
	 * Check if a session should be excluded based on the current filter.
	 * This only applies the core filtering logic (read, provider, status).
	 */
	filter(session: IAgentSession): boolean;
}

export class AgentSessionsViewerService extends Disposable implements IAgentSessionsViewerService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this.loadFilter(false);
		this.registerListeners();
	}

	private static readonly STORAGE_KEY = 'agentSessions.filterExcludes.agentsessionsviewerfiltersubmenu';

	private readonly _onDidChangeFilter = this._register(new Emitter<void>());
	readonly onDidChangeFilter = this._onDidChangeFilter.event;

	private currentFilter = DEFAULT_FILTER;
	private isStoringFilter = false;

	private registerListeners(): void {
		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, AgentSessionsViewerService.STORAGE_KEY, this._store)(() => this.loadFilter(true)));
	}

	private loadFilter(fromEvent: boolean): void {
		if (!this.isStoringFilter) {
			const filterRaw = this.storageService.get(AgentSessionsViewerService.STORAGE_KEY, StorageScope.PROFILE);
			if (filterRaw) {
				try {
					this.currentFilter = JSON.parse(filterRaw) as IAgentSessionsFilter;
				} catch {
					this.currentFilter = { ...DEFAULT_FILTER };
				}
			} else {
				this.currentFilter = { ...DEFAULT_FILTER };
			}
		}

		if (fromEvent) {
			this._onDidChangeFilter.fire();
		}
	}

	getFilter(): IAgentSessionsFilter {
		return this.currentFilter;
	}

	setFilter(filter: IAgentSessionsFilter): void {
		if (equals(this.currentFilter, filter)) {
			return;
		}

		this.currentFilter = filter;

		// Set guard before storage operation to prevent our own listener from
		// re-triggering loadFilterExcludes
		this.isStoringFilter = true;
		try {
			if (equals(this.currentFilter, DEFAULT_FILTER)) {
				this.storageService.remove(AgentSessionsViewerService.STORAGE_KEY, StorageScope.PROFILE);
			} else {
				this.storageService.store(AgentSessionsViewerService.STORAGE_KEY, JSON.stringify(this.currentFilter), StorageScope.PROFILE, StorageTarget.USER);
			}
		} finally {
			this.isStoringFilter = false;
		}

		this._onDidChangeFilter.fire();
	}

	resetFilter(): void {
		this.setFilter({ ...DEFAULT_FILTER });
	}

	isDefaultFilter(): boolean {
		return equals(this.currentFilter, DEFAULT_FILTER);
	}

	filter(session: IAgentSession): boolean {
		if (this.currentFilter.read && session.isRead()) {
			return true;
		}

		if (this.currentFilter.providers.includes(session.providerType)) {
			return true;
		}

		if (this.currentFilter.states.includes(session.status)) {
			return true;
		}

		return false;
	}
}

export const IAgentSessionsViewerService = createDecorator<IAgentSessionsViewerService>('agentSessionsViewerService');
