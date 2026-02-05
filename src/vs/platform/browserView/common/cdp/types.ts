/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
 * Result from a CDP domain method handler
 */
export interface CDPMethodResult {
	/** The result to send back to the client */
	result?: unknown;
	/** Error to send back (if any) */
	error?: { code: number; message: string };
}

import type { CDPSession } from './cdpSession.js';
import type { DebugTarget } from './debugTarget.js';

/**
 * Service interface for CDP operations
 */
export interface ICDPService {
	/** Get all target infos for CDP protocol */
	getAllTargetInfos(): CDPTargetInfo[];
	/** Get a target by ID */
	getTarget(targetId: string): DebugTarget | undefined;
	/** Get the first available target ID */
	getFirstTargetId(): string | undefined;
	/** Create a new target (optional) */
	createTarget?(url: string): Promise<{ targetId: string }>;
	/** Close a target (optional) */
	closeTarget?(targetId: string): Promise<boolean>;
}

/**
 * Client interface for CDP operations
 */
export interface ICDPClient {
	/** Get the CDP session */
	getSession(): CDPSession;
	/** Send a CDP event to the client */
	sendEvent(method: string, params: unknown, sessionId?: string): void;
	/** Attach to a page target (returns session ID) */
	attachToPageTarget(targetId: string, target: DebugTarget): string;
}

/**
 * Context passed to CDP domain method handlers
 */
export interface CDPMethodContext {
	/** Session ID from the request */
	sessionId?: string;
	/** The CDP client */
	client: ICDPClient;
	/** The CDP service */
	service: ICDPService;
}
