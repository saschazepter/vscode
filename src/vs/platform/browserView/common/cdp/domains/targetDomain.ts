/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerCDPDomain } from './index.js';
import { CDPMethodContext, CDPMethodResult } from '../types.js';

/**
 * Target.* CDP command handlers.
 * These are browser-level commands for target discovery and management.
 */
export namespace CDPTargetDomain {
	export function getBrowserContexts(_params: {}, _ctx: CDPMethodContext): CDPMethodResult {
		return { result: { browserContextIds: [] } };
	}

	export function attachToBrowserTarget(_params: {}, ctx: CDPMethodContext): CDPMethodResult {
		const session = ctx.client.getSession();
		session.attachToBrowser();

		// Set the initial target ID to the first available target
		const firstTargetId = ctx.service.getFirstTargetId() || 'default';
		session.targetId = firstTargetId;

		return { result: { sessionId: session.browserSessionId } };
	}

	export function setAutoAttach(params: {
		autoAttach?: boolean;
		waitForDebuggerOnStart?: boolean;
		flatten?: boolean;
	}, ctx: CDPMethodContext): CDPMethodResult {
		const session = ctx.client.getSession();

		// Store autoAttach settings in session
		const autoAttach = params?.autoAttach ?? false;
		const waitForDebuggerOnStart = params?.waitForDebuggerOnStart ?? false;
		const flatten = params?.flatten ?? false;

		if (autoAttach) {
			session.enableAutoAttach(waitForDebuggerOnStart, flatten);
		} else {
			session.disableAutoAttach();
		}

		// Only auto-attach to existing targets when called from browser session (not page session)
		const isPageSession = ctx.sessionId?.startsWith('page-session-');
		if (autoAttach && flatten && !isPageSession && !session.pageAttached) {
			setImmediate(() => {
				for (const targetInfo of ctx.service.getAllTargetInfos()) {
					// Send targetCreated first
					ctx.client.sendEvent('Target.targetCreated', { targetInfo }, ctx.sessionId);

					// Then auto-attach if not already attached
					if (!session.pageAttached) {
						const target = ctx.service.getTarget(targetInfo.targetId);
						if (target) {
							const pageSessionId = ctx.client.attachToPageTarget(targetInfo.targetId, target);

							ctx.client.sendEvent('Target.attachedToTarget', {
								sessionId: pageSessionId,
								targetInfo: { ...targetInfo, attached: true },
								waitingForDebugger: session.waitForDebuggerOnStart
							}, ctx.sessionId);
						}
					}
				}
			});
		}

		return { result: {} };
	}

	export function setDiscoverTargets(params: { discover?: boolean }, ctx: CDPMethodContext): CDPMethodResult {
		const session = ctx.client.getSession();

		if (params?.discover) {
			session.enableTargetDiscovery();
		} else {
			session.disableTargetDiscovery();
		}

		setImmediate(() => {
			for (const targetInfo of ctx.service.getAllTargetInfos()) {
				ctx.client.sendEvent('Target.targetCreated', { targetInfo }, ctx.sessionId);
			}
		});

		return { result: {} };
	}

	export function getTargets(_params: {}, ctx: CDPMethodContext): CDPMethodResult {
		return { result: { targetInfos: ctx.service.getAllTargetInfos() } };
	}

	export function attachToTarget(params: { targetId?: string; flatten?: boolean }, ctx: CDPMethodContext): CDPMethodResult {
		const target = params.targetId ? ctx.service.getTarget(params.targetId) : undefined;

		if (!target) {
			return { error: { code: -32000, message: `Unknown target: ${params.targetId}` } };
		}

		const pageSessionId = ctx.client.attachToPageTarget(params.targetId!, target);

		setImmediate(() => {
			const info = target.getTargetInfo();
			if (info) {
				ctx.client.sendEvent('Target.attachedToTarget', {
					sessionId: pageSessionId,
					targetInfo: { ...info, attached: true },
					waitingForDebugger: false
				}, ctx.sessionId);
			}
		});

		return { result: { sessionId: pageSessionId } };
	}

	export async function createTarget(params: { url?: string; browserContextId?: string }, ctx: CDPMethodContext): Promise<CDPMethodResult> {
		const url = params.url || 'about:blank';

		if (!ctx.service.createTarget) {
			return { error: { code: -32000, message: 'Target creation not supported' } };
		}

		try {
			const { targetId } = await ctx.service.createTarget(url);
			return { result: { targetId } };
		} catch (error) {
			return { error: { code: -32000, message: (error as Error).message || 'Failed to create target' } };
		}
	}

	export async function closeTarget(params: { targetId?: string }, ctx: CDPMethodContext): Promise<CDPMethodResult> {
		if (!params.targetId) {
			return { error: { code: -32000, message: 'targetId is required' } };
		}

		if (!ctx.service.closeTarget) {
			return { error: { code: -32000, message: 'Target closing not supported' } };
		}

		try {
			const success = await ctx.service.closeTarget(params.targetId);
			return { result: { success } };
		} catch (error) {
			return { error: { code: -32000, message: (error as Error).message || 'Failed to close target' } };
		}
	}
}

// Register the Target domain
registerCDPDomain('Target', CDPTargetDomain);
