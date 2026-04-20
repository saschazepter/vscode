/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { localize } from '../../../../../../nls.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hover.js';
import { IChatAutoModelRoutingPart } from '../../../common/chatService/chatService.js';
import { IChatRendererContent } from '../../../common/model/chatViewModel.js';
import { ChatTreeItem } from '../../chat.js';
import { ChatCollapsibleContentPart } from './chatCollapsibleContentPart.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';
import './media/chatAutoModelRoutingContentPart.css';

export class ChatAutoModelRoutingContentPart extends ChatCollapsibleContentPart implements IChatContentPart {

	constructor(
		private readonly routingPart: IChatAutoModelRoutingPart,
		context: IChatContentPartRenderContext,
		@IHoverService hoverService: IHoverService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		const title = localize('autoModelRouting.title', "Routed to {0}", routingPart.selectedModel);
		super(title, context, undefined, hoverService, configurationService);

		this.icon = Codicon.sparkle;
		this.domNode.classList.add('chat-auto-model-routing');
		this.setExpanded(false);
	}

	protected override initContent(): HTMLElement {
		const container = $('.chat-auto-model-routing-body');

		// Build capability sentence from top 2 capabilities by score
		const caps = this.routingPart.capabilities;
		let capSentence: string;
		if (caps && caps.length >= 2) {
			const top = [...caps].sort((a, b) => b.score - a.score).slice(0, 2).map(c => c.name.toLowerCase());
			capSentence = localize('autoModelRouting.capSentence', "{0} is selected for high {1} and {2} capability. ",
				this.routingPart.selectedModel, top[0], top[1]);
		} else if (caps && caps.length === 1) {
			capSentence = localize('autoModelRouting.capSentenceSingle', "{0} is selected for high {1} capability. ",
				this.routingPart.selectedModel, caps[0].name.toLowerCase());
		} else {
			capSentence = '';
		}

		const para = $('.chat-auto-model-routing-footer');
		para.appendChild($('span', undefined, capSentence));
		para.appendChild($('span', undefined,
			localize('autoModelRouting.footer', "Auto routes based on your task and real-time system health and model performance. ")));
		const learnMore = $('a.chat-auto-model-routing-learn-more', { href: 'https://aka.ms/copilot-auto-model', target: '_blank' },
			localize('autoModelRouting.learnMore', "Learn more"));
		para.appendChild(learnMore);
		container.appendChild(para);

		// Capability score list
		if (this.routingPart.capabilities && this.routingPart.capabilities.length > 0) {
			container.appendChild($('span.chat-auto-model-routing-section-label', undefined,
				localize('autoModelRouting.capabilities', "Task requirements")));
			const list = $('ul.chat-auto-model-routing-scores');
			for (const cap of this.routingPart.capabilities) {
				const li = $('li.chat-auto-model-routing-score-row');
				li.appendChild($('span.chat-auto-model-routing-score-name', undefined, cap.name));
				li.appendChild($('span.chat-auto-model-routing-score-pct', undefined, `${Math.round(cap.score * 100)}%`));
				list.appendChild(li);
			}
			container.appendChild(list);
		}

		return container;
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: ChatTreeItem): boolean {
		if (other.kind !== 'autoModelRouting') {
			return false;
		}
		if (other.selectedModel !== this.routingPart.selectedModel
			|| other.selectionReason !== this.routingPart.selectionReason) {
			return false;
		}
		const a = this.routingPart.candidates ?? [];
		const b = other.candidates ?? [];
		if (a.length !== b.length) {
			return false;
		}
		for (let i = 0; i < a.length; i++) {
			if (a[i].modelName !== b[i].modelName) {
				return false;
			}
		}
		const ca = this.routingPart.capabilities ?? [];
		const cb = other.capabilities ?? [];
		if (ca.length !== cb.length) {
			return false;
		}
		for (let i = 0; i < ca.length; i++) {
			if (ca[i].name !== cb[i].name || ca[i].score !== cb[i].score) {
				return false;
			}
		}
		return true;
	}
}


