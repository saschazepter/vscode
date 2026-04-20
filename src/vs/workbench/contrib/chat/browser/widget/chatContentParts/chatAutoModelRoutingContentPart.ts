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
		const content = $('.chat-auto-model-routing-details.chat-used-context-list');

		// Header line: "Auto Model Selection"
		const header = $('.chat-auto-model-routing-header', undefined,
			localize('autoModelRouting.header', "Copilot Auto Model Selection"));
		content.appendChild(header);

		// Selection reason
		const reasonRow = this.makeRow(
			localize('autoModelRouting.reason', "Reason"),
			this.routingPart.selectionReason
		);
		content.appendChild(reasonRow);

		// Detected intent
		if (this.routingPart.intent) {
			content.appendChild(this.makeRow(
				localize('autoModelRouting.intent', "Detected intent"),
				this.routingPart.intent
			));
		}

		// Confidence
		if (typeof this.routingPart.confidence === 'number') {
			const pct = Math.round(this.routingPart.confidence * 100);
			content.appendChild(this.makeRow(
				localize('autoModelRouting.confidence', "Confidence"),
				`${pct}%`
			));
		}

		// Predicted latency
		if (typeof this.routingPart.predictedLatencyMs === 'number') {
			content.appendChild(this.makeRow(
				localize('autoModelRouting.latency', "Predicted latency"),
				`${this.routingPart.predictedLatencyMs} ms`
			));
		}

		// Cost tier
		if (this.routingPart.costTier) {
			content.appendChild(this.makeRow(
				localize('autoModelRouting.cost', "Cost tier"),
				this.routingPart.costTier
			));
		}

		// Considered candidates
		if (this.routingPart.candidates && this.routingPart.candidates.length > 0) {
			const candHeader = $('.chat-auto-model-routing-subheader', undefined,
				localize('autoModelRouting.candidates', "Other models considered"));
			content.appendChild(candHeader);

			const list = $('ul.chat-auto-model-routing-candidates');
			for (const cand of this.routingPart.candidates) {
				const li = $('li.chat-auto-model-routing-candidate');
				const name = $('span.chat-auto-model-routing-candidate-name', undefined, cand.modelName);
				const score = $('span.chat-auto-model-routing-candidate-score', undefined, `${Math.round(cand.score * 100)}%`);
				li.appendChild(name);
				li.appendChild(score);
				if (cand.reason) {
					const reason = $('span.chat-auto-model-routing-candidate-reason', undefined, cand.reason);
					li.appendChild(reason);
				}
				list.appendChild(li);
			}
			content.appendChild(list);
		}

		return content;
	}

	private makeRow(label: string, value: string): HTMLElement {
		const row = $('.chat-auto-model-routing-row');
		row.appendChild($('span.chat-auto-model-routing-label', undefined, label));
		row.appendChild($('span.chat-auto-model-routing-value', undefined, value));
		return row;
	}

	hasSameContent(other: IChatRendererContent, _followingContent: IChatRendererContent[], _element: ChatTreeItem): boolean {
		if (other.kind !== 'autoModelRouting') {
			return false;
		}
		if (other.selectedModel !== this.routingPart.selectedModel
			|| other.selectionReason !== this.routingPart.selectionReason
			|| other.confidence !== this.routingPart.confidence
			|| other.predictedLatencyMs !== this.routingPart.predictedLatencyMs
			|| other.costTier !== this.routingPart.costTier
			|| other.intent !== this.routingPart.intent) {
			return false;
		}
		const a = this.routingPart.candidates ?? [];
		const b = other.candidates ?? [];
		if (a.length !== b.length) {
			return false;
		}
		for (let i = 0; i < a.length; i++) {
			if (a[i].modelName !== b[i].modelName
				|| a[i].score !== b[i].score
				|| a[i].reason !== b[i].reason) {
				return false;
			}
		}
		return true;
	}
}
