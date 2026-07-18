/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AgentSession } from '../../common/agentService.js';
import { augmentTroubleshootRequest } from '../../common/agentHostTroubleshoot.js';
import { toSessionReferenceAttachmentMeta } from '../../common/meta/agentSessionReferenceMeta.js';
import { MessageAttachmentKind, type MessageAttachment } from '../../common/state/protocol/state.js';

suite('agentHostTroubleshoot - augmentTroubleshootRequest', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const PROVIDER = 'copilotcli';
	const resolvePath = (id: string) => `/state/${id}/log.jsonl`;

	function sessionReferenceAttachment(sessionId: string): MessageAttachment {
		const resource = AgentSession.uri(PROVIDER, sessionId);
		return {
			type: MessageAttachmentKind.Simple,
			label: `session ${sessionId}`,
			_meta: toSessionReferenceAttachmentMeta({ sessionResource: resource.toString(), sessionID: sessionId }),
		};
	}

	function plainAttachment(label: string): MessageAttachment {
		return { type: MessageAttachmentKind.Simple, label };
	}

	const SKILL_BASE = `Use the skill tool to invoke the 'troubleshoot' skill, then follow the skill's instructions.`;

	test('omits the log path for a bare request and forwards the free text as context', () => {
		const result = augmentTroubleshootRequest('why slow', undefined, resolvePath);
		assert.deepStrictEqual(result, {
			prompt: `${SKILL_BASE}\n\nAdditional context from the user:\nwhy slow`,
			attachments: undefined,
		});
	});

	test('targets a referenced session, drops the marker, and ignores the marker title text', () => {
		const attachments = [sessionReferenceAttachment('other')];
		const result = augmentTroubleshootRequest('how many tests does util have', attachments, resolvePath);
		assert.deepStrictEqual(result, {
			prompt: `${SKILL_BASE}\n\nSession log: /state/other/log.jsonl`,
			attachments: [],
		});
	});

	test('keeps non-marker attachments and dedupes multiple references', () => {
		const keep = plainAttachment('notes.txt');
		const attachments = [sessionReferenceAttachment('a'), keep, sessionReferenceAttachment('b'), sessionReferenceAttachment('a')];
		const result = augmentTroubleshootRequest('#session:a #session:b', attachments, resolvePath);
		assert.deepStrictEqual(result, {
			prompt: `${SKILL_BASE}\n\nSession log: /state/a/log.jsonl, /state/b/log.jsonl`,
			attachments: [keep],
		});
	});
});
