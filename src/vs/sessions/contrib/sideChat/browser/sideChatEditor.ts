/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../base/browser/dom.js';
import { autorun, derived } from '../../../../base/common/observable.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { AbstractChatView } from '../../../browser/parts/chatView.js';
import { IChatViewFactory } from '../../../services/chatView/browser/chatViewFactory.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ChatOriginKind, IChat } from '../../../services/sessions/common/session.js';
import { SideChatEditorInput } from './sideChatEditorInput.js';

export class SideChatEditor extends EditorPane {

	static readonly ID = SideChatEditorInput.EDITOR_ID;

	private readonly _chatView: AbstractChatView;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IChatViewFactory chatViewFactory: IChatViewFactory,
		@ISessionsService sessionsService: ISessionsService,
	) {
		super(SideChatEditor.ID, group, telemetryService, themeService, storageService);

		this._chatView = this._register(chatViewFactory.createChatView());

		const newestSideChat = derived(reader => {
			const session = sessionsService.activeSession.read(reader);
			if (!session) {
				return undefined;
			}
			const sideChats = session.chats.read(reader).filter(chat => chat.origin?.kind === ChatOriginKind.SideChat);
			return sideChats.length ? { sessionId: session.sessionId, chat: sideChats[sideChats.length - 1] } : undefined;
		});
		this._register(autorun(reader => {
			const result: { sessionId: string; chat: IChat } | undefined = newestSideChat.read(reader);
			if (result) {
				this._chatView.setChat(result.chat, result.sessionId);
			}
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		parent.appendChild(this._chatView.element);
	}

	protected override setEditorVisible(visible: boolean): void {
		this._chatView.setActive(visible);
	}

	override focus(): void {
		super.focus();
		this._chatView.focus();
	}

	override layout(dimension: Dimension): void {
		this._chatView.layout(dimension.width, dimension.height, 0, 0);
	}
}
