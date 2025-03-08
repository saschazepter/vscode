/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IObservable } from '../../../../base/common/observable.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMcpCollectionDefinition, IMcpServerDefinition, McpServerLaunch, McpConnectionState, IMcpServerConnection } from './mcpTypes.js';
import { MCP } from './modelContextProtocol.js';

export const IMcpRegistry = createDecorator<IMcpRegistry>('mcpRegistry');

/** Message transport to a single MCP server. */
export interface IMcpMessageTransport extends IDisposable {
	readonly state: IObservable<McpConnectionState>;
	readonly onDidLog: Event<string>;
	readonly onDidReceiveMessage: Event<MCP.JSONRPCMessage>;
	send(message: MCP.JSONRPCMessage): void;
	stop(): void;
}

export interface IMcpHostDelegate {
	canStart(collectionDefinition: IMcpCollectionDefinition, serverDefinition: IMcpServerDefinition): boolean;
	start(collectionDefinition: IMcpCollectionDefinition, serverDefinition: IMcpServerDefinition, resolvedLaunch: McpServerLaunch): IMcpMessageTransport;
}

export interface IMcpRegistry {
	readonly _serviceBrand: undefined;

	readonly collections: IObservable<readonly IMcpCollectionDefinition[]>;
	readonly delegates: readonly IMcpHostDelegate[];

	registerDelegate(delegate: IMcpHostDelegate): IDisposable;
	registerCollection(collection: IMcpCollectionDefinition): IDisposable;

	/** Gets whether there are saved inputs used to resolve the connection */
	hasSavedInputs(collection: IMcpCollectionDefinition, definition: IMcpServerDefinition): boolean;
	/** Resets any saved inputs for the connection. */
	clearSavedInputs(collection: IMcpCollectionDefinition, definition: IMcpServerDefinition): void;
	/** Createse a connection for the collection and definition. */
	resolveConnection(collection: IMcpCollectionDefinition, definition: IMcpServerDefinition): Promise<IMcpServerConnection>;
}
