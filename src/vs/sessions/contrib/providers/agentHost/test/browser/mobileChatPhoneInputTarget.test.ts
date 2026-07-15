/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { observableValue } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IChat } from '../../../../../services/sessions/common/session.js';
import { IActiveSession } from '../../../../../services/sessions/common/sessionsManagement.js';
import { createChatPhoneInputTarget, matchesChatPhoneInputTarget } from '../../browser/mobile/mobileChatPhoneInputTarget.js';

function session(providerId: string, sessionId: string, chatResource: string): IActiveSession {
	return {
		providerId,
		sessionId,
		activeChat: observableValue<IChat>('activeChat', { resource: URI.parse(chatResource) } as IChat),
	} as unknown as IActiveSession;
}

suite('MobileChatPhoneInputTarget', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('matches only the captured provider, session, and active chat', () => {
		const original = session('provider', 'session', 'chat:/one');
		const target = createChatPhoneInputTarget(original);

		assert.deepStrictEqual({
			same: matchesChatPhoneInputTarget(target, original),
			providerChanged: matchesChatPhoneInputTarget(target, session('other', 'session', 'chat:/one')),
			sessionChanged: matchesChatPhoneInputTarget(target, session('provider', 'other', 'chat:/one')),
			chatChanged: matchesChatPhoneInputTarget(target, session('provider', 'session', 'chat:/two')),
			missing: matchesChatPhoneInputTarget(target, undefined),
		}, {
			same: true,
			providerChanged: false,
			sessionChanged: false,
			chatChanged: false,
			missing: false,
		});
	});

	test('an absent target matches only while no session is active', () => {
		assert.deepStrictEqual({
			stillAbsent: matchesChatPhoneInputTarget(undefined, undefined),
			sessionAppeared: matchesChatPhoneInputTarget(undefined, session('provider', 'session', 'chat:/one')),
		}, {
			stillAbsent: true,
			sessionAppeared: false,
		});
	});
});
