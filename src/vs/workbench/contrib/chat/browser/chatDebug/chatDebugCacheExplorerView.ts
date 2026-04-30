/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { BreadcrumbsWidget } from '../../../../../base/browser/ui/breadcrumbs/breadcrumbsWidget.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { safeIntl } from '../../../../../base/common/date.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { defaultBreadcrumbsWidgetStyles, defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IChatDebugEventModelTurnContent, IChatDebugMessageSection, IChatDebugModelTurnEvent, IChatDebugService } from '../../common/chatDebugService.js';
import { IChatService } from '../../common/chatService/chatService.js';
import { LocalChatSessionUri } from '../../common/model/chatUri.js';
import { appendSystemDrift, CacheDiffKind, diffPromptSignature, formatSignatureToken, ICacheDiffResult, ICacheSignatureToken, IComponentDrift, INormalizedMessage, parseInputMessages } from './chatDebugCacheDiff.js';
import { setupBreadcrumbKeyboardNavigation, TextBreadcrumbItem } from './chatDebugTypes.js';

const $ = DOM.$;
const numberFormatter = safeIntl.NumberFormat();
const timeFormatter = safeIntl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });

/**
 * Navigation events fired by the Cache Explorer breadcrumb.
 */
export const enum CacheExplorerNavigation {
	Home = 'home',
	Overview = 'overview',
}

/** Resolved data for one A or B side. */
interface ISideData {
	readonly event: IChatDebugModelTurnEvent;
	readonly content: IChatDebugEventModelTurnContent | undefined;
	readonly system: string | undefined;
	readonly inputMessages: readonly INormalizedMessage[];
}

/**
 * Cache Explorer view — the third entry under "Explore Trace Data". Shows a
 * left rail of model turns with their cache hit %, plus a side-by-side prompt
 * signature diff that pinpoints where the prefix breaks.
 *
 * v1 reads {@link IChatDebugEventModelTurnContent} from the in-memory chat
 * debug service via {@link IChatDebugService.resolveEvent}. Content may be
 * truncated by the OTel attribute cap; the file-logger backed full-fidelity
 * provider is a follow-up.
 */
export class ChatDebugCacheExplorerView extends Disposable {

	private readonly _onNavigate = this._register(new Emitter<CacheExplorerNavigation>());
	readonly onNavigate = this._onNavigate.event;

	readonly container: HTMLElement;
	private readonly breadcrumbWidget: BreadcrumbsWidget;
	private readonly railList: HTMLElement;
	private readonly content: HTMLElement;
	private readonly loadDisposables = this._register(new DisposableStore());
	private readonly refreshScheduler: RunOnceScheduler;

	private currentSessionResource: URI | undefined;
	private modelTurns: IChatDebugModelTurnEvent[] = [];
	private aIndex = 0;
	private bIndex = 1;
	private filterFlags = { content: true, onlyA: true, onlyB: true, identical: true };

	/** Cache of resolved model-turn content keyed by event id. */
	private readonly resolvedCache = new Map<string, IChatDebugEventModelTurnContent | undefined>();

	/** Components currently expanded (by component name). */
	private readonly openComponents = new Set<string>(['system', 'tools']);

