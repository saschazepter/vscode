/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildOpenSessionLinkUri, isCreateChatTool, isCreateSessionTool, parseOpenSessionLinkUri } from '../../common/openSessionLink.js';

suite('openSessionLink', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('isCreateSessionTool matches bare and mcp-prefixed names', () => {
		assert.strictEqual(isCreateSessionTool('create_session'), true);
		assert.strictEqual(isCreateSessionTool('mcp__server__create_session'), true);
		assert.strictEqual(isCreateSessionTool('list_sessions'), false);
	});

	test('isCreateChatTool matches bare and mcp-prefixed names', () => {
		assert.strictEqual(isCreateChatTool('create_chat'), true);
		assert.strictEqual(isCreateChatTool('mcp__server__create_chat'), true);
		assert.strictEqual(isCreateChatTool('create_session'), false);
	});

	test('builds a link from a backend session URI', () => {
		assert.strictEqual(buildOpenSessionLinkUri('copilotcli:/abc-123'), 'agent-host-session://copilotcli/abc-123');
	});

	test('round-trips backend session URI', () => {
		const backend = 'copilotcli:/abc-123';
		const parsed = parseOpenSessionLinkUri(buildOpenSessionLinkUri(backend));
		assert.strictEqual(parsed?.toString(), URI.parse(backend).toString());
	});

	test('returns undefined for non-session-link URIs', () => {
		assert.strictEqual(parseOpenSessionLinkUri('https://example.com/x'), undefined);
		assert.strictEqual(parseOpenSessionLinkUri('copilotcli:/abc'), undefined);
		assert.strictEqual(parseOpenSessionLinkUri('agent-host-session://copilotcli/'), undefined);
	});
});
