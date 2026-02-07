/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';

/**
 * CDP error codes following JSON-RPC 2.0 conventions
 */
export const CDPErrorCode = {
	/** Method not found */
	MethodNotFound: -32601,
	/** Invalid params */
	InvalidParams: -32602,
	/** Internal error */
	InternalError: -32603,
	/** Server error (generic) */
	ServerError: -32000,
} as const;

/**
 * Base CDP error class with error code
 */
export class CDPError extends Error {
	constructor(
		message: string,
		readonly code: number
	) {
		super(message);
		this.name = 'CDPError';
	}
}

/**
 * Error thrown when a CDP method is not found
 */
export class CDPMethodNotFoundError extends CDPError {
	constructor(method: string) {
		super(`Method not found: ${method}`, CDPErrorCode.MethodNotFound);
		this.name = 'CDPMethodNotFoundError';
	}
}

/**
 * Error thrown when CDP params are invalid
 */
export class CDPInvalidParamsError extends CDPError {
	constructor(message: string) {
		super(message, CDPErrorCode.InvalidParams);
		this.name = 'CDPInvalidParamsError';
	}
}

/**
 * Error thrown for internal CDP errors
 */
export class CDPInternalError extends CDPError {
	constructor(message: string) {
		super(message, CDPErrorCode.InternalError);
		this.name = 'CDPInternalError';
	}
}

/**
 * Error thrown for generic CDP server errors
 */
export class CDPServerError extends CDPError {
	constructor(message: string) {
		super(message, CDPErrorCode.ServerError);
		this.name = 'CDPServerError';
	}
}

/**
 * CDP message types
 */
export interface CDPRequest {
	id: number;
	method: string;
	params?: unknown;
	sessionId?: string;
}

export interface CDPResponse {
	id: number;
	result?: unknown;
	error?: { code: number; message: string };
	sessionId?: string;
}

export interface CDPEvent {
	method: string;
	params: unknown;
	sessionId?: string;
}

export interface CDPTargetInfo {
	targetId: string;
	type: string;
	title: string;
	url: string;
	attached: boolean;
	canAccessOpener: boolean;
	browserContextId?: string;
}

/**
 * Connection context pre-filled based on the WebSocket URL path.
 * - /devtools/browser/<id> - Browser-level connection, can create/manage targets
 * - /devtools/page/<targetId> - Direct page connection, immediately attached to a specific target
 * - / - Root connection, needs to explicitly attach
 */
export interface CDPConnectionContext {
	/** Whether this is a browser-level connection */
	browserAttached: boolean;
	/** Whether this is a direct page connection */
	pageAttached: boolean;
	/** The target ID (for page connections, this is the specific target; for browser, it's the first available) */
	targetId: string;
}

/**
 * CDP command with callbacks for response handling.
 * Emitted by client, consumed by target.
 */
export interface CDPCommand {
	method: string;
	params?: unknown;
	/** Call with the result on success */
	resolve(result: unknown): void;
	/** Call with an error on failure */
	reject(error: Error): void;
}

/**
 * A debuggable CDP target (e.g., a browser view).
 * Targets can be attached to by CDP clients.
 */
export interface ICDPTarget {
	/** Get target info for CDP protocol. Initializes the target if needed. */
	getTargetInfo(): Promise<CDPTargetInfo>;
	/** Attach a client to receive events and send commands. Initializes if needed. Dispose to detach. */
	attach(client: ICDPClient): Promise<IDisposable>;
}

/**
 * CDP client interface for communication with a target.
 * The proxy implements this to act as a client to targets.
 * Targets subscribe to onCommand during attach and call handleEvent for events.
 */
export interface ICDPClient {
	/** Event fired when client wants to send a CDP command to the target */
	readonly onCommand: Event<CDPCommand>;

	/** Called when the target sends an event to the client */
	handleEvent(event: CDPEvent): void;
}

/**
 * Service interface for managing CDP targets and browser contexts.
 */
export interface ICDPTargetService {
	/** Event fired when a target is created */
	readonly onTargetCreated: Event<ICDPTarget>;
	/** Event fired when a target is about to be destroyed */
	readonly onTargetDestroyed: Event<ICDPTarget>;

	/** Get all available targets */
	getTargets(): IterableIterator<ICDPTarget>;
	/** Create a new target in the specified browser context */
	createTarget(url: string, browserContextId?: string): Promise<ICDPTarget>;
	/** Close a target */
	closeTarget(targetId: string): Promise<boolean>;

	// Browser context management
	/** Get all browser context IDs */
	getBrowserContexts(): string[];
	/** Create a new isolated browser context */
	createBrowserContext(): Promise<string>;
	/** Dispose a browser context and all its targets */
	disposeBrowserContext(browserContextId: string): Promise<void>;
}

/**
 * CDP server interface for external consumers (debuggers, extensions).
 * The proxy implements this to serve CDP to external clients.
 */
export interface ICDPServer extends IDisposable {
	/** Event fired when the server receives a CDP event from targets */
	readonly onEvent: Event<CDPEvent>;
	/** Event fired when the server wants to close the connection */
	readonly onClose: Event<void>;

	/**
	 * Send a CDP message and await the result.
	 * @param method The CDP method to call
	 * @param params Optional parameters for the method
	 * @param sessionId Optional session ID for targeting a specific session
	 * @returns Promise resolving to the result or rejecting with a CDPError
	 */
	sendMessage(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
}