	constructor(
		parent: HTMLElement,
		@IChatService private readonly chatService: IChatService,
		@IChatDebugService private readonly chatDebugService: IChatDebugService,
	) {
		super();
		this.container = DOM.append(parent, $('.chat-debug-cache'));
		DOM.hide(this.container);

		// Breadcrumb
		const breadcrumbContainer = DOM.append(this.container, $('.chat-debug-breadcrumb'));
		this.breadcrumbWidget = this._register(new BreadcrumbsWidget(breadcrumbContainer, 3, undefined, Codicon.chevronRight, defaultBreadcrumbsWidgetStyles));
		this._register(setupBreadcrumbKeyboardNavigation(breadcrumbContainer, this.breadcrumbWidget));
		this._register(this.breadcrumbWidget.onDidSelectItem(e => {
			if (e.type === 'select' && e.item instanceof TextBreadcrumbItem) {
				this.breadcrumbWidget.setSelection(undefined);
				const items = this.breadcrumbWidget.getItems();
				const idx = items.indexOf(e.item);
				if (idx === 0) {
					this._onNavigate.fire(CacheExplorerNavigation.Home);
				} else if (idx === 1) {
					this._onNavigate.fire(CacheExplorerNavigation.Overview);
				}
			}
		}));

		// Body: 2-column split
		const body = DOM.append(this.container, $('.chat-debug-cache-body'));
		const rail = DOM.append(body, $('.chat-debug-cache-rail'));
		this.railList = DOM.append(rail, $('.chat-debug-cache-rail-list'));
		this.content = DOM.append(body, $('.chat-debug-cache-content'));

		this.refreshScheduler = this._register(new RunOnceScheduler(() => this.render(), 50));
	}

	setSession(sessionResource: URI): void {
		if (!this.currentSessionResource || this.currentSessionResource.toString() !== sessionResource.toString()) {
			this.resolvedCache.clear();
			this.aIndex = 0;
			this.bIndex = 1;
		}
		this.currentSessionResource = sessionResource;
	}

	show(): void {
		DOM.show(this.container);
		this.render();
	}

	hide(): void {
		DOM.hide(this.container);
		this.refreshScheduler.cancel();
	}

	refresh(): void {
		if (this.container.style.display !== 'none' && !this.refreshScheduler.isScheduled()) {
			this.refreshScheduler.schedule();
		}
	}

	updateBreadcrumb(): void {
		if (!this.currentSessionResource) {
			return;
		}
		const sessionTitle = this.chatService.getSessionTitle(this.currentSessionResource) || LocalChatSessionUri.parseLocalSessionId(this.currentSessionResource) || this.currentSessionResource.toString();
		this.breadcrumbWidget.setItems([
			new TextBreadcrumbItem(localize('chatDebug.title', "Agent Debug Logs"), true),
			new TextBreadcrumbItem(sessionTitle, true),
			new TextBreadcrumbItem(localize('chatDebug.cacheExplorer', "Cache Explorer")),
		]);
	}

	private async render(): Promise<void> {
		this.updateBreadcrumb();
		this.loadDisposables.clear();
		DOM.clearNode(this.railList);
		DOM.clearNode(this.content);

		if (!this.currentSessionResource) {
			return;
		}

		const events = this.chatDebugService.getEvents(this.currentSessionResource);
		this.modelTurns = events.filter((e): e is IChatDebugModelTurnEvent => e.kind === 'modelTurn');

		if (this.modelTurns.length === 0) {
			const empty = DOM.append(this.content, $('.chat-debug-cache-empty'));
			empty.textContent = localize('chatDebug.cache.noTurns', "No model turns recorded for this session yet.");
			return;
		}

		// Clamp indices
		this.bIndex = Math.min(Math.max(this.bIndex, 0), this.modelTurns.length - 1);
		this.aIndex = Math.min(Math.max(this.aIndex, 0), this.modelTurns.length - 1);
		if (this.modelTurns.length > 1 && this.aIndex === this.bIndex) {
			this.aIndex = Math.max(0, this.bIndex - 1);
		}

		this.renderRail();

		const a = await this.resolveSide(this.modelTurns[this.aIndex]);
		const b = await this.resolveSide(this.modelTurns[this.bIndex]);
		// If the user changed selection while resolving, drop this render.
		if (a.event !== this.modelTurns[this.aIndex] || b.event !== this.modelTurns[this.bIndex]) {
			return;
		}

		const diff = diffPromptSignature(a.inputMessages, b.inputMessages);
		const drift = appendSystemDrift([...diff.drift], a.system, b.system);

		this.renderTitleRow();
		this.renderSummary(a, b, diff);
		this.renderSignature(diff);
		this.renderComponents(drift, a, b);
	}

