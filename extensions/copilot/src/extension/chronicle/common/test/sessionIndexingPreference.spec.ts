/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { SessionIndexingPreference } from '../sessionIndexingPreference';

function createMockConfigService(storageLevel: string = 'none') {
	return {
		getConfig: (key: unknown) => {
			if (typeof key === 'object' && key !== null && 'key' in key) {
				return storageLevel;
			}
			return storageLevel;
		},
	} as unknown as import('../../../../platform/configuration/common/configurationService').IConfigurationService;
}

describe('SessionIndexingPreference', () => {
	it('returns undefined when storage level is none', () => {
		const config = createMockConfigService('none');
		const pref = new SessionIndexingPreference(config);
		expect(pref.getStorageLevel()).toBeUndefined();
	});

	it('returns local when configured', () => {
		const config = createMockConfigService('local');
		const pref = new SessionIndexingPreference(config);
		expect(pref.getStorageLevel()).toBe('local');
	});

	it('returns user when configured', () => {
		const config = createMockConfigService('user');
		const pref = new SessionIndexingPreference(config);
		expect(pref.getStorageLevel()).toBe('user');
	});

	it('returns repo_and_user when configured', () => {
		const config = createMockConfigService('repo_and_user');
		const pref = new SessionIndexingPreference(config);
		expect(pref.getStorageLevel()).toBe('repo_and_user');
	});

	it('needsPrompt returns true when none', () => {
		const config = createMockConfigService('none');
		const pref = new SessionIndexingPreference(config);
		expect(pref.needsPrompt()).toBe(true);
	});

	it('needsPrompt returns false when configured', () => {
		const config = createMockConfigService('user');
		const pref = new SessionIndexingPreference(config);
		expect(pref.needsPrompt()).toBe(false);
	});

	it('hasCloudConsent returns true for user', () => {
		const config = createMockConfigService('user');
		const pref = new SessionIndexingPreference(config);
		expect(pref.hasCloudConsent()).toBe(true);
	});

	it('hasCloudConsent returns true for repo_and_user', () => {
		const config = createMockConfigService('repo_and_user');
		const pref = new SessionIndexingPreference(config);
		expect(pref.hasCloudConsent()).toBe(true);
	});

	it('hasCloudConsent returns false for local', () => {
		const config = createMockConfigService('local');
		const pref = new SessionIndexingPreference(config);
		expect(pref.hasCloudConsent()).toBe(false);
	});

	it('hasCloudConsent returns false for none', () => {
		const config = createMockConfigService('none');
		const pref = new SessionIndexingPreference(config);
		expect(pref.hasCloudConsent()).toBe(false);
	});
});
