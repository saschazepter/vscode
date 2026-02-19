/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IChatDebugMessageSection, IChatDebugUserMessageEvent, IChatDebugAgentResponseEvent } from '../../common/chatDebugService.js';

const $ = DOM.$;

/**
 * Render a collapsible section with a clickable header and pre-formatted content.
 */
function renderCollapsibleSection(parent: HTMLElement, section: IChatDebugMessageSection, disposables: DisposableStore, initiallyCollapsed: boolean = true): void {
	const sectionEl = DOM.append(parent, $('div.chat-debug-message-section'));

	const header = DOM.append(sectionEl, $('div.chat-debug-message-section-header'));
	header.style.cursor = 'pointer';

	const chevron = DOM.append(header, $(`span.chat-debug-message-section-chevron`));
	const titleEl = DOM.append(header, $('span.chat-debug-message-section-title', undefined, section.name));
	titleEl.style.fontWeight = '600';

	const contentEl = DOM.append(sectionEl, $('pre.chat-debug-message-section-content'));
	contentEl.textContent = section.content;
	contentEl.tabIndex = 0;

	let collapsed = initiallyCollapsed;

	const updateState = () => {
		DOM.clearNode(chevron);
		const icon = collapsed ? Codicon.chevronRight : Codicon.chevronDown;
		chevron.classList.add(ThemeIcon.asClassName(icon));
		contentEl.style.display = collapsed ? 'none' : 'block';
	};

	updateState();

	disposables.add(DOM.addDisposableListener(header, DOM.EventType.CLICK, () => {
		collapsed = !collapsed;
		// Remove previous icon class
		chevron.className = 'chat-debug-message-section-chevron';
		updateState();
	}));
}

/**
 * Render a user message event with collapsible prompt sections.
 */
export function renderUserMessageContent(event: IChatDebugUserMessageEvent): { element: HTMLElement; disposables: DisposableStore } {
	const disposables = new DisposableStore();
	const container = $('div.chat-debug-message-content');
	container.tabIndex = 0;

	DOM.append(container, $('div.chat-debug-message-content-title', undefined, localize('chatDebug.userMessage', "User Message")));
	DOM.append(container, $('div.chat-debug-message-content-summary', undefined, event.message));

	if (event.sections.length > 0) {
		const sectionsContainer = DOM.append(container, $('div.chat-debug-message-sections'));
		DOM.append(sectionsContainer, $('div.chat-debug-message-sections-label', undefined,
			localize('chatDebug.promptSections', "Prompt Sections ({0}):", event.sections.length)));

		for (const section of event.sections) {
			renderCollapsibleSection(sectionsContainer, section, disposables);
		}
	}

	return { element: container, disposables };
}

/**
 * Render an agent response event with collapsible response sections.
 */
export function renderAgentResponseContent(event: IChatDebugAgentResponseEvent): { element: HTMLElement; disposables: DisposableStore } {
	const disposables = new DisposableStore();
	const container = $('div.chat-debug-message-content');
	container.tabIndex = 0;

	DOM.append(container, $('div.chat-debug-message-content-title', undefined, localize('chatDebug.agentResponse', "Agent Response")));
	DOM.append(container, $('div.chat-debug-message-content-summary', undefined, event.message));

	if (event.sections.length > 0) {
		const sectionsContainer = DOM.append(container, $('div.chat-debug-message-sections'));
		DOM.append(sectionsContainer, $('div.chat-debug-message-sections-label', undefined,
			localize('chatDebug.responseSections', "Response Sections ({0}):", event.sections.length)));

		for (const section of event.sections) {
			renderCollapsibleSection(sectionsContainer, section, disposables);
		}
	}

	return { element: container, disposables };
}

/**
 * Convert a user message or agent response event to plain text for clipboard / editor output.
 */
export function messageEventToPlainText(event: IChatDebugUserMessageEvent | IChatDebugAgentResponseEvent): string {
	const lines: string[] = [];
	const label = event.kind === 'userMessage' ? 'User Message' : 'Agent Response';
	lines.push(`${label}: ${event.message}`);
	lines.push('');

	for (const section of event.sections) {
		lines.push(`--- ${section.name} ---`);
		lines.push(section.content);
		lines.push('');
	}

	return lines.join('\n');
}
