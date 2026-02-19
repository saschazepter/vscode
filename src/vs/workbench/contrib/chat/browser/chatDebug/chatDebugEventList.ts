/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { localize } from '../../../../../nls.js';
import { ChatDebugLogLevel, IChatDebugEvent } from '../../common/chatDebugService.js';
import { safeIntl } from '../../../../../base/common/date.js';

export interface IChatDebugEventTemplate {
	readonly container: HTMLElement;
	readonly created: HTMLElement;
	readonly name: HTMLElement;
	readonly details: HTMLElement;
}

export class ChatDebugEventRenderer implements IListRenderer<IChatDebugEvent, IChatDebugEventTemplate> {
	static readonly TEMPLATE_ID = 'chatDebugEvent';

	get templateId(): string {
		return ChatDebugEventRenderer.TEMPLATE_ID;
	}

	renderTemplate(container: HTMLElement): IChatDebugEventTemplate {
		container.classList.add('chat-debug-log-row');

		const created = document.createElement('span');
		created.className = 'chat-debug-log-created';
		const name = document.createElement('span');
		name.className = 'chat-debug-log-name';
		const details = document.createElement('span');
		details.className = 'chat-debug-log-details';

		container.appendChild(created);
		container.appendChild(name);
		container.appendChild(details);

		return { container, created, name, details };
	}

	renderElement(element: IChatDebugEvent, index: number, templateData: IChatDebugEventTemplate): void {
		const dateFormatter = safeIntl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			second: '2-digit',
		});

		templateData.created.textContent = dateFormatter.value.format(element.created);

		switch (element.kind) {
			case 'toolCall':
				templateData.name.textContent = element.toolName;
				templateData.details.textContent = element.result ?? '';
				break;
			case 'modelTurn':
				templateData.name.textContent = element.model ?? localize('chatDebug.modelTurn', "Model Turn");
				templateData.details.textContent = element.totalTokens !== undefined
					? localize('chatDebug.tokens', "{0} tokens", element.totalTokens)
					: '';
				break;
			case 'generic':
				templateData.name.textContent = element.name;
				templateData.details.textContent = element.details ?? '';
				break;
			case 'subagentInvocation':
				templateData.name.textContent = element.agentName;
				templateData.details.textContent = element.description ?? (element.status ?? '');
				break;
		}

		// Tree indentation for child events
		if (element.parentEventId) {
			templateData.container.classList.add('chat-debug-log-child');
		} else {
			templateData.container.classList.remove('chat-debug-log-child');
		}

		const isError = element.kind === 'generic' && element.level === ChatDebugLogLevel.Error
			|| element.kind === 'toolCall' && element.result === 'error';
		const isWarning = element.kind === 'generic' && element.level === ChatDebugLogLevel.Warning;
		const isTrace = element.kind === 'generic' && element.level === ChatDebugLogLevel.Trace;

		templateData.container.classList.toggle('chat-debug-log-error', isError);
		templateData.container.classList.toggle('chat-debug-log-warning', isWarning);
		templateData.container.classList.toggle('chat-debug-log-trace', isTrace);
	}

	disposeTemplate(_templateData: IChatDebugEventTemplate): void {
		// noop
	}
}

export class ChatDebugEventDelegate implements IListVirtualDelegate<IChatDebugEvent> {
	getHeight(_element: IChatDebugEvent): number {
		return 28;
	}

	getTemplateId(_element: IChatDebugEvent): string {
		return ChatDebugEventRenderer.TEMPLATE_ID;
	}
}
