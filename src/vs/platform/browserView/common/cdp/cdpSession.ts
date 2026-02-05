/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../log/common/log.js';
import { CDPTargetInfo } from './types.js';

/**
 * Manages CDP session state for a client connection.
 * Tracks browser and page session attachments, auto-attach preferences, and discovered targets.
 */
export class CDPSession {
	/** Unique browser session ID for this client */
	readonly browserSessionId: string;

	/** Page session ID (set when attached to a page target) */
	private _pageSessionId: string = '';

	/** Whether the client is attached to the browser session */
	private _browserAttached = false;

	/** Whether the client is attached to the page session */
	private _pageAttached = false;

	/** Whether auto-attach is enabled for this session */
	private _autoAttach = false;

	/** Whether to wait for debugger on start (for auto-attach) */
	private _waitForDebuggerOnStart = false;

	/** Whether to flatten auto-attach sessions */
	private _autoAttachFlatten = false;

	/** Currently attached target ID (primary) */
	private _targetId: string = '';

	/** Whether target discovery is enabled */
	private _discoverTargets = false;

	/** Currently attached target IDs */
	private readonly _attachedTargets = new Set<string>();

	/** Discovered target infos */
	private readonly _discoveredTargets = new Map<string, CDPTargetInfo>();

	constructor(
		sessionIndex: number,
		private readonly logService: ILogService
	) {
		this.browserSessionId = `browser-session-${sessionIndex}`;
	}

	// Getters for session state
	get pageSessionId(): string {
		return this._pageSessionId;
	}

	get browserAttached(): boolean {
		return this._browserAttached;
	}

	get pageAttached(): boolean {
		return this._pageAttached;
	}

	get autoAttach(): boolean {
		return this._autoAttach;
	}

	get waitForDebuggerOnStart(): boolean {
		return this._waitForDebuggerOnStart;
	}

	get autoAttachFlatten(): boolean {
		return this._autoAttachFlatten;
	}

	/** Whether auto-attach is fully enabled (autoAttach + flatten) */
	get autoAttachEnabled(): boolean {
		return this._autoAttach && this._autoAttachFlatten;
	}

	get targetId(): string {
		return this._targetId;
	}

	set targetId(value: string) {
		this._targetId = value;
	}

	get discoverTargets(): boolean {
		return this._discoverTargets;
	}

	/**
	 * Attach to the browser session
	 */
	attachToBrowser(): void {
		this._browserAttached = true;
		this.logService.debug(`[CDPSession] Browser attached: ${this.browserSessionId}`);
	}

	/**
	 * Detach from the browser session
	 */
	detachFromBrowser(): void {
		this._browserAttached = false;
		this.logService.debug(`[CDPSession] Browser detached: ${this.browserSessionId}`);
	}

	/**
	 * Attach to a page target
	 */
	attachToPage(targetId: string): string {
		this._pageSessionId = `page-session-${targetId}`;
		this._pageAttached = true;
		this._attachedTargets.add(targetId);
		this.logService.debug(`[CDPSession] Page attached: ${this._pageSessionId} (target: ${targetId})`);
		return this._pageSessionId;
	}

	/**
	 * Detach from a page target
	 */
	detachFromPage(targetId: string): void {
		if (this._attachedTargets.has(targetId)) {
			this._attachedTargets.delete(targetId);
			if (this._pageSessionId === `page-session-${targetId}`) {
				this._pageAttached = false;
				this._pageSessionId = '';
				this.logService.debug(`[CDPSession] Page detached: ${targetId}`);
			}
		}
	}

	/**
	 * Check if attached to a specific target
	 */
	isAttachedToTarget(targetId: string): boolean {
		return this._attachedTargets.has(targetId);
	}

	/**
	 * Enable auto-attach with specified settings
	 */
	enableAutoAttach(waitForDebuggerOnStart: boolean, flatten: boolean): void {
		this._autoAttach = true;
		this._waitForDebuggerOnStart = waitForDebuggerOnStart;
		this._autoAttachFlatten = flatten;
		this.logService.debug(`[CDPSession] Auto-attach enabled (waitForDebugger: ${waitForDebuggerOnStart}, flatten: ${flatten})`);
	}

	/**
	 * Disable auto-attach
	 */
	disableAutoAttach(): void {
		this._autoAttach = false;
		this._waitForDebuggerOnStart = false;
		this._autoAttachFlatten = false;
		this.logService.debug(`[CDPSession] Auto-attach disabled`);
	}

	/**
	 * Enable target discovery
	 */
	enableTargetDiscovery(): void {
		this._discoverTargets = true;
		this.logService.debug(`[CDPSession] Target discovery enabled`);
	}

	/**
	 * Disable target discovery
	 */
	disableTargetDiscovery(): void {
		this._discoverTargets = false;
		this.logService.debug(`[CDPSession] Target discovery disabled`);
	}

	/**
	 * Add a discovered target
	 */
	addDiscoveredTarget(targetInfo: CDPTargetInfo): void {
		this._discoveredTargets.set(targetInfo.targetId, targetInfo);
	}

	/**
	 * Remove a discovered target
	 */
	removeDiscoveredTarget(targetId: string): void {
		this._discoveredTargets.delete(targetId);
	}

	/**
	 * Get all discovered targets
	 */
	getDiscoveredTargets(): CDPTargetInfo[] {
		return Array.from(this._discoveredTargets.values());
	}

	/**
	 * Clear all discovered targets
	 */
	clearDiscoveredTargets(): void {
		this._discoveredTargets.clear();
	}

	/**
	 * Get all attached target IDs
	 */
	getAttachedTargetIds(): string[] {
		return Array.from(this._attachedTargets);
	}

	/**
	 * Reset session state (on disconnect/reconnect)
	 */
	reset(): void {
		this._browserAttached = false;
		this._pageAttached = false;
		this._pageSessionId = '';
		this._targetId = '';
		this._autoAttach = false;
		this._waitForDebuggerOnStart = false;
		this._autoAttachFlatten = false;
		this._discoverTargets = false;
		this._attachedTargets.clear();
		this._discoveredTargets.clear();
		this.logService.debug(`[CDPSession] Session reset: ${this.browserSessionId}`);
	}
}
