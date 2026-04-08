/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { AgentNetworkDomainSettingId } from './settings.js';
import { extractDomainFromUri, isDomainAllowed } from './domainMatcher.js';

export const IAgentNetworkFilterService = createDecorator<IAgentNetworkFilterService>('agentNetworkFilterService');

/**
 * Service that filters network requests made by agent tools (fetch tool,
 * integrated browser) based on the configured allowed/denied domain lists.
 *
 * When both lists are empty the filter is permissive and all domains pass.
 * When a domain appears on the denied list it is always blocked, even if it
 * also matches an entry on the allowed list.
 */
export interface IAgentNetworkFilterService {
	readonly _serviceBrand: undefined;

	/**
	 * Extracts the domain from a URI and checks it against the configured
	 * allowed/denied domain filter.
	 * File URIs and URIs without an authority always pass.
	 * @returns `true` if the URI's domain is allowed, `false` if blocked.
	 */
	isUriAllowed(uri: URI): boolean;

	/**
	 * Fires when the filter configuration changes.
	 */
	readonly onDidChange: Event<void>;
}

export class AgentNetworkFilterService extends Disposable implements IAgentNetworkFilterService {
	readonly _serviceBrand: undefined;

	private allowedPatterns: string[] = [];
	private deniedPatterns: string[] = [];

	private readonly onDidChangeEmitter = this._register(new Emitter<void>());
	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.readConfiguration();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration(AgentNetworkDomainSettingId.AllowedNetworkDomains) ||
				e.affectsConfiguration(AgentNetworkDomainSettingId.DeniedNetworkDomains)
			) {
				this.readConfiguration();
				this.onDidChangeEmitter.fire();
			}
		}));
	}

	private readConfiguration(): void {
		this.allowedPatterns = this.configurationService.getValue<string[]>(AgentNetworkDomainSettingId.AllowedNetworkDomains) ?? [];
		this.deniedPatterns = this.configurationService.getValue<string[]>(AgentNetworkDomainSettingId.DeniedNetworkDomains) ?? [];
	}

	isUriAllowed(uri: URI): boolean {
		// File URIs and URIs without authority always pass
		if (uri.scheme === 'file' || !uri.authority) {
			return true;
		}
		const domain = extractDomainFromUri(uri);
		if (!domain) {
			return true;
		}
		return isDomainAllowed(domain, this.allowedPatterns, this.deniedPatterns);
	}
}