	private async resolveSide(event: IChatDebugModelTurnEvent): Promise<ISideData> {
		let content: IChatDebugEventModelTurnContent | undefined;
		if (event.id) {
			if (this.resolvedCache.has(event.id)) {
				content = this.resolvedCache.get(event.id);
			} else {
				const r = await this.chatDebugService.resolveEvent(event.id);
				content = r && r.kind === 'modelTurn' ? r : undefined;
				this.resolvedCache.set(event.id, content);
			}
		}
		const system = findSection(content?.sections, 'System');
		const inputMessagesJson = findSection(content?.sections, 'Input Messages');
		const inputMessages = parseInputMessages(inputMessagesJson);
		return { event, content, system, inputMessages };
	}

	private renderRail(): void {
		this.modelTurns.forEach((evt, i) => {
			const row = DOM.append(this.railList, $('.chat-debug-cache-turn'));
			if (i === this.aIndex) { row.classList.add('is-a'); }
			if (i === this.bIndex) { row.classList.add('is-b'); }
			const idx = DOM.append(row, $('.chat-debug-cache-turn-idx'));
			idx.textContent = String(i).padStart(2, ' ');

			const main = DOM.append(row, $('.chat-debug-cache-turn-main'));
			const label = DOM.append(main, $('.chat-debug-cache-turn-label'));
			label.textContent = evt.model || evt.requestName || localize('chatDebug.cache.modelTurn', "Model Turn");
			const meta = DOM.append(main, $('.chat-debug-cache-turn-meta'));
			meta.appendChild(DOM.$('span', undefined, formatTokens(evt.inputTokens)));
			const hit = computeCacheHit(evt);
			const bar = DOM.append(meta, $('.chat-debug-cache-bar'));
			if (hit < 70) { bar.classList.add('bad'); }
			else if (hit < 95) { bar.classList.add('warn'); }
			const fill = DOM.append(bar, DOM.$('i'));
			fill.style.width = `${Math.max(2, hit)}%`;
			meta.appendChild(DOM.$('span', undefined, localize('chatDebug.cache.hitPct', "cache {0}%", hit.toFixed(0))));

			const ts = DOM.append(row, $('.chat-debug-cache-turn-ts'));
			ts.textContent = timeFormatter.value.format(evt.created);

			row.title = localize('chatDebug.cache.turnHelp', "Click to set as B · Shift-click to set as A");
			this.loadDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, (e: MouseEvent) => {
				if (e.shiftKey) {
					this.aIndex = i;
				} else {
					this.bIndex = i;
				}
				if (this.aIndex === this.bIndex) {
					this.aIndex = Math.max(0, this.bIndex - 1);
				}
				this.refresh();
			}));
		});
	}

	private renderTitleRow(): void {
		const titleRow = DOM.append(this.content, $('.chat-debug-cache-title-row'));
		const title = DOM.append(titleRow, $('h2.chat-debug-cache-title'));
		title.textContent = localize('chatDebug.cacheExplorer.title', "Cache Explorer — Prefix Diff");

		const actions = DOM.append(titleRow, $('.chat-debug-cache-title-actions'));
		const prevBtn = this.loadDisposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true, title: localize('chatDebug.cache.prevPair', "Previous pair") }));
		prevBtn.label = localize('chatDebug.cache.prevPair', "Previous pair");
		this.loadDisposables.add(prevBtn.onDidClick(() => {
			if (this.bIndex > 1) {
				this.bIndex--;
				this.aIndex = this.bIndex - 1;
				this.refresh();
			}
		}));
		const nextBtn = this.loadDisposables.add(new Button(actions, { ...defaultButtonStyles, secondary: true, title: localize('chatDebug.cache.nextPair', "Next pair") }));
		nextBtn.label = localize('chatDebug.cache.nextPair', "Next pair");
		this.loadDisposables.add(nextBtn.onDidClick(() => {
			if (this.bIndex < this.modelTurns.length - 1) {
				this.bIndex++;
				this.aIndex = this.bIndex - 1;
				this.refresh();
			}
		}));
		const swapBtn = this.loadDisposables.add(new Button(actions, { ...defaultButtonStyles, title: localize('chatDebug.cache.swapTitle', "Swap A and B") }));
		swapBtn.label = localize('chatDebug.cache.swapLabel', "Swap A ↔ B");
		this.loadDisposables.add(swapBtn.onDidClick(() => {
			const tmp = this.aIndex;
			this.aIndex = this.bIndex;
			this.bIndex = tmp;
			this.refresh();
		}));
	}

	private renderSummary(a: ISideData, b: ISideData, diff: ICacheDiffResult): void {
		const row = DOM.append(this.content, $('.chat-debug-cache-summary'));
		row.appendChild(this.renderSideCard('A', a));
		row.appendChild(this.renderSideCard('B', b));

		const breakCard = DOM.append(row, $('.chat-debug-cache-card.break'));
		DOM.append(breakCard, $('.chat-debug-cache-card-h', undefined, localize('chatDebug.cache.breakAnalysis', "Cache-break analysis")));
		const headline = DOM.append(breakCard, $('.chat-debug-cache-card-headline'));
		const sharedPct = b.event.inputTokens && b.event.cachedTokens !== undefined
			? Math.round((b.event.cachedTokens / b.event.inputTokens) * 100)
			: 0;
		headline.textContent = localize('chatDebug.cache.sharedPrefix', "~{0}% shared prefix", sharedPct);
		const sub = DOM.append(breakCard, $('.chat-debug-cache-card-sub'));
		if (diff.break) {
			const componentName = diff.break.index === 0
				? localize('chatDebug.cache.firstMessage', "the first message")
				: `messages[${diff.break.index}]`;
			sub.textContent = localize('chatDebug.cache.breakLocation', "Cache breaks at {0}. Anything after this point cannot reuse cache from A.", componentName);
		} else {
			sub.textContent = localize('chatDebug.cache.noBreak', "No prefix divergence detected.");
		}
		const pills = DOM.append(breakCard, $('.chat-debug-cache-pills'));
		this.appendPill(pills, 'drift', localize('chatDebug.cache.contentDriftCount', "{0} content drift", diff.counts.contentDrift + diff.counts.lengthChange));
		this.appendPill(pills, 'oneSided', localize('chatDebug.cache.oneSidedCount', "{0} one-sided", diff.counts.onlyInA + diff.counts.onlyInB));
		this.appendPill(pills, 'identical', localize('chatDebug.cache.identicalCount', "{0} identical", diff.counts.identical));
	}

	private renderSideCard(side: 'A' | 'B', data: ISideData): HTMLElement {
		const card = $(`.chat-debug-cache-card.side-${side.toLowerCase()}`);
		const header = DOM.append(card, $('.chat-debug-cache-card-h'));
		const tag = DOM.append(header, $(`span.chat-debug-cache-tag.tag-${side.toLowerCase()}`));
		tag.textContent = side;
		const idLabel = DOM.append(header, DOM.$('span'));
		idLabel.textContent = (data.event.id ?? '').slice(0, 8).toUpperCase() || side;
		this.appendKv(card, localize('chatDebug.cache.when', "when"), timeFormatter.value.format(data.event.created));
		this.appendKv(card, localize('chatDebug.cache.model', "model"), data.event.model ?? '—');
		this.appendKv(card, localize('chatDebug.cache.inputTok', "input tok"), formatTokens(data.event.inputTokens));
		this.appendKv(card, localize('chatDebug.cache.cachedTok', "cached tok"), formatTokens(data.event.cachedTokens));
		this.appendKv(card, localize('chatDebug.cache.cacheHit', "cache hit"), `${computeCacheHit(data.event).toFixed(1)}%`);
		return card;
	}

	private appendKv(parent: HTMLElement, key: string, value: string): void {
		const row = DOM.append(parent, $('.chat-debug-cache-kv'));
		DOM.append(row, $('span.k', undefined, key));
		DOM.append(row, $('span.v', undefined, value));
	}

	private appendPill(parent: HTMLElement, kind: string, text: string): void {
		const pill = DOM.append(parent, $(`.chat-debug-cache-pill.${kind}`));
		pill.textContent = text;
	}

	private renderSignature(diff: ICacheDiffResult): void {
		const section = DOM.append(this.content, $('.chat-debug-cache-section'));
		const heading = DOM.append(section, $('h3.chat-debug-cache-section-h'));
		heading.textContent = localize('chatDebug.cache.signatureHeading', "Prompt Signature");
		const sig = DOM.append(section, $('.chat-debug-cache-signature'));

		let breakInserted = false;
		for (const tok of diff.signature) {
			if (!this.tokenPassesFilter(tok)) {
				continue;
			}
			const span = DOM.append(sig, $(`span.chat-debug-cache-sig-tok.${tok.kind}`));
			span.textContent = formatSignatureToken(tok);
			if (!breakInserted && diff.break && tok.index === diff.break.index) {
				const marker = DOM.append(sig, $('span.chat-debug-cache-sig-tok.break-marker'));
				marker.textContent = localize('chatDebug.cache.breakMarker', "cache break");
				breakInserted = true;
			}
		}

		// Filter toggles
		const toggle = DOM.append(section, $('.chat-debug-cache-show-toggle'));
		DOM.append(toggle, $('span', undefined, localize('chatDebug.cache.showLabel', "SHOW:")));
		this.appendFilterCheckbox(toggle, 'content', localize('chatDebug.cache.filterContent', "content"));
		this.appendFilterCheckbox(toggle, 'onlyA', localize('chatDebug.cache.filterOnlyA', "only-A"));
		this.appendFilterCheckbox(toggle, 'onlyB', localize('chatDebug.cache.filterOnlyB', "only-B"));
		this.appendFilterCheckbox(toggle, 'identical', localize('chatDebug.cache.filterIdentical', "identical"));
	}

	private appendFilterCheckbox(parent: HTMLElement, key: keyof typeof this.filterFlags, label: string): void {
		const wrapper = DOM.append(parent, DOM.$('label'));
		const input = DOM.append(wrapper, DOM.$('input')) as HTMLInputElement;
		input.type = 'checkbox';
		input.checked = this.filterFlags[key];
		this.loadDisposables.add(DOM.addDisposableListener(input, DOM.EventType.CHANGE, () => {
			this.filterFlags[key] = input.checked;
			this.refresh();
		}));
		const text = DOM.append(wrapper, DOM.$('span'));
		text.textContent = label;
	}

	private tokenPassesFilter(token: ICacheSignatureToken): boolean {
		switch (token.kind) {
			case CacheDiffKind.Identical: return this.filterFlags.identical;
			case CacheDiffKind.OnlyInA: return this.filterFlags.onlyA;
			case CacheDiffKind.OnlyInB: return this.filterFlags.onlyB;
			case CacheDiffKind.ContentDrift:
			case CacheDiffKind.LengthChange:
				return this.filterFlags.content;
		}
	}

	private renderComponents(drift: readonly IComponentDrift[], a: ISideData, b: ISideData): void {
		const section = DOM.append(this.content, $('.chat-debug-cache-section'));
		DOM.append(section, $('h3.chat-debug-cache-section-h', undefined, localize('chatDebug.cache.componentsHeading', "Components")));
		const acc = DOM.append(section, $('.chat-debug-cache-acc'));

		if (drift.length === 0) {
			const empty = DOM.append(acc, $('.chat-debug-cache-acc-empty'));
			empty.textContent = localize('chatDebug.cache.allComponentsIdentical', "All components are identical between A and B.");
			return;
		}

		for (const c of drift) {
			const item = DOM.append(acc, $('.chat-debug-cache-acc-item'));
			if (this.openComponents.has(c.name)) { item.classList.add('open'); }
			const head = DOM.append(item, $('.chat-debug-cache-acc-head'));
			DOM.append(head, $('span.chat-debug-cache-chev'));
			const name = DOM.append(head, $('.chat-debug-cache-acc-name'));
			if (c.role) { DOM.append(name, $('span.role', undefined, c.role)); }
			DOM.append(name, DOM.$('span', undefined, c.name));
			const badge = DOM.append(head, $(`span.chat-debug-cache-acc-badge.${c.status}`));
			badge.textContent = badgeLabel(c.status);
			const sizes = DOM.append(head, $('span.chat-debug-cache-acc-sizes'));
			sizes.textContent = `${formatTokens(c.aSize)} → ${formatTokens(c.bSize)} B`;

			const body = DOM.append(item, $('.chat-debug-cache-acc-body'));
			const aText = textForComponent(c, a);
			const bText = textForComponent(c, b);
			body.appendChild(this.renderComponentDiff(aText, bText, c.aSize, c.bSize));

			this.loadDisposables.add(DOM.addDisposableListener(head, DOM.EventType.CLICK, () => {
				if (this.openComponents.has(c.name)) {
					this.openComponents.delete(c.name);
					item.classList.remove('open');
				} else {
					this.openComponents.add(c.name);
					item.classList.add('open');
				}
			}));
		}
	}

	private renderComponentDiff(aText: string, bText: string, aSize: number, bSize: number): HTMLElement {
		const grid = $('.chat-debug-cache-diff');
		const colA = DOM.append(grid, $('.chat-debug-cache-diff-col'));
		DOM.append(colA, $('h4', undefined, localize('chatDebug.cache.diffSideA', "A \u00b7 {0} B", numberFormatter.value.format(aSize))));
		const aBody = DOM.append(colA, DOM.$('div'));
		aBody.textContent = aText || localize('chatDebug.cache.notPresent', "(not present)");

		const colB = DOM.append(grid, $('.chat-debug-cache-diff-col'));
		DOM.append(colB, $('h4', undefined, localize('chatDebug.cache.diffSideB', "B \u00b7 {0} B", numberFormatter.value.format(bSize))));
		const bBody = DOM.append(colB, DOM.$('div'));
		bBody.textContent = bText || localize('chatDebug.cache.notPresent', "(not present)");
		return grid;
	}
}

