/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Orientation, Sash, SashState } from '../../../../../base/browser/ui/sash/sash.js';
import { BreadcrumbsWidget } from '../../../../../base/browser/ui/breadcrumbs/breadcrumbsWidget.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { safeIntl } from '../../../../../base/common/date.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { defaultBreadcrumbsWidgetStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IChatDebugEventModelTurnContent, IChatDebugMessageSection, IChatDebugModelTurnEvent, IChatDebugService, IChatDebugUserMessageEvent } from '../../common/chatDebugService.js';
import { IChatService } from '../../common/chatService/chatService.js';
import { LocalChatSessionUri } from '../../common/model/chatUri.js';
import { appendSystemDrift, CacheDiffKind, diffPromptSignature, ICacheDiffResult, IComponentDrift, INormalizedMessage, parseInputMessages } from './chatDebugCacheDiff.js';
import { setupBreadcrumbKeyboardNavigation, TextBreadcrumbItem } from './chatDebugTypes.js';

const $ = DOM.$;
const numberFormatter = safeIntl.NumberFormat();
const timeFormatter = safeIntl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });

/** Default rail width in pixels. */
const RAIL_DEFAULT_WIDTH = 280;
const RAIL_MIN_WIDTH = 180;
const RAIL_MAX_WIDTH = 600;

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

/** A grouping of model turns sharing the same parent (one user request). */
interface ITurnGroup {
	readonly key: string;
	readonly userMessage: IChatDebugUserMessageEvent | undefined;
	readonly turns: readonly { readonly turn: IChatDebugModelTurnEvent; readonly index: number }[];
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
	private readonly rail: HTMLElement;
	private readonly railList: HTMLElement;
	private readonly content: HTMLElement;
	private readonly sash: Sash;
	private railWidth = RAIL_DEFAULT_WIDTH;
	private readonly loadDisposables = this._register(new DisposableStore());
	private readonly refreshScheduler: RunOnceScheduler;

	private currentSessionResource: URI | undefined;
	private modelTurns: IChatDebugModelTurnEvent[] = [];
	/** Selected turn (B side). A is computed as `selectedIndex - 1`. -1 = no explicit selection yet. */
	private selectedIndex = -1;

	/** Cache of resolved model-turn content keyed by event id. */
	private readonly resolvedCache = new Map<string, IChatDebugEventModelTurnContent | undefined>();

	/** Components currently expanded (by component name). */
	private readonly openComponents = new Set<string>(['system', 'tools']);

	/** Rail groups currently collapsed (by group key — the parent event id). */
	private readonly collapsedGroups = new Set<string>();

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

		// Body: 2-column split with resizable rail
		const body = DOM.append(this.container, $('.chat-debug-cache-body'));
		this.rail = DOM.append(body, $('.chat-debug-cache-rail'));
		this.rail.style.width = `${this.railWidth}px`;
		this.railList = DOM.append(this.rail, $('.chat-debug-cache-rail-list'));
		this.content = DOM.append(body, $('.chat-debug-cache-content'));

