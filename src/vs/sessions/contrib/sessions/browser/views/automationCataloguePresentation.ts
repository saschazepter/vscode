/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';

export function formatUnavailableAutomationsMessage(unavailableProviderLabels: readonly string[]): string {
	if (unavailableProviderLabels.length === 1) {
		return localize('automationsUnavailableProvider', "Automations from {0} are unavailable.", unavailableProviderLabels[0]);
	}
	if (unavailableProviderLabels.length > 1) {
		return localize('automationsUnavailableProviders', "Automations from these providers are unavailable: {0}.", unavailableProviderLabels.join(', '));
	}
	return localize('automationsPartialUnavailable', "Some automations are unavailable.");
}
