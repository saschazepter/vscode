/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CDPMethodContext, CDPMethodResult } from '../types.js';

/**
 * Method handler function type for CDP domain methods
 */
export type CDPMethodHandler<TParams = unknown> = (params: TParams, context: CDPMethodContext) => CDPMethodResult | Promise<CDPMethodResult>;

/**
 * A CDP domain is a record of method handlers keyed by method name (without domain prefix)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CDPDomainHandlers = Record<string, CDPMethodHandler<any>>;

/**
 * Registry of CDP domains (maps domain name -> handlers)
 */
const domainRegistry = new Map<string, CDPDomainHandlers>();

/**
 * Register a CDP domain with its handlers
 * @param domainName The domain name (e.g., 'Target', 'Browser')
 * @param handlers Record of method handlers keyed by method name
 */
export function registerCDPDomain(domainName: string, handlers: CDPDomainHandlers): void {
	domainRegistry.set(domainName, handlers);
}

/**
 * Get a domain's handlers by name
 */
export function getCDPDomain(domainName: string): CDPDomainHandlers | undefined {
	return domainRegistry.get(domainName);
}

/**
 * Check if a domain is registered
 */
export function hasCDPDomain(domainName: string): boolean {
	return domainRegistry.has(domainName);
}

/**
 * Handle a CDP method call
 * @param method Full method name (e.g., 'Target.getTargets')
 * @param params Method parameters
 * @param context Method context with services
 * @returns The result, or empty result for unhandled methods
 */
export async function handleCDPMethod(method: string, params: unknown, context: CDPMethodContext): Promise<CDPMethodResult> {
	const [domainName, methodName] = method.split('.');
	if (!methodName) {
		return { result: {} };
	}

	const domain = domainRegistry.get(domainName);
	if (!domain) {
		return { result: {} };
	}

	const handler = domain[methodName];
	if (!handler) {
		// Method not implemented - return empty result (common for unimplemented CDP methods)
		return { result: {} };
	}

	return handler(params, context);
}
