/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';

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
 * Platform-agnostic debugger target interface.
 * Used by the proxy to interact with targets without Electron dependencies.
 */
export interface ICDPDebugTarget {
	/** Get target info for CDP protocol using internal browser view ID */
	getTargetInfo(): CDPTargetInfo;
	/** Attach a client to receive events and send commands. Dispose to detach. */
	attach(client: ICDPDebuggerClient): Promise<IDisposable>;
}

/**
 * Client interface for CDP communication with a target.
 * The target subscribes to onCommand during attach and calls handleDebuggerEvent for events.
 */
export interface ICDPDebuggerClient {
	/** Event fired when client wants to send a CDP command to the target */
	readonly onCommand: Event<CDPCommand>;

	/** Called when the debugger receives an event from Electron */
	handleEvent(event: CDPEvent): void;
}

/**
 * Service interface for CDP operations.
 * Provides target management capabilities to domain handlers.
 */
export interface ICDPService {
	/** Event fired when a target is created */
	readonly onTargetCreated: Event<ICDPDebugTarget>;
	/** Event fired when a target is destroyed */
	readonly onTargetDestroyed: Event<string>;

	/** Get a target by ID */
	getTarget(targetId: string): ICDPDebugTarget | undefined;
	/** Get all available targets */
	getTargets(): IterableIterator<ICDPDebugTarget>;
	/** Create a new target */
	createTarget(url: string): Promise<{ targetId: string }>;
	/** Close a target */
	closeTarget(targetId: string): Promise<boolean>;
}
