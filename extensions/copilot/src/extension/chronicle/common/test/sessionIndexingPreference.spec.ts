/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { SessionIndexingPreference } from '../sessionIndexingPreference';

function createMockConfigService(opts: {
	sessionSyncEnabled?: boolean;
} = {}) {
	return {
		getNonExtensionConfig: (key: string) => {
			if (key === 'chat.sessionSync.enabled') {
				return opts.sessionSyncEnabled ?? false;
			}
			return undefined;
		},
	} as unknown as import('../../../../platform/configuration/common/configurationService').IConfigurationService;
}

describe('SessionIndexingPreference', () => {
	it('getStorageLevel returns local when session sync disabled', () => {
		const pref = new SessionIndexingPreference(createMockConfigService());
		expect(pref.getStorageLevel()).toBe('local');
	});

	it('getStorageLevel returns user when session sync enabled', () => {
		const pref = new SessionIndexingPreference(createMockConfigService({ sessionSyncEnabled: true }));
		expect(pref.getStorageLevel()).toBe('user');
	});

	it('hasCloudConsent returns false when session sync disabled', () => {
		const pref = new SessionIndexingPreference(createMockConfigService({ sessionSyncEnabled: false }));
		expect(pref.hasCloudConsent()).toBe(false);
	});

	it('hasCloudConsent returns true when session sync enabled', () => {
		const pref = new SessionIndexingPreference(createMockConfigService({ sessionSyncEnabled: true }));
		expect(pref.hasCloudConsent()).toBe(true);
	});
});
