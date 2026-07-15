/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IActiveSession } from '../../../../../services/sessions/common/sessionsManagement.js';

export interface IChatPhoneInputTarget {
	readonly providerId: string;
	readonly sessionId: string;
	readonly chatResource: string;
}

export function createChatPhoneInputTarget(session: Pick<IActiveSession, 'providerId' | 'sessionId' | 'activeChat'> | undefined): IChatPhoneInputTarget | undefined {
	return session ? {
		providerId: session.providerId,
		sessionId: session.sessionId,
		chatResource: session.activeChat.get().resource.toString(),
	} : undefined;
}

export function matchesChatPhoneInputTarget(
	target: IChatPhoneInputTarget | undefined,
	session: Pick<IActiveSession, 'providerId' | 'sessionId' | 'activeChat'> | undefined,
): boolean {
	return target === undefined ? session === undefined : !!session
		&& session.providerId === target.providerId
		&& session.sessionId === target.sessionId
		&& session.activeChat.get().resource.toString() === target.chatResource;
}
