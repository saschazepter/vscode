/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../../base/common/themables.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { IMarkdownRenderer } from '../../../../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../../../../platform/opener/common/opener.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { IChatSessionCreatedData, IChatToolInvocation, IChatToolInvocationSerialized } from '../../../../common/chatService/chatService.js';
import { IChatCodeBlockInfo } from '../../../chat.js';
import { IChatContentPartRenderContext } from '../chatContentParts.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';
import { ChatToolProgressSubPart } from './chatToolProgressPart.js';
import '../media/chatSessionCreatedResult.css';

/**
 * Renders the standard tool-call progress row for a completed `create_session` /
 * `create_chat` agent-host tool call, followed by a muted confirmation label and
 * a compact secondary button (labelled with the session title) that opens it.
 * The link comes from the tool call's structured {@link IChatSessionCreatedData}
 * (not the model's prose), so it is always present and clickable. Clicking opens
 * the session via the `agent-host-session://` opener registered in the Agents window.
 */
export class ChatSessionCreatedResultSubPart extends BaseChatToolInvocationSubPart {

	public readonly domNode: HTMLElement;
	public readonly codeblocks: IChatCodeBlockInfo[] = [];

	constructor(
		toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized,
		private readonly data: IChatSessionCreatedData,
		context: IChatContentPartRenderContext,
		renderer: IMarkdownRenderer,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService private readonly openerService: IOpenerService,
	) {
		super(toolInvocation);

		this.domNode = dom.$('.chat-open-session-result');

		// Keep the normal "create_session" tool row visible.
		const progressPart = this._register(instantiationService.createInstance(ChatToolProgressSubPart, toolInvocation, context, renderer, undefined));
		dom.append(this.domNode, progressPart.domNode);

		const card = dom.append(this.domNode, dom.$('.chat-open-session-card'));
		dom.append(card, dom.$('.chat-open-session-title', undefined, this.data.heading));

		const button = this._register(new Button(card, {
			...defaultButtonStyles,
			secondary: true,
			supportIcons: true,
			title: this.data.label,
		}));
		button.element.classList.add('chat-open-session-button');
		button.label = `$(${Codicon.agent.id}) ${this.data.label}`;
		this._register(button.onDidClick(() => {
			this.openerService.open(URI.parse(this.data.openLink), { fromUserGesture: true, allowContributedOpeners: true });
		}));
	}

	protected override getIcon(): ThemeIcon {
		return Codicon.agent;
	}
}