function findSection(sections: readonly IChatDebugMessageSection[] | undefined, name: string): string | undefined {
	if (!sections) {
		return undefined;
	}
	for (const s of sections) {
		if (s.name === name) {
			return s.content;
		}
	}
	return undefined;
}

function textForComponent(c: IComponentDrift, side: ISideData): string {
	if (c.name === 'system') {
		return side.system ?? '';
	}
	const m = /^messages\[(\d+)\]$/.exec(c.name);
	if (m) {
		const idx = parseInt(m[1], 10);
		return side.inputMessages[idx]?.text ?? '';
	}
	return '';
}

function badgeLabel(status: CacheDiffKind): string {
	switch (status) {
		case CacheDiffKind.Identical: return localize('chatDebug.cache.badge.identical', "identical");
		case CacheDiffKind.ContentDrift: return localize('chatDebug.cache.badge.contentDrift', "content drift");
		case CacheDiffKind.LengthChange: return localize('chatDebug.cache.badge.lengthChange', "length change");
		case CacheDiffKind.OnlyInA: return localize('chatDebug.cache.badge.onlyA', "only in A");
		case CacheDiffKind.OnlyInB: return localize('chatDebug.cache.badge.onlyB', "only in B");
	}
}

function computeCacheHit(event: IChatDebugModelTurnEvent): number {
	if (!event.inputTokens || event.cachedTokens === undefined) {
		return 0;
	}
	return Math.min(100, (event.cachedTokens / event.inputTokens) * 100);
}

function formatTokens(value: number | undefined): string {
	if (value === undefined) {
		return '—';
	}
	return numberFormatter.value.format(value);
}