		this.sash = this._register(new Sash(body, {
			getVerticalSashLeft: () => this.railWidth,
		}, { orientation: Orientation.VERTICAL }));
		this.sash.state = SashState.Enabled;
		let sashStartWidth: number | undefined;
		this._register(this.sash.onDidStart(() => sashStartWidth = this.railWidth));
		this._register(this.sash.onDidEnd(() => {
			sashStartWidth = undefined;
			this.sash.layout();
		}));
		this._register(this.sash.onDidChange(e => {
			if (sashStartWidth === undefined) {
				return;
			}
			const delta = e.currentX - e.startX;
			const next = Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, sashStartWidth + delta));
			this.railWidth = next;
			this.rail.style.width = `${next}px`;
			this.sash.layout();
		}));

		this.refreshScheduler = this._register(new RunOnceScheduler(() => this.render(), 50));
	}

	setSession(sessionResource: URI): void {
		if (!this.currentSessionResource || this.currentSessionResource.toString() !== sessionResource.toString()) {
			this.resolvedCache.clear();
			this.selectedIndex = -1;
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
		const userMessages = events.filter((e): e is IChatDebugUserMessageEvent => e.kind === 'userMessage');

		if (this.modelTurns.length === 0) {
			const empty = DOM.append(this.content, $('.chat-debug-cache-empty'));
			empty.textContent = localize('chatDebug.cache.noTurns', "No model turns recorded for this session yet.");
			return;
		}

		// Default to the most recent turn on first display. Clamp to a valid index.
		if (this.selectedIndex < 0 || this.selectedIndex >= this.modelTurns.length) {
			this.selectedIndex = this.modelTurns.length - 1;
		}

		this.renderRail(buildTurnGroups(this.modelTurns, userMessages));
		this.renderTitleRow();

		const bEvent = this.modelTurns[this.selectedIndex];
		const aEvent = this.selectedIndex > 0 ? this.modelTurns[this.selectedIndex - 1] : undefined;

		if (!aEvent) {
			// No prior turn to diff against — still surface OTel-reported cache hit
			// and request metadata for the first turn of a session.
			const b = await this.resolveSide(bEvent);
			if (this.selectedIndex < 0 || this.modelTurns[this.selectedIndex] !== bEvent) {
				return;
			}
			this.renderSingleSummary(b);
			return;
		}

		const [a, b] = await Promise.all([this.resolveSide(aEvent), this.resolveSide(bEvent)]);
		// If the user changed selection while resolving, drop this render.
		if (this.selectedIndex < 0 || this.modelTurns[this.selectedIndex] !== bEvent) {
			return;
		}

		const diff = diffPromptSignature(a.inputMessages, b.inputMessages);
		const drift = appendSystemDrift([...diff.drift], a.system, b.system);

		this.renderSummary(a, b, diff);
		this.renderSignature(a, b, diff);
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

	private renderRail(groups: readonly ITurnGroup[]): void {
		for (const group of groups) {
			const collapsed = this.collapsedGroups.has(group.key);
			const header = DOM.append(this.railList, $('.chat-debug-cache-group-header'));
			if (collapsed) {
				header.classList.add('is-collapsed');
			}
			header.tabIndex = 0;
			header.setAttribute('role', 'button');
			header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
			header.title = localize('chatDebug.cache.toggleGroup', "Toggle group");

			const topLine = DOM.append(header, $('.chat-debug-cache-group-top'));
			DOM.append(topLine, $('span.chat-debug-cache-group-chev'));
			const headerLine = DOM.append(topLine, $('.chat-debug-cache-group-prompt'));
			headerLine.textContent = group.userMessage?.message?.trim() || localize('chatDebug.cache.unknownPrompt', "(no prompt captured)");
			const countBadge = DOM.append(topLine, $('span.chat-debug-cache-group-count'));
			countBadge.textContent = String(group.turns.length);

			const headerMeta = DOM.append(header, $('.chat-debug-cache-group-meta'));
			headerMeta.textContent = group.key;
			headerMeta.title = localize('chatDebug.cache.requestIdTooltip', "Request id: {0}", group.key);

			const toggle = () => {
				if (this.collapsedGroups.has(group.key)) {
					this.collapsedGroups.delete(group.key);
				} else {
					this.collapsedGroups.add(group.key);
				}
				this.refresh();
			};
			this.loadDisposables.add(DOM.addDisposableListener(header, DOM.EventType.CLICK, toggle));
			this.loadDisposables.add(DOM.addDisposableListener(header, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					toggle();
				}
			}));

			if (collapsed) {
				continue;
			}

			for (const { turn: evt, index: i } of group.turns) {
				const row = DOM.append(this.railList, $('.chat-debug-cache-turn'));
				if (i === this.selectedIndex) { row.classList.add('is-selected'); }
				const idx = DOM.append(row, $('.chat-debug-cache-turn-idx'));
				idx.textContent = String(i).padStart(2, ' ');

				const main = DOM.append(row, $('.chat-debug-cache-turn-main'));

				// Top line: agent source with bracketed cache hit, duration, and timestamp
				const top = DOM.append(main, $('.chat-debug-cache-turn-top'));
				const source = DOM.append(top, $('span.chat-debug-cache-turn-source'));
				source.textContent = evt.requestName || localize('chatDebug.cache.modelTurn', "Model Turn");
				if (evt.cachedTokens !== undefined && evt.inputTokens) {
					const hit = computeCacheHit(evt);
					const hitChip = DOM.append(top, $('span.chat-debug-cache-turn-chip.chat-debug-cache-turn-hit', undefined,
						localize('chatDebug.cache.hitChip', "[cache {0}%]", formatCachePctInt(hit))));
					if (hit < 90) {
						hitChip.classList.add('is-bad');
					}
				}
				if (evt.durationInMillis !== undefined) {
					DOM.append(top, $('span.chat-debug-cache-turn-chip', undefined, localize('chatDebug.cache.msChip', "[{0}ms]", numberFormatter.value.format(Math.round(evt.durationInMillis)))));
				}
				DOM.append(top, $('span.chat-debug-cache-turn-chip', undefined, `[${timeFormatter.value.format(evt.created)}]`));

				// Bottom line: model name
				if (evt.model) {
					const sub = DOM.append(main, $('.chat-debug-cache-turn-sub'));
					sub.textContent = evt.model;
				}

				row.title = localize('chatDebug.cache.turnHelp', "Click to compare this request against the previous one");
				this.loadDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => {
					if (this.selectedIndex !== i) {
						this.selectedIndex = i;
						this.refresh();
					}
				}));
			}
		}
	}

	private renderTitleRow(): void {
		const titleRow = DOM.append(this.content, $('.chat-debug-cache-title-row'));
		const title = DOM.append(titleRow, $('h2.chat-debug-cache-title'));
		title.textContent = localize('chatDebug.cacheExplorer.title', "Cache Explorer — Prefix Diff");
	}

	private renderSummary(a: ISideData, b: ISideData, diff: ICacheDiffResult): void {
		const row = DOM.append(this.content, $('.chat-debug-cache-summary'));
		row.appendChild(this.renderSideCard(a, localize('chatDebug.cache.previousRequest', "Previous request")));
		row.appendChild(this.renderSideCard(b, localize('chatDebug.cache.requestTitle', "Request")));

		const breakCard = DOM.append(row, $('.chat-debug-cache-card.break'));
		DOM.append(breakCard, $('.chat-debug-cache-card-h', undefined, localize('chatDebug.cache.performance', "Cache performance")));

		// Section 1: cache hit headline + absolute counts
		const hit = computeCacheHit(b.event);
		const inputTokens = b.event.inputTokens ?? 0;
		const cachedTokens = b.event.cachedTokens ?? 0;
		const lostTokens = Math.max(0, inputTokens - cachedTokens);
		const headline = DOM.append(breakCard, $('.chat-debug-cache-card-headline'));
		headline.textContent = localize('chatDebug.cache.hitHeadline', "{0}% cache hit", formatCachePct(hit));
		const counts = DOM.append(breakCard, $('.chat-debug-cache-card-sub'));
		counts.textContent = localize('chatDebug.cache.tokensReused',
			"{0} of {1} input tokens reused",
			numberFormatter.value.format(cachedTokens),
			numberFormatter.value.format(inputTokens),
		);

		// Section 2: where the cache broke
		DOM.append(breakCard, $('.chat-debug-cache-perf-rule'));
		DOM.append(breakCard, $('.chat-debug-cache-perf-section-h', undefined, localize('chatDebug.cache.whereBroke', "Where the cache broke")));
		const breakLine = DOM.append(breakCard, $('.chat-debug-cache-perf-line'));
		if (diff.break) {
			const componentName = diff.break.index === 0
				? localize('chatDebug.cache.firstMessage', "the first message")
				: `messages[${diff.break.index}]`;
			breakLine.textContent = localize('chatDebug.cache.breakAt',
				"At {0} \u2014 {1}",
				componentName,
				describeBreakKind(diff.break.kind, diff, b),
			);
			if (lostTokens > 0 && inputTokens > 0) {
				const lostPct = (lostTokens / inputTokens) * 100;
				const lossLine = DOM.append(breakCard, $('.chat-debug-cache-perf-line'));
				lossLine.textContent = localize('chatDebug.cache.lossLine',
					"Lost: {0} tokens ({1}% of this request)",
					numberFormatter.value.format(lostTokens),
					formatCachePct(lostPct),
				);
			}
		} else {
			breakLine.textContent = localize('chatDebug.cache.noBreak', "No prefix divergence detected.");
		}

		// Section 3: structural diff summary
		DOM.append(breakCard, $('.chat-debug-cache-perf-rule'));
		DOM.append(breakCard, $('.chat-debug-cache-perf-section-h', undefined, localize('chatDebug.cache.diffSummary', "Diff summary")));
		const summaryLine = DOM.append(breakCard, $('.chat-debug-cache-perf-line'));
		const inPlaceChanged = diff.counts.contentDrift + diff.counts.lengthChange;
		const addedInB = diff.counts.onlyInB;
		const droppedFromA = diff.counts.onlyInA;
		const parts: string[] = [
			localize('chatDebug.cache.summaryIdentical', "{0} identical", diff.counts.identical),
			localize('chatDebug.cache.summaryChanged', "{0} in-place changed", inPlaceChanged),
		];
		if (addedInB > 0) {
			parts.push(localize('chatDebug.cache.summaryAdded', "{0} added in this request", addedInB));
		}
		if (droppedFromA > 0) {
			parts.push(localize('chatDebug.cache.summaryDropped', "{0} dropped from previous", droppedFromA));
		}
		summaryLine.textContent = parts.join(' \u00b7 ');
	}

	private renderSideCard(data: ISideData, title?: string): HTMLElement {
		const card = $('.chat-debug-cache-card');
		if (title) {
			DOM.append(card, $('.chat-debug-cache-card-h', undefined, title));
		}
		this.appendKv(card, localize('chatDebug.cache.model', "model"), data.event.model ?? '\u2014');
		this.appendKv(card, localize('chatDebug.cache.inputTok', "input tok"), formatTokens(data.event.inputTokens));
		this.appendKv(card, localize('chatDebug.cache.cachedTok', "cached tok"), formatTokens(data.event.cachedTokens));
		this.appendKv(card, localize('chatDebug.cache.cacheHit', "cache hit"), `${formatCachePct(computeCacheHit(data.event))}%`);

		const startTime = data.event.created;
		const endTime = data.event.durationInMillis !== undefined
			? new Date(startTime.getTime() + data.event.durationInMillis)
			: undefined;
		this.appendKv(card, localize('chatDebug.cache.startTime', "startTime"), startTime.toISOString(), true);
		if (endTime) {
			this.appendKv(card, localize('chatDebug.cache.endTime', "endTime"), endTime.toISOString(), true);
		}
		if (data.event.durationInMillis !== undefined) {
			this.appendKv(card, localize('chatDebug.cache.duration', "duration"), `${numberFormatter.value.format(Math.round(data.event.durationInMillis))}ms`);
		}
		const ttft = data.content?.timeToFirstTokenInMillis;
		if (ttft !== undefined) {
			this.appendKv(card, localize('chatDebug.cache.ttft', "timeToFirstToken"), `${numberFormatter.value.format(Math.round(ttft))}ms`);
		}
		const requestId = data.content?.requestId ?? data.event.parentEventId ?? data.event.id;
		if (requestId) {
			this.appendKv(card, localize('chatDebug.cache.requestId', "requestId"), requestId, true);
		}
		return card;
	}

	/**
	 * Render the summary cards alone when there is no prior turn to diff
	 * against (e.g. the first request in a brand-new session). The OTel-
	 * reported cache hit is still useful here — the system prompt and tool
	 * definitions can already be cached from previous sessions.
	 */
	private renderSingleSummary(b: ISideData): void {
		const row = DOM.append(this.content, $('.chat-debug-cache-summary'));
		row.appendChild(this.renderSideCard(b, localize('chatDebug.cache.requestTitle', "Request")));

		const note = DOM.append(row, $('.chat-debug-cache-card.break'));
		DOM.append(note, $('.chat-debug-cache-card-h', undefined, localize('chatDebug.cache.firstRequest', "First request in session")));
		const headline = DOM.append(note, $('.chat-debug-cache-card-headline'));
		headline.textContent = `${formatCachePct(computeCacheHit(b.event))}%`;
		const sub = DOM.append(note, $('.chat-debug-cache-card-sub'));
		sub.textContent = localize('chatDebug.cache.firstRequestNote', "OTel-reported cache hit. Nothing earlier in this session to diff against \u2014 the system prompt and tools may still match a previous session's cache.");
	}

	private appendKv(parent: HTMLElement, key: string, value: string, copyable: boolean = false): void {
		const row = DOM.append(parent, $('.chat-debug-cache-kv'));
		DOM.append(row, $('span.k', undefined, key));
		const valueEl = DOM.append(row, $('span.v', undefined, value));
		if (copyable) {
			valueEl.classList.add('chat-debug-cache-request-id');
			valueEl.title = value;
		}
	}

	private renderSignature(a: ISideData, b: ISideData, diff: ICacheDiffResult): void {
		const section = DOM.append(this.content, $('.chat-debug-cache-section'));
		const heading = DOM.append(section, $('h3.chat-debug-cache-section-h'));
		heading.textContent = localize('chatDebug.cache.signatureHeading', "Prompt Signature");

		const legend = DOM.append(section, $('.chat-debug-cache-sig-legend'));
		for (const role of ['system', 'user', 'assistant', 'tool']) {
			const entry = DOM.append(legend, $('span.chat-debug-cache-sig-legend-entry'));
			DOM.append(entry, $(`span.chat-debug-cache-sig-swatch.role-${role}`));
			DOM.append(entry, DOM.$('span', undefined, role));
		}
		const driftEntry = DOM.append(legend, $('span.chat-debug-cache-sig-legend-entry'));
		DOM.append(driftEntry, $('span.chat-debug-cache-sig-swatch.role-drift'));
		DOM.append(driftEntry, DOM.$('span', undefined, localize('chatDebug.cache.driftLegend', "drift")));

		// Per-side byte sequences. We prepend a synthetic 'system' segment for
		// the system prompt so it shows up in the bar even though it's not in
		// the inputMessages array.
		interface ISegment {
			readonly role: string;
			readonly bytes: number;
			readonly drift: boolean;
			readonly label: string;
		}
		const toSegments = (side: ISideData, isA: boolean): ISegment[] => {
			const segs: ISegment[] = [];
			const sys = side.system;
			if (sys) {
				const other = isA ? b.system : a.system;
				segs.push({ role: 'system', bytes: sys.length, drift: sys !== (other ?? ''), label: 'system' });
			}
			side.inputMessages.forEach((m, i) => {
				const tok = diff.signature[i];
				const kind = tok?.kind;
				const drift = kind === CacheDiffKind.ContentDrift
					|| kind === CacheDiffKind.LengthChange
					|| (isA && kind === CacheDiffKind.OnlyInA)
					|| (!isA && kind === CacheDiffKind.OnlyInB);
				segs.push({ role: m.role, bytes: m.byteLength, drift, label: m.name ? `${m.role}-${m.name}` : m.role });
			});
			return segs;
		};

		const aSegs = toSegments(a, true);
		const bSegs = toSegments(b, false);
		const totalA = aSegs.reduce((s, x) => s + x.bytes, 0);
		const totalB = bSegs.reduce((s, x) => s + x.bytes, 0);
		const max = Math.max(totalA, totalB, 1);

		// Compute byte position of cache break inside each side's bar.
		const breakBytePos = (segs: readonly ISegment[]): number | undefined => {
			if (!diff.break) {
				return undefined;
			}
			// Skip the synthetic system segment when matching diff.break.index.
			let cumulative = 0;
			let skipSystem = segs[0]?.role === 'system';
			let idx = 0;
			for (const s of segs) {
				if (skipSystem) {
					cumulative += s.bytes;
					skipSystem = false;
					continue;
				}
				if (idx === diff.break.index) {
					return cumulative;
				}
				cumulative += s.bytes;
				idx++;
			}
			return cumulative;
		};

		const buildLane = (label: string, segs: readonly ISegment[], breakPos: number | undefined): HTMLElement => {
			const row = $('.chat-debug-cache-sig-lane-row');
			DOM.append(row, $('.chat-debug-cache-sig-lane-label', undefined, label));
			const bar = DOM.append(row, $('.chat-debug-cache-sig-bar'));
			let sideTotal = 0;
			for (const s of segs) {
				if (s.bytes <= 0) {
					sideTotal += s.bytes;
					continue;
				}
				const widthPct = (s.bytes / max) * 100;
				const seg = DOM.append(bar, $(`span.chat-debug-cache-sig-seg.role-${roleClass(s.role)}`));
				if (s.drift) {
					seg.classList.add('is-drift');
				}
				seg.style.width = `${widthPct}%`;
				seg.title = `${s.label}: ${numberFormatter.value.format(s.bytes)} chars` + (s.drift ? ` \u2014 drift` : '');
				if (s.bytes > max * 0.05) {
					seg.textContent = `${s.label}:${numberFormatter.value.format(s.bytes)}`;
				}
				sideTotal += s.bytes;
			}
			// Pad the lane so both sides share the same x scale.
			if (sideTotal < max) {
				const pad = DOM.append(bar, $('span.chat-debug-cache-sig-seg.role-empty'));
				pad.style.width = `${((max - sideTotal) / max) * 100}%`;
			}
			if (breakPos !== undefined && diff.break) {
				const line = DOM.append(bar, $('.chat-debug-cache-sig-break'));
				line.style.left = `${(breakPos / max) * 100}%`;
				line.title = localize('chatDebug.cache.breakLineTooltip', "Cache break at messages[{0}]", diff.break.index);
			}
			DOM.append(row, $('.chat-debug-cache-sig-lane-total', undefined, localize('chatDebug.cache.charsTotal', "{0} chars", numberFormatter.value.format(sideTotal))));
			return row;
		};

		const lanes = DOM.append(section, $('.chat-debug-cache-sig-lanes'));
		lanes.appendChild(buildLane(localize('chatDebug.cache.lanePrevious', "Previous"), aSegs, breakBytePos(aSegs)));
		lanes.appendChild(buildLane(localize('chatDebug.cache.laneCurrent', "Current"), bSegs, breakBytePos(bSegs)));

		// Single-line text summary below the bars.
		let shared = 0;
		for (const tok of diff.signature) {
			if (tok.kind === CacheDiffKind.Identical) {
				shared += tok.bByteLength ?? 0;
			} else {
				break;
			}
		}
		if (a.system && a.system === b.system) {
			shared += a.system.length;
		}
		const summary = DOM.append(section, $('.chat-debug-cache-sig-summary'));
		if (diff.break) {
			summary.textContent = localize('chatDebug.cache.signatureSummaryBreak',
				"{0} of {1} chars reused \u00b7 break at messages[{2}]",
				numberFormatter.value.format(shared),
				numberFormatter.value.format(totalB),
				diff.break.index,
			);
		} else {
			summary.textContent = localize('chatDebug.cache.signatureSummaryClean',
				"{0} of {1} chars reused \u00b7 no divergence detected",
				numberFormatter.value.format(shared),
				numberFormatter.value.format(totalB),
			);
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
		DOM.append(colA, $('h4', undefined, localize('chatDebug.cache.diffSideA', "Previous \u00b7 {0} B", numberFormatter.value.format(aSize))));
		const aBody = DOM.append(colA, DOM.$('div'));
		aBody.textContent = aText || localize('chatDebug.cache.notPresent', "(not present)");

		const colB = DOM.append(grid, $('.chat-debug-cache-diff-col'));
		DOM.append(colB, $('h4', undefined, localize('chatDebug.cache.diffSideB', "Current \u00b7 {0} B", numberFormatter.value.format(bSize))));
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

/**
 * Group model turns by request — turns that share the same `parentEventId`
 * belong to the same agent invocation (one user prompt). The group key is
 * used as the request id surfaced in the rail header.
 */
function buildTurnGroups(turns: readonly IChatDebugModelTurnEvent[], userMessages: readonly IChatDebugUserMessageEvent[]): readonly ITurnGroup[] {
	// Index user messages by their span id (and the live `user-msg-` prefixed variant).
	const userById = new Map<string, IChatDebugUserMessageEvent>();
	for (const um of userMessages) {
		if (!um.id) {
			continue;
		}
		userById.set(um.id, um);
		const stripped = um.id.startsWith('user-msg-') ? um.id.slice('user-msg-'.length) : um.id;
		userById.set(stripped, um);
	}

	const groups = new Map<string, { userMessage: IChatDebugUserMessageEvent | undefined; turns: { turn: IChatDebugModelTurnEvent; index: number }[] }>();
	const order: string[] = [];
	turns.forEach((turn, index) => {
		const key = turn.parentEventId ?? turn.id ?? `turn-${index}`;
		let entry = groups.get(key);
		if (!entry) {
			entry = { userMessage: userById.get(key) ?? userById.get(`user-msg-${key}`), turns: [] };
			groups.set(key, entry);
			order.push(key);
		}
		entry.turns.push({ turn, index });
	});
	return order.map(key => ({ key, userMessage: groups.get(key)!.userMessage, turns: groups.get(key)!.turns }));
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

/**
 * One-line human-readable description of the kind of change at the cache
 * break, including the role and size of the divergent message when known.
 */
function describeBreakKind(kind: Exclude<CacheDiffKind, CacheDiffKind.Identical>, diff: ICacheDiffResult, b: ISideData): string {
	const tok = diff.signature.find(t => t.index === diff.break?.index);
	const role = tok?.bRole ?? tok?.aRole ?? 'message';
	const bMsg = b.inputMessages[diff.break?.index ?? -1];
	const charsB = bMsg ? numberFormatter.value.format(bMsg.byteLength) : undefined;
	switch (kind) {
		case CacheDiffKind.OnlyInB:
			return charsB
				? localize('chatDebug.cache.kind.added', "added {0} message ({1} chars)", role, charsB)
				: localize('chatDebug.cache.kind.addedNoSize', "added {0} message", role);
		case CacheDiffKind.OnlyInA:
			return localize('chatDebug.cache.kind.dropped', "previous {0} message dropped", role);
		case CacheDiffKind.ContentDrift:
			return charsB
				? localize('chatDebug.cache.kind.contentDrift', "{0} message body changed ({1} chars)", role, charsB)
				: localize('chatDebug.cache.kind.contentDriftNoSize', "{0} message body changed", role);
		case CacheDiffKind.LengthChange:
			return charsB
				? localize('chatDebug.cache.kind.lengthChange', "{0} message resized to {1} chars", role, charsB)
				: localize('chatDebug.cache.kind.lengthChangeNoSize', "{0} message size changed", role);
	}
}

function computeCacheHit(event: IChatDebugModelTurnEvent): number {
	if (!event.inputTokens || event.cachedTokens === undefined) {
		return 0;
	}
	return Math.min(100, (event.cachedTokens / event.inputTokens) * 100);
}

/**
 * Maps a normalized message role onto the small set of CSS color classes
 * the prompt-signature visualization recognizes. Unknown roles fall through
 * to `tool` so they still get a swatch.
 */
function roleClass(role: string): string {
	switch (role) {
		case 'system':
		case 'user':
		case 'assistant':
		case 'tool':
			return role;
		default:
			return 'tool';
	}
}

/**
 * Format a cache hit percentage with 2-decimal precision, truncating rather
 * than rounding so a value like 99.998% does not display as 100%. We only
 * report a literal `100%` when the ratio is exactly 1.
 */
function formatCachePct(pct: number): string {
	const truncated = Math.floor(pct * 100) / 100;
	return truncated.toFixed(2);
}

/**
 * Integer-precision variant of {@link formatCachePct} for the rail chip.
 */
function formatCachePctInt(pct: number): string {
	return String(Math.floor(pct));
}

function formatTokens(value: number | undefined): string {
	if (value === undefined) {
		return '—';
	}
	return numberFormatter.value.format(value);
}
