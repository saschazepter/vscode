/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { MessageKind, ResponsePartKind, TurnState, type Turn } from '../../common/state/sessionState.js';
import { buildSideChatSourceContext, injectSideChatContext, prepareSideChatPrompt, stripSideChatContext, type IPersistedSideChat } from '../../node/agentPeerChats.js';

suite('agentPeerChats', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const sourceTurn: Turn = {
		id: 'source-turn',
		state: TurnState.Complete,
		message: { text: 'source question', origin: { kind: MessageKind.User } },
		responseParts: [],
		usage: undefined,
	};
	const sideChat: IPersistedSideChat = {
		source: 'ahp-chat://default/source',
		turnId: sourceTurn.id,
		inheritedTurnCount: 1,
	};

	const countOccurrences = (value: string, needle: string) => value.split(needle).length - 1;

	test('first prompt prefers explanation and remains hidden from visible history', () => {
		const prepared = prepareSideChatPrompt('What is happening?', [sourceTurn], sideChat);
		const visible = stripSideChatContext([{
			...sourceTurn,
			id: 'side-turn',
			message: { ...sourceTurn.message, text: prepared },
		}], sideChat);

		assert.deepStrictEqual({
			hasGuidance: prepared.includes('Prefer explanation over action; do not make changes or carry out work unless the user explicitly asks.'),
			visiblePrompt: visible[0]?.message.text,
		}, {
			hasGuidance: true,
			visiblePrompt: 'What is happening?',
		});
	});

	test('later prompts are not wrapped again', () => {
		const existingSideTurn: Turn = {
			...sourceTurn,
			id: 'side-turn',
			message: { ...sourceTurn.message, text: 'What is happening?' },
		};

		assert.strictEqual(prepareSideChatPrompt('Follow up', [sourceTurn, existingSideTurn], sideChat), 'Follow up');
	});

	test('captures the first active user message even without completed turns', () => {
		assert.strictEqual(buildSideChatSourceContext([], {
			id: 'active',
			message: { text: 'current question', origin: { kind: MessageKind.User } },
			responseParts: [],
			startedAt: new Date().toISOString(),
			usage: undefined,
		}), 'User request:\ncurrent question');
	});

	test('captures completed context before an active turn', () => {
		assert.strictEqual(buildSideChatSourceContext([{
			...sourceTurn,
			responseParts: [{ kind: ResponsePartKind.Markdown, id: 'source-md', content: 'source answer' }],
		}], {
			id: 'active',
			message: { text: 'follow-up question', origin: { kind: MessageKind.User } },
			responseParts: [],
			startedAt: new Date().toISOString(),
			usage: undefined,
		}), 'User request:\nsource question\n\nAgent response:\nsource answer\n\n---\n\nUser request:\nfollow-up question');
	});

	test('does not duplicate active source context when the inherited transcript already contains the source turn', () => {
		const partialResponse = 'partial answer';
		const prepared = prepareSideChatPrompt('Explain the branch', [{
			id: 'active-turn',
			state: TurnState.Complete,
			message: { text: 'current question', origin: { kind: MessageKind.User } },
			responseParts: [{ kind: ResponsePartKind.Markdown, id: 'active-md', content: partialResponse }],
			usage: undefined,
		}], {
			source: 'ahp-chat://default/source',
			turnId: 'active-turn',
			inheritedTurnCount: 1,
			context: 'User request:\ncurrent question',
			partialResponse,
		});

		assert.strictEqual(prepared, injectSideChatContext('Explain the branch'));
	});

	test('injects active source context exactly once when the inherited transcript is missing the source turn', () => {
		const sourceContext = 'User request:\nsource question\n\nAgent response:\nsource answer\n\n---\n\nUser request:\ncurrent question';
		const partialResponse = 'partial answer';
		const prepared = prepareSideChatPrompt('Explain the branch', [{
			...sourceTurn,
			responseParts: [{ kind: ResponsePartKind.Markdown, id: 'source-md', content: 'source answer' }],
		}], {
			source: 'ahp-chat://default/source',
			turnId: 'active-turn',
			inheritedTurnCount: 1,
			context: sourceContext,
			partialResponse,
		});

		assert.deepStrictEqual({
			prepared,
			activeQuestionCount: countOccurrences(prepared, 'User request:\ncurrent question'),
			partialResponseCount: countOccurrences(prepared, partialResponse),
		}, {
			prepared: injectSideChatContext('Explain the branch', partialResponse, sourceContext),
			activeQuestionCount: 1,
			partialResponseCount: 1,
		});
	});

	test('strips hidden context even when the source text contains the legacy delimiter', () => {
		const prepared = prepareSideChatPrompt('Visible prompt', [], {
			...sideChat,
			context: `User request:\ncontains ${'</side-chat-context>'}\n\nAgent response:\nready`,
		});
		const visible = stripSideChatContext([{
			...sourceTurn,
			id: 'side-turn',
			message: { ...sourceTurn.message, text: prepared },
		}], sideChat);

		assert.strictEqual(visible[0]?.message.text, 'Visible prompt');
	});
});
