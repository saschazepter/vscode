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

		// Header row: title + detected intent chip (if any)
		const headerRow = $('.chat-auto-model-routing-header-row');
		const header = $('.chat-auto-model-routing-header', undefined,
			localize('autoModelRouting.header', "Copilot Auto Model Selection"));
		headerRow.appendChild(header);
		if (this.routingPart.intent) {
			headerRow.appendChild(this.makeChip(this.routingPart.intent));
		}
		content.appendChild(headerRow);

		// Reason text
		const reason = $('.chat-auto-model-routing-reason', undefined, this.routingPart.selectionReason);
		content.appendChild(reason);

		// Metadata chips row (confidence / latency / cost)
		const meta = $('.chat-auto-model-routing-meta');
		if (typeof this.routingPart.confidence === 'number') {
			meta.appendChild(this.makeChip(
				localize('autoModelRouting.confidence', "Confidence: {0}%", Math.round(this.routingPart.confidence * 100))
			));
		}
		if (typeof this.routingPart.predictedLatencyMs === 'number') {
			meta.appendChild(this.makeChip(
				localize('autoModelRouting.latency', "~{0} ms", this.routingPart.predictedLatencyMs)
			));
		}
		if (this.routingPart.costTier) {
			meta.appendChild(this.makeChip(
				localize('autoModelRouting.cost', "Cost: {0}", this.routingPart.costTier)
			));
		}
		if (meta.childElementCount > 0) {
			content.appendChild(meta);
		}

		// Build a unified ranked list: selected model (with synthetic score = confidence ?? 1)
		// followed by other candidates. Bars are scaled to the max score in the list so
		// the highest-scoring entry visually fills the row.
		const selectedScore = this.routingPart.confidence ?? 1;
		type Row = { name: string; score: number; reason?: string; selected: boolean };
		const rows: Row[] = [
			{ name: this.routingPart.selectedModel, score: selectedScore, reason: this.routingPart.selectionReason, selected: true },
			...(this.routingPart.candidates ?? []).map(c => ({ name: c.modelName, score: c.score, reason: c.reason, selected: false })),
		];
		const maxScore = Math.max(...rows.map(r => r.score), 0.0001);

		const subheader = $('.chat-auto-model-routing-subheader', undefined,
			localize('autoModelRouting.ranked', "Ranked candidates"));
		content.appendChild(subheader);

		const list = $('ul.chat-auto-model-routing-candidates');
		for (const row of rows) {
			list.appendChild(this.makeCandidateRow(row.name, row.score, maxScore, row.reason, row.selected));
		}
		content.appendChild(list);

		return content;
	}

	private makeChip(text: string): HTMLElement {
		return $('span.chat-auto-model-routing-chip', undefined, text);
	}

	private makeCandidateRow(name: string, score: number, maxScore: number, reason: string | undefined, selected: boolean): HTMLElement {
		const li = $(`li.chat-auto-model-routing-candidate${selected ? '.selected' : ''}`);

		const nameCol = $('.chat-auto-model-routing-candidate-name');
		if (selected) {
			const check = $('span.codicon.codicon-check.chat-auto-model-routing-check', { 'aria-hidden': 'true' });
			nameCol.appendChild(check);
		}
		nameCol.appendChild($('span', undefined, name));
		li.appendChild(nameCol);

		const barCol = $('.chat-auto-model-routing-bar-col');
		const bar = $('.chat-auto-model-routing-bar');
		const fill = $('.chat-auto-model-routing-bar-fill');
		const widthPct = Math.max(2, Math.round((score / maxScore) * 100));
		fill.style.width = `${widthPct}%`;
		bar.appendChild(fill);
		barCol.appendChild(bar);
		li.appendChild(barCol);

		const scoreLabel = $('.chat-auto-model-routing-candidate-score', undefined, `${Math.round(score * 100)}%`);
		li.appendChild(scoreLabel);

		if (reason) {
			const reasonRow = $('.chat-auto-model-routing-candidate-reason', undefined, reason);
			li.appendChild(reasonRow);
		}
		return li;
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
