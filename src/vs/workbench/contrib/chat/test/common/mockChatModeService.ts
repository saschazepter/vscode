/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Event } from '../../../../../base/common/event.js';
import { ChatMode, IChatModes, IChatMode, IChatModeService } from '../../common/chatModes.js';

export class MockChatModeService implements IChatModeService {
	declare readonly _serviceBrand: undefined;

	public readonly onDidChangeChatModes = Event.None;

	constructor(
		private readonly _modes: { builtin: readonly IChatMode[]; custom: readonly IChatMode[] } = { builtin: [ChatMode.Ask], custom: [] }
	) { }

	getModes(_sessionType: string): IChatModes {
		const { builtin, custom } = this._modes;
		return {
			builtin,
			custom,
			findModeById(id: string): IChatMode | undefined {
				return builtin.find(mode => mode.id === id) ?? custom.find(mode => mode.id === id);
			},
			findModeByName(name: string): IChatMode | undefined {
				return builtin.find(mode => mode.name.get() === name) ?? custom.find(mode => mode.name.get() === name);
			},
		};
	}

}
