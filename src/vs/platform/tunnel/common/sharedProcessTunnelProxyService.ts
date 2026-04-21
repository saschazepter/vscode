/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IAddress } from '../../remote/common/remoteAgentConnection.js';

export const ISharedProcessTunnelProxyService = createDecorator<ISharedProcessTunnelProxyService>('sharedProcessTunnelProxyService');

export const ipcSharedProcessTunnelProxyChannelName = 'sharedProcessTunnelProxy';

/**
 * A service running in the shared process that manages a SOCKS5 proxy
 * server.  The proxy routes TCP connections through the remote agent
 * tunnel, making the remote network transparently accessible to consumers
 * that support SOCKS proxies (e.g. Electron sessions via `session.setProxy()`).
 */
export interface ISharedProcessTunnelProxyService {
	readonly _serviceBrand: undefined;

	/**
	 * Start the tunnel proxy for the given remote authority. Returns the proxy URL.
	 */
	start(authority: string): Promise<string>;

	/**
	 * Set the remote address info for the proxy for the given authority.
	 * Should be called whenever the resolver resolves.
	 */
	setAddress(authority: string, address: IAddress): Promise<void>;

	/**
	 * Release one reference to the proxy for the given authority.
	 * The proxy is stopped when the last reference is released.
	 */
	stop(authority: string): Promise<void>;
}
