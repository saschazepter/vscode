/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { agentHostAuthority } from '../../../../platform/agentHost/common/agentHostUri.js';
import { getEntryAddress, IRemoteAgentHostService, RemoteAgentHostConnectionStatus } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { AgentHostFilterConnectionStatus, IAgentHostFilterEntry, IAgentHostFilterService } from '../common/agentHostFilter.js';

const STORAGE_KEY = 'sessions.agentHostFilter.selectedProviderId';

/**
 * Stable providerId format used by {@link RemoteAgentHostSessionsProvider}.
 */
function providerIdForAddress(address: string): string {
	return `agenthost-${agentHostAuthority(address)}`;
}

function mapStatus(s: RemoteAgentHostConnectionStatus): AgentHostFilterConnectionStatus {
	switch (s) {
		case RemoteAgentHostConnectionStatus.Connected: return AgentHostFilterConnectionStatus.Connected;
		case RemoteAgentHostConnectionStatus.Connecting: return AgentHostFilterConnectionStatus.Connecting;
		case RemoteAgentHostConnectionStatus.Disconnected:
		default: return AgentHostFilterConnectionStatus.Disconnected;
	}
}

export class AgentHostFilterService extends Disposable implements IAgentHostFilterService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _selectedProviderId: string | undefined;
	private _hosts: readonly IAgentHostFilterEntry[] = [];

	constructor(
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();

		this._selectedProviderId = this._storageService.get(STORAGE_KEY, StorageScope.PROFILE, undefined);
		this._recomputeHosts();

		this._register(this._remoteAgentHostService.onDidChangeConnections(() => this._recomputeHosts()));
	}

	get selectedProviderId(): string | undefined {
		return this._selectedProviderId;
	}

	get hosts(): readonly IAgentHostFilterEntry[] {
		return this._hosts;
	}

	setSelectedProviderId(providerId: string): void {
		if (!this._hosts.some(h => h.providerId === providerId)) {
			return;
		}
		if (providerId === this._selectedProviderId) {
			return;
		}
		this._selectedProviderId = providerId;
		this._persist();
		this._onDidChange.fire();
	}

	reconnect(providerId: string): void {
		const host = this._hosts.find(h => h.providerId === providerId);
		if (!host) {
			return;
		}
		if (host.status !== AgentHostFilterConnectionStatus.Disconnected) {
			return;
		}
		this._remoteAgentHostService.reconnect(host.address);
	}

	private _validate(providerId: string | undefined): string | undefined {
		if (providerId !== undefined && this._hosts.some(h => h.providerId === providerId)) {
			return providerId;
		}
		return this._hosts.length > 0 ? this._hosts[0].providerId : undefined;
	}

	private _recomputeHosts(): void {
		const connections = this._remoteAgentHostService.connections;
		const entries = this._remoteAgentHostService.configuredEntries;

		const byProviderId = new Map<string, IAgentHostFilterEntry>();

		// Prefer live connection info (authoritative name + connection status).
		for (const conn of connections) {
			const providerId = providerIdForAddress(conn.address);
			byProviderId.set(providerId, {
				providerId,
				label: conn.name || conn.address,
				address: conn.address,
				status: mapStatus(conn.status),
			});
		}

		// Fill in configured entries that are not currently tracked as a
		// live connection.
		for (const entry of entries) {
			const address = getEntryAddress(entry);
			const providerId = providerIdForAddress(address);
			if (byProviderId.has(providerId)) {
				continue;
			}
			byProviderId.set(providerId, {
				providerId,
				label: entry.name || address,
				address,
				status: AgentHostFilterConnectionStatus.Disconnected,
			});
		}

		const hosts = [...byProviderId.values()].sort((a, b) => a.label.localeCompare(b.label));

		const changed = hosts.length !== this._hosts.length
			|| hosts.some((h, i) => h.providerId !== this._hosts[i].providerId
				|| h.label !== this._hosts[i].label
				|| h.status !== this._hosts[i].status);

		this._hosts = hosts;

		// Ensure selection is still valid.
		const validated = this._validate(this._selectedProviderId);
		const selectionChanged = validated !== this._selectedProviderId;
		if (selectionChanged) {
			this._selectedProviderId = validated;
			this._persist();
		}

		if (changed || selectionChanged) {
			this._onDidChange.fire();
		}
	}

	private _persist(): void {
		if (this._selectedProviderId === undefined) {
			this._storageService.remove(STORAGE_KEY, StorageScope.PROFILE);
		} else {
			this._storageService.store(STORAGE_KEY, this._selectedProviderId, StorageScope.PROFILE, StorageTarget.USER);
		}
	}
}

registerSingleton(IAgentHostFilterService, AgentHostFilterService, InstantiationType.Delayed);
