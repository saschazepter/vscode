/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { BreadcrumbsWidget } from '../../../../../base/browser/ui/breadcrumbs/breadcrumbsWidget.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { defaultBreadcrumbsWidgetStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IUntitledTextResourceEditorInput } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IChatDebugService } from '../../common/chatDebugService.js';
import { IChatService } from '../../common/chatService/chatService.js';
import { LocalChatSessionUri } from '../../common/model/chatUri.js';
import { generateSubagentFlowchart, renderVisualFlow } from './chatDebugSubagentChart.js';
import { TextBreadcrumbItem } from './chatDebugTypes.js';

const $ = DOM.$;

export const enum SubagentChartNavigation {
	Home = 'home',
	Overview = 'overview',
}

export class ChatDebugSubagentChartView extends Disposable {

	private readonly _onNavigate = this._register(new Emitter<SubagentChartNavigation>());
	readonly onNavigate = this._onNavigate.event;

	readonly container: HTMLElement;
	private readonly content: HTMLElement;
	private readonly breadcrumbWidget: BreadcrumbsWidget;
	private readonly renderDisposables = this._register(new DisposableStore());

	private currentSessionId: string = '';

	constructor(
		parent: HTMLElement,
		@IChatService private readonly chatService: IChatService,
		@IChatDebugService private readonly chatDebugService: IChatDebugService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this.container = DOM.append(parent, $('.chat-debug-subagent-chart'));
		DOM.hide(this.container);

		// Breadcrumb
		const breadcrumbContainer = DOM.append(this.container, $('.chat-debug-breadcrumb'));
		this.breadcrumbWidget = this._register(new BreadcrumbsWidget(breadcrumbContainer, 3, undefined, Codicon.chevronRight, defaultBreadcrumbsWidgetStyles));
		this._register(this.breadcrumbWidget.onDidSelectItem(e => {
			if (e.type === 'select' && e.item instanceof TextBreadcrumbItem) {
				this.breadcrumbWidget.setSelection(undefined);
				const items = this.breadcrumbWidget.getItems();
				const idx = items.indexOf(e.item);
				if (idx === 0) {
					this._onNavigate.fire(SubagentChartNavigation.Home);
				} else if (idx === 1) {
					this._onNavigate.fire(SubagentChartNavigation.Overview);
				}
			}
		}));

		this.content = DOM.append(this.container, $('.chat-debug-subagent-chart-content'));
	}

	setSession(sessionId: string): void {
		this.currentSessionId = sessionId;
	}

	show(): void {
		DOM.show(this.container);
		this.render();
	}

	hide(): void {
		DOM.hide(this.container);
	}

	updateBreadcrumb(): void {
		const sessionUri = LocalChatSessionUri.forSession(this.currentSessionId);
		const sessionTitle = this.chatService.getSessionTitle(sessionUri) || this.currentSessionId;
		this.breadcrumbWidget.setItems([
			new TextBreadcrumbItem(localize('chatDebug.title', "Chat Debug Panel"), true),
			new TextBreadcrumbItem(sessionTitle, true),
			new TextBreadcrumbItem(localize('chatDebug.subagentFlow', "Subagent Flow")),
		]);
	}

	render(): void {
		DOM.clearNode(this.content);
		this.renderDisposables.clear();
		this.updateBreadcrumb();

		const events = this.chatDebugService.getEvents(this.currentSessionId);
		const mermaidCode = generateSubagentFlowchart(events);

		// Title
		DOM.append(this.content, $('h3.chat-debug-subagent-chart-title', undefined, localize('chatDebug.subagentFlowDiagram', "Subagent Flow Diagram")));
		DOM.append(this.content, $('p.chat-debug-subagent-chart-desc', undefined, localize('chatDebug.subagentFlowDesc', "Mermaid flowchart showing the control flow between the main agent and sub-agents.")));

		// Actions bar
		const actionsBar = DOM.append(this.content, $('.chat-debug-subagent-chart-actions'));

		const copyBtn = DOM.append(actionsBar, $('button.chat-debug-overview-action-button', undefined, localize('chatDebug.copyMermaid', "Copy Mermaid")));
		this.renderDisposables.add(DOM.addDisposableListener(copyBtn, DOM.EventType.CLICK, () => {
			this.clipboardService.writeText(mermaidCode);
		}));

		const openBtn = DOM.append(actionsBar, $('button.chat-debug-overview-action-button', undefined, localize('chatDebug.openAsMarkdown', "Open as Markdown")));
		this.renderDisposables.add(DOM.addDisposableListener(openBtn, DOM.EventType.CLICK, () => {
			const mdContent = '```mermaid\n' + mermaidCode + '\n```\n';
			this.editorService.openEditor({
				contents: mdContent, resource: undefined, languageId: 'markdown'
			} satisfies IUntitledTextResourceEditorInput);
		}));

		// Visual flow
		const flowContainer = DOM.append(this.content, $('.chat-debug-subagent-flow-visual'));
		renderVisualFlow(flowContainer, events);
	}
}
