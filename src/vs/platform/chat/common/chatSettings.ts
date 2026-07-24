/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../configuration/common/configuration.js';

export const ChatAIDisabledSettingId = 'chat.disableAIFeatures';

/** Returns whether AI features are disabled effectively or at a user-wide scope. */
export function isChatAIDisabled(configurationService: IConfigurationService): boolean {
	const inspected = configurationService.inspect<boolean>(ChatAIDisabledSettingId);
	return configurationService.getValue<boolean>(ChatAIDisabledSettingId) === true
		|| inspected.applicationValue === true
		|| inspected.userValue === true
		|| inspected.userLocalValue === true
		|| inspected.userRemoteValue === true
		|| inspected.policyValue === true;
}
