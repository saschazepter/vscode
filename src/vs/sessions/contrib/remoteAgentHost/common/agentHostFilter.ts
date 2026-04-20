/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Sentinel value meaning "no filter — show sessions from all hosts".
 */
export const ALL_HOSTS_FILTER = '__all__';

/**
 * Connection status of a host surfaced in the host filter.
 */
export const enum AgentHostFilterConnectionStatus {
	Disconnected = 'disconnected',
	Connecting = 'connecting',
	Connected = 'connected',
}

/**
 * A single host entry the user can scope the sessions list to.
 */
export interface IAgentHostFilterEntry {
	/** The {@link ISession.providerId} of the host — stable filter key. */
	readonly providerId: string;
	/** Display name for the host. */
	readonly label: string;
	/** The raw host address (e.g. `localhost:4321`, `tunnel+abc123`). */
	readonly address: string;
	/** Current connection status for this host. */
	readonly status: AgentHostFilterConnectionStatus;
}

export const IAgentHostFilterService = createDecorator<IAgentHostFilterService>('agentHostFilterService');

/**
 * Tracks the currently selected agent host used to scope the sessions list
 * and other workbench surfaces. A selection of {@link ALL_HOSTS_FILTER}
 * means "all hosts"; any other value is the {@link ISession.providerId}
 * of the selected remote agent host.
 */
export interface IAgentHostFilterService {
	readonly _serviceBrand: undefined;

	/** Fires when {@link selectedProviderId} or {@link hosts} changes. */
	readonly onDidChange: Event<void>;

	/** The currently selected providerId, or {@link ALL_HOSTS_FILTER}. */
	readonly selectedProviderId: string;

	/** All known hosts the user can switch between. */
	readonly hosts: readonly IAgentHostFilterEntry[];

	/**
	 * Update the selection. If `providerId` is not {@link ALL_HOSTS_FILTER}
	 * and no matching host exists, the selection is cleared to
	 * {@link ALL_HOSTS_FILTER}.
	 */
	setSelectedProviderId(providerId: string): void;

	/**
	 * Attempt to (re)connect to the given host. No-op if the host is
	 * unknown or already {@link AgentHostFilterConnectionStatus.Connected}
	 * or {@link AgentHostFilterConnectionStatus.Connecting}.
	 */
	reconnect(providerId: string): void;
}
