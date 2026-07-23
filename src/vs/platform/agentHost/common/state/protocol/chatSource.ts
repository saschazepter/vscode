/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from './common/state.js';
import { ChatSourceKind, type ChatSource, type ForkChatSource, type SideChatSource } from './channels-chat/commands.js';
import type { ChatSourceTurn } from './channels-chat/state.js';

export function createForkChatSource(chat: URI, turnId: string): ForkChatSource {
	return { chat, turnId };
}

export function createSideChatSource(chat: URI, turn: ChatSourceTurn): SideChatSource {
	return { kind: ChatSourceKind.SideChat, chat, turn };
}

export function isForkChatSource(source: ChatSource | undefined): source is ForkChatSource {
	return !!source && 'turnId' in source && !('kind' in source);
}

export function isSideChatSource(source: ChatSource | undefined): source is SideChatSource {
	return !!source && 'kind' in source && source.kind === ChatSourceKind.SideChat;
}
