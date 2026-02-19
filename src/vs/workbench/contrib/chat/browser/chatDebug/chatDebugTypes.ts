/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { BreadcrumbsItem } from '../../../../../base/browser/ui/breadcrumbs/breadcrumbsWidget.js';
import { RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';

const $ = DOM.$;

export const enum ViewState {
	Home = 'home',
	Overview = 'overview',
	Logs = 'logs',
	SubagentChart = 'subagentChart',
}

export const enum LogsViewMode {
	List = 'list',
	Tree = 'tree',
}

export const CHAT_DEBUG_FILTER_ACTIVE = new RawContextKey<boolean>('chatDebugFilterActive', false);
export const CHAT_DEBUG_KIND_TOOL_CALL = new RawContextKey<boolean>('chatDebug.kindToolCall', true);
export const CHAT_DEBUG_KIND_MODEL_TURN = new RawContextKey<boolean>('chatDebug.kindModelTurn', true);
export const CHAT_DEBUG_KIND_GENERIC = new RawContextKey<boolean>('chatDebug.kindGeneric', true);
export const CHAT_DEBUG_KIND_SUBAGENT = new RawContextKey<boolean>('chatDebug.kindSubagent', true);
export const CHAT_DEBUG_KIND_USER_MESSAGE = new RawContextKey<boolean>('chatDebug.kindUserMessage', true);
export const CHAT_DEBUG_KIND_AGENT_RESPONSE = new RawContextKey<boolean>('chatDebug.kindAgentResponse', true);
export const CHAT_DEBUG_LEVEL_TRACE = new RawContextKey<boolean>('chatDebug.levelTrace', true);
export const CHAT_DEBUG_LEVEL_INFO = new RawContextKey<boolean>('chatDebug.levelInfo', true);
export const CHAT_DEBUG_LEVEL_WARNING = new RawContextKey<boolean>('chatDebug.levelWarning', true);
export const CHAT_DEBUG_LEVEL_ERROR = new RawContextKey<boolean>('chatDebug.levelError', true);

export class TextBreadcrumbItem extends BreadcrumbsItem {
	constructor(
		private readonly _text: string,
		private readonly _isLink: boolean = false,
	) {
		super();
	}

	equals(other: BreadcrumbsItem): boolean {
		return other instanceof TextBreadcrumbItem && other._text === this._text;
	}

	dispose(): void {
		// Nothing to dispose
	}

	render(container: HTMLElement): void {
		container.classList.add('chat-debug-breadcrumb-item');
		if (this._isLink) {
			container.classList.add('chat-debug-breadcrumb-item-link');
		}
		DOM.append(container, $('span.chat-debug-breadcrumb-item-label', undefined, this._text));
	}
}
