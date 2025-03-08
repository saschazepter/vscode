/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assertNever } from '../../../../base/common/assert.js';
import { IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { Location } from '../../../../editor/common/languages.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { McpServerRequestHandler } from './mcpServerRequestHandler.js';

/**
 * An McpCollection contains McpServers. There may be multiple collections for
 * different locations servers are discovered.
 */
export interface IMcpCollectionDefinition {
	/** Origin authority from which this collection was discovered. */
	readonly remoteAuthority: string | null;
	/** Globally-unique, stable ID for this definition */
	readonly id: string;
	/** Human-readable label for the definition */
	readonly label: string;
	/** Definitions this collection contains. */
	readonly serverDefinitions: IObservable<readonly IMcpServerDefinition[]>;
	/** If 'false', consent is required before any MCP servers in this collection are automatically launched. */
	readonly isTrustedByDefault: boolean;
	/** Callback to let the user configure the definition. */
	configure(): void;
}

export interface IMcpServerDefinition {
	/** Globally-unique, stable ID for this definition */
	readonly id: string;
	/** Human-readable label for the definition */
	readonly label: string;
	/** Location where this server can be configured */
	readonly location: Location;
	/** Descriptor defining how the configuration should be launched. */
	readonly launch: McpServerLaunch;
	/** If set, allows configuration variables to be resolved in the {@link launch} with the given context */
	readonly variableReplacement?: {
		section?: string; // e.g. 'mcp'
		folder?: IWorkspaceFolder;
		target?: ConfigurationTarget;
	};
}

export const enum McpServerTransportType {
	/** A command-line MCP server */
	CommandLine = 1 << 0,
	/** An MCP server that uses Server-Sent Events */
	SSE = 1 << 1,
}

/**
 * MCP server launched on the command line which communicated over stdio.
 * https://spec.modelcontextprotocol.io/specification/2024-11-05/basic/transports/#stdio
 */
export interface McpServerTransportStdio {
	readonly type: McpServerTransportType.CommandLine;
	readonly cwd: URI;
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Record<string, string | number | null>;
}

/**
 * MCP server launched on the command line which communicated over server-sent-events.
 * https://spec.modelcontextprotocol.io/specification/2024-11-05/basic/transports/#http-with-sse
 */
export interface McpServerTransportSSE {
	readonly type: McpServerTransportType.SSE;
	readonly url: string;
}

export type McpServerLaunch =
	| McpServerTransportStdio
	| McpServerTransportSSE;

/**
 * An instance that manages a connection to an MCP server. It can be started,
 * stopped, and restarted. Once started and in a running state, it will
 * eventually build a {@link IMcpServerConnection.connection}.
 */
export interface IMcpServerConnection {
	readonly definition: IMcpServerDefinition;
	readonly state: IObservable<McpConnectionState>;
	readonly connection: IObservable<McpServerRequestHandler | undefined>;

	/**
	 * Shows the current server output.
	 */
	showOutput(): void;

	/**
	 * Starts the server if it's stopped. Returns a promise that resolves once
	 * server exits a 'starting' state.
	 */
	start(): Promise<McpConnectionState>;

	/**
	 * Stops the server.
	 */
	stop(): Promise<void>;
}

/**
 * McpConnectionState is the state of the underlying connection and is
 * communicated e.g. from the extension host to the renderer.
 */
export namespace McpConnectionState {
	export const enum Kind {
		Stopped,
		Starting,
		Running,
		Error,
	}

	export const toString = (s: McpConnectionState): string => {
		switch (s.state) {
			case Kind.Stopped:
				return 'Stopped';
			case Kind.Starting:
				return 'Starting';
			case Kind.Running:
				return 'Running';
			case Kind.Error:
				return `Error ${s.message}`;
			default:
				assertNever(s);
		}
	};

	/** Returns if the MCP state is one where starting a new server is valid */
	export const canBeStarted = (s: Kind) => s === Kind.Error || s === Kind.Stopped;

	export interface Stopped {
		readonly state: Kind.Stopped;
	}

	export interface Starting {
		readonly state: Kind.Starting;
	}

	export interface Running {
		readonly state: Kind.Running;
	}

	export interface Error {
		readonly state: Kind.Error;
		readonly message: string;
	}
}

export type McpConnectionState =
	| McpConnectionState.Stopped
	| McpConnectionState.Starting
	| McpConnectionState.Running
	| McpConnectionState.Error;

export class MpcResponseError extends Error {
	constructor(message: string, public readonly code: number, public readonly data: unknown) {
		super(`MPC ${code}: ${message}`);
	}
}
