/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { extractPlainTextFromContent } from '../sessionStoreTracking';

describe('extractPlainTextFromContent', () => {
	it('returns plain text unchanged', () => {
		expect(extractPlainTextFromContent('Fix the bug in authentication')).toBe('Fix the bug in authentication');
	});

	it('returns empty string unchanged', () => {
		expect(extractPlainTextFromContent('')).toBe('');
	});

	it('returns plain text that happens to contain braces unchanged', () => {
		expect(extractPlainTextFromContent('Use {curly} braces in your code')).toBe('Use {curly} braces in your code');
	});

	it('extracts text from text-part JSON array', () => {
		const input = JSON.stringify([{ type: 'text', text: 'Hello world' }]);
		expect(extractPlainTextFromContent(input)).toBe('Hello world');
	});

	it('extracts text from multiple text parts', () => {
		const input = JSON.stringify([
			{ type: 'text', text: 'Hello' },
			{ type: 'text', text: 'world' },
		]);
		expect(extractPlainTextFromContent(input)).toBe('Hello world');
	});

	it('extracts content from chat message JSON', () => {
		const input = JSON.stringify([{ role: 'user', content: 'Refactor the login flow' }]);
		expect(extractPlainTextFromContent(input)).toBe('Refactor the login flow');
	});

	it('extracts content from single message object', () => {
		const input = JSON.stringify({ role: 'user', content: 'Fix the bug' });
		expect(extractPlainTextFromContent(input)).toBe('Fix the bug');
	});

	it('returns undefined for tool_result JSON with no extractable text', () => {
		const input = JSON.stringify([{ type: 'tool_result', content: [{ type: 'text', text: 'result' }] }]);
		// tool_result has no role and type !== 'text', so nothing is extracted
		expect(extractPlainTextFromContent(input)).toBeUndefined();
	});

	it('returns undefined for array of structured non-text objects', () => {
		const input = JSON.stringify([{ type: 'image', url: 'http://example.com/img.png' }]);
		expect(extractPlainTextFromContent(input)).toBeUndefined();
	});

	it('returns undefined for empty JSON array', () => {
		expect(extractPlainTextFromContent('[]')).toBeUndefined();
	});

	it('returns undefined for empty JSON object', () => {
		expect(extractPlainTextFromContent('{}')).toBeUndefined();
	});

	it('returns plain text for invalid JSON that starts with [', () => {
		const input = '[not valid json';
		expect(extractPlainTextFromContent(input)).toBe('[not valid json');
	});

	it('handles leading whitespace before JSON', () => {
		const input = '  ' + JSON.stringify([{ type: 'text', text: 'Hello' }]);
		expect(extractPlainTextFromContent(input)).toBe('Hello');
	});
});
