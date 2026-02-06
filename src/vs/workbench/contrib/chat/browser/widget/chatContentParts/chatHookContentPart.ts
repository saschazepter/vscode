/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { ChatHookOutcome, ChatHookType, IChatHookPart } from '../../../common/chatService/chatService.js';
import { IChatRendererContent } from '../../../common/model/chatViewModel.js';
import { ChatTreeItem } from '../../chat.js';
import { ChatCollapsibleContentPart } from './chatCollapsibleContentPart.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';
import './media/chatHookContent.css';

/**
 * Maps hook types to human-readable labels.
 */
function getHookTypeLabel(hookType: ChatHookType): string {
	switch (hookType) {
		case 'SessionStart': return localize('hook.sessionStart', "Session Start");
		case 'UserPromptSubmit': return localize('hook.userPromptSubmit', "User Prompt Submit");
		case 'PreToolUse': return localize('hook.preToolUse', "Pre-Tool Use");
		case 'PostToolUse': return localize('hook.postToolUse', "Post-Tool Use");
		case 'SubagentStart': return localize('hook.subagentStart', "Subagent Start");
		case 'SubagentStop': return localize('hook.subagentStop', "Subagent Stop");
		case 'Stop': return localize('hook.stop', "Stop");
		default: return hookType;
	}
}

function getHookOutcomeIcon(outcome: ChatHookOutcome): ThemeIcon {
	switch (outcome) {
		case 'success': return Codicon.check;
		case 'blocked': return Codicon.warning;
		case 'denied': return Codicon.close;
		case 'error': return Codicon.error;
		default: return Codicon.info;
	}
}

function getHookOutcomeClass(outcome: ChatHookOutcome): string {
	switch (outcome) {
		case 'success': return 'chat-hook-outcome-success';
		case 'blocked': return 'chat-hook-outcome-blocked';
		case 'denied': return 'chat-hook-outcome-denied';
		case 'error': return 'chat-hook-outcome-error';
		default: return '';
	}
}

export class ChatHookContentPart extends ChatCollapsibleContentPart implements IChatContentPart {

	constructor(
		private readonly hookPart: IChatHookPart,
		context: IChatContentPartRenderContext,
		@IHoverService hoverService: IHoverService,
	) {
		const hookTypeLabel = getHookTypeLabel(hookPart.hookType);
		const title = hookPart.outcome === 'success'
			? localize('hook.title.success', "{0} hook ran successfully", hookTypeLabel)
			: localize('hook.title.outcome', "{0} hook: {1}", hookTypeLabel, hookPart.message);

		super(title, context, undefined, hoverService);

		this.icon = getHookOutcomeIcon(hookPart.outcome);

		const outcomeClass = getHookOutcomeClass(hookPart.outcome);
		if (outcomeClass) {
			this.domNode.classList.add(outcomeClass);
		}

		this.setExpanded(false);
	}

	protected override initContent(): HTMLElement {
		const content = $('.chat-hook-details');

		if (this.hookPart.message) {
			const messageElement = $('.chat-hook-message', undefined, this.hookPart.message);
			content.appendChild(messageElement);
		}

		if (this.hookPart.reason) {
			const reasonElement = $('.chat-hook-reason', undefined, this.hookPart.reason);
			content.appendChild(reasonElement);
		}

		return content;
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: ChatTreeItem): boolean {
		if (other.kind !== 'hook') {
			return false;
		}
		return other.hookType === this.hookPart.hookType &&
			other.message === this.hookPart.message &&
			other.outcome === this.hookPart.outcome &&
			other.reason === this.hookPart.reason;
	}
}
