/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { SessionIndexingPreference } from '../sessionIndexingPreference';

function createMockContext(state: Record<string, unknown> = {}) {
	const storage = new Map<string, unknown>(Object.entries(state));
	return {
		globalState: {
			get: <T>(key: string, defaultValue?: T) => (storage.get(key) as T) ?? defaultValue,
			update: async (key: string, value: unknown) => { storage.set(key, value); },
		},
		_storage: storage,
	} as unknown as import('../../../../platform/extContext/common/extensionContext').IVSCodeExtensionContext;
}

describe('SessionIndexingPreference', () => {
	it('returns undefined when no preference is set', () => {
		const ctx = createMockContext();
		const pref = new SessionIndexingPreference(ctx);
		expect(pref.getPreference('microsoft/vscode')).toBeUndefined();
	});

	it('returns repo-specific preference', () => {
		const ctx = createMockContext({ 'copilot.sessionSearch.microsoft/vscode': 'user' });
		const pref = new SessionIndexingPreference(ctx);
		expect(pref.getPreference('microsoft/vscode')).toBe('user');
	});

	it('falls back to global wildcard preference', () => {
		const ctx = createMockContext({ 'copilot.sessionSearch.*': 'local' });
		const pref = new SessionIndexingPreference(ctx);
		expect(pref.getPreference('microsoft/vscode')).toBe('local');
	});

	it('repo-specific takes priority over global wildcard', () => {
		const ctx = createMockContext({
			'copilot.sessionSearch.*': 'local',
			'copilot.sessionSearch.microsoft/vscode': 'repo_and_user',
		});
		const pref = new SessionIndexingPreference(ctx);
		expect(pref.getPreference('microsoft/vscode')).toBe('repo_and_user');
	});

	it('different repos can have different preferences', () => {
		const ctx = createMockContext({
			'copilot.sessionSearch.microsoft/vscode': 'user',
			'copilot.sessionSearch.microsoft/tas-client': 'local',
		});
		const pref = new SessionIndexingPreference(ctx);
		expect(pref.getPreference('microsoft/vscode')).toBe('user');
		expect(pref.getPreference('microsoft/tas-client')).toBe('local');
	});
});
