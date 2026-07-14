/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { MessageKind, TurnState, type Turn } from '../../common/state/sessionState.js';
import { prepareSideChatPrompt, stripSideChatContext, type IPersistedSideChat } from '../../node/agentPeerChats.js';

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
});
