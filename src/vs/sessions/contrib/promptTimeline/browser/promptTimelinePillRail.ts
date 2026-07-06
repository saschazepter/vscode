/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { PromptTimelineCard } from './promptTimelineCard.js';
import { PromptFileDiff, PromptTick } from './promptTimelineModel.js';
import { IPromptReviewFileEvent, IPromptTimelineRail } from './promptTimelineRail.js';
import './media/promptTimeline.css';

/** Layout constants for the vertical-fit calculation. */
const VERTICAL_PADDING = 24;
/** Resting size of each dense mark's slot; the mark under the pointer/focus expands to MIN_TARGET. */
const DENSE_SLOT = 8;
/** Minimum clickable target size (WCAG 2.5.8): the focused/hovered mark expands to at least this tall. */
const MIN_TARGET = 24;
/** Fewest ticks worth showing; below this the rail hides. */
const MIN_VISIBLE_TICKS = 2;
/** Below this transcript width the rail hides so it does not crowd the content. */
const MIN_HOST_WIDTH = 320;

/**
 * The dense-pill rail. Marks stay quiet, gray and dense; only the mark under the
 * pointer (or keyboard focus) expands to a >=24px pill and reveals its green/red
 * diff. Hovering/focusing a mark shows the interactive preview card.
 */
export class PromptTimelinePillRail extends Disposable implements IPromptTimelineRail {

	private readonly _domNode: HTMLElement;
	private readonly _surface: HTMLElement;
	private readonly _ticksContainer: HTMLElement;
	private readonly _card: PromptTimelineCard;
	private readonly _tickDisposables = this._register(new DisposableStore());
	private readonly _tickElements: HTMLButtonElement[] = [];
	private readonly _ticks: PromptTick[] = [];

	private _activeRequestId: string | undefined;
	private _resizeObserverReady = false;
	private _hostWidth = Number.POSITIVE_INFINITY;
	private _capacity = Number.POSITIVE_INFINITY;

	private readonly _onDidSelect = this._register(new Emitter<string>());
	readonly onDidSelect: Event<string> = this._onDidSelect.event;

	private readonly _onDidReview = this._register(new Emitter<PromptTick>());
	readonly onDidReview: Event<PromptTick> = this._onDidReview.event;

	private readonly _onDidReviewFile = this._register(new Emitter<IPromptReviewFileEvent>());
	readonly onDidReviewFile: Event<IPromptReviewFileEvent> = this._onDidReviewFile.event;

	/** Fires the maximum number of ticks that fit at >=24px each, as the rail is resized. */
	private readonly _onDidChangeCapacity = this._register(new Emitter<number>());
	readonly onDidChangeCapacity: Event<number> = this._onDidChangeCapacity.event;

	get domNode(): HTMLElement { return this._domNode; }

	constructor() {
		super();
		this._domNode = $('nav.prompt-timeline-rail.prompt-timeline-rail-pills');
		this._domNode.setAttribute('aria-label', localize('promptTimeline.railLabel', "Prompt timeline"));
		this._domNode.setAttribute('role', 'toolbar');
		// A pointer-events surface (inset from the transcript scrollbar) hosts the
		// ticks and catches clicks that land between the dense marks.
		this._surface = append(this._domNode, $('.prompt-timeline-surface'));
		this._ticksContainer = append(this._surface, $('.prompt-timeline-ticks'));
		this._card = this._register(new PromptTimelineCard(this._domNode));
		this._register(this._card.onDidReview(tick => this._onDidReview.fire(tick)));
		this._register(this._card.onDidReviewFile(e => this._onDidReviewFile.fire(e)));

		this._register(addDisposableListener(this._surface, EventType.MOUSE_LEAVE, () => this._card.scheduleHide()));
		this._register(addDisposableListener(this._surface, EventType.CLICK, (e: MouseEvent) => {
			if (e.target === this._surface) {
				this._selectNearestTick(e.clientY);
			}
		}));
		// Hide the card when keyboard focus leaves the rail entirely.
		this._register(addDisposableListener(this._domNode, EventType.FOCUS_OUT, () => {
			if (!this._domNode.contains(getWindow(this._domNode).document.activeElement)) {
				this._card.scheduleHide();
			}
		}));
	}

	setFilesProvider(provider: (tick: PromptTick) => readonly PromptFileDiff[]): void {
		this._card.setFilesProvider(provider);
	}

	setTicks(ticks: readonly PromptTick[]): void {
		// In-place update when the prompt structure is unchanged (e.g. diff stats
		// streaming in): preserves tick focus and any open card.
		const sameStructure = ticks.length === this._ticks.length
			&& ticks.every((t, i) => this._ticks[i]?.requestId === t.requestId);
		if (sameStructure) {
			for (let i = 0; i < ticks.length; i++) {
				this._ticks[i] = ticks[i];
				this._renderTickContent(this._tickElements[i], ticks[i]);
			}
			this._updateActiveClasses();
			this._updateFit();
			return;
		}

		this._tickDisposables.clear();
		this._tickElements.length = 0;
		this._ticks.length = 0;
		clearNode(this._ticksContainer);
		this._card.hide();

		for (const tick of ticks) {
			const button = append(this._ticksContainer, $<HTMLButtonElement>('button.prompt-timeline-tick'));
			this._renderTickContent(button, tick);
			const requestId = tick.requestId;
			this._tickDisposables.add(addDisposableListener(button, EventType.CLICK, (e: MouseEvent) => {
				this._onDidSelect.fire(requestId);
				// A real mouse click (detail > 0) blurs the mark so it collapses back to the
				// dense rest state; keyboard activation (detail === 0) keeps focus so the mark
				// stays expanded for the next arrow key.
				if (e.detail > 0) {
					button.blur();
				}
			}));
			this._tickDisposables.add(addDisposableListener(button, EventType.MOUSE_ENTER, () => this._showCard(button, this._tickFor(requestId))));
			this._tickDisposables.add(addDisposableListener(button, EventType.FOCUS, () => this._showCard(button, this._tickFor(requestId))));
			this._tickElements.push(button);
			this._ticks.push(tick);
		}

		this._updateActiveClasses();
		this._updateFit();
	}

	private _tickFor(requestId: string): PromptTick {
		return this._ticks.find(t => t.requestId === requestId) ?? this._ticks[0];
	}

	/** Renders a tick's visible bar/segments from its diff stat (create or in-place update). */
	private _renderTickContent(button: HTMLButtonElement, tick: PromptTick): void {
		clearNode(button);
		button.className = 'prompt-timeline-tick';
		button.setAttribute('aria-label', tick.ariaLabel);
		// The button is the hit target; the visible bar sits inside it and expands to >=24px on hover/focus.
		const bar = append(button, $('span.prompt-timeline-tick-bar'));
		if (tick.count > 1) {
			bar.classList.add('grouped');
		}
		const stat = tick.stat;
		if (stat && stat.added + stat.removed > 0) {
			const addEl = append(bar, $('span.seg-add'));
			const delEl = append(bar, $('span.seg-del'));
			addEl.style.flexGrow = String(stat.added);
			delEl.style.flexGrow = String(stat.removed);
		} else {
			bar.classList.add('no-edits');
		}
	}

	setActive(requestId: string | undefined): void {
		this._activeRequestId = requestId;
		this._updateActiveClasses();
	}

	focusTick(requestId: string): void {
		const index = this._ticks.findIndex(t => t.requestId === requestId || t.allRequestIds.includes(requestId));
		this._tickElements[index]?.focus();
	}

	private _updateActiveClasses(): void {
		const activeIndex = this._activeRequestId !== undefined ? this._ticks.findIndex(t => t.requestId === this._activeRequestId) : -1;
		for (let i = 0; i < this._tickElements.length; i++) {
			const el = this._tickElements[i];
			const isActive = i === activeIndex;
			el.classList.toggle('active', isActive);
			if (isActive) {
				el.setAttribute('aria-current', 'location');
			} else {
				el.removeAttribute('aria-current');
			}
		}
	}

	private _showCard(anchor: HTMLElement, tick: PromptTick): void {
		const anchorRect = anchor.getBoundingClientRect();
		const domRect = this._domNode.getBoundingClientRect();
		this._card.show(tick, anchorRect.top - domRect.top + anchorRect.height / 2);
	}

	/** Reports the transcript width; a very narrow transcript hides the rail. */
	setHostWidth(width: number): void {
		if (width > 0 && width !== this._hostWidth) {
			this._hostWidth = width;
			this._updateFit();
		}
	}

	/**
	 * Measures how many dense marks fit (reserving room for one to expand to a
	 * >=24px target), reports that capacity so the model can cap the tick count,
	 * and hides the rail when fewer than two fit or the transcript is too narrow.
	 */
	private _updateFit(): void {
		// Resolved lazily so the observer binds to the mounted element's window,
		// which matters for auxiliary windows.
		this._ensureResizeObserver();
		const available = this._domNode.clientHeight;
		// A zero height means the rail is not laid out yet (e.g. display:none via
		// the data-driven `.hidden` class); a later resize re-runs this.
		if (available <= 0) {
			return;
		}
		// Reserve headroom so the single expanded mark never clips the dense stack.
		const expansionHeadroom = MIN_TARGET - DENSE_SLOT;
		const capacity = Math.max(0, Math.floor((available - VERTICAL_PADDING - expansionHeadroom) / DENSE_SLOT));
		const overflowing = this._hostWidth < MIN_HOST_WIDTH || capacity < MIN_VISIBLE_TICKS;
		this._domNode.classList.toggle('overflowing', overflowing);

		if (capacity !== this._capacity) {
			this._capacity = capacity;
			this._onDidChangeCapacity.fire(capacity);
		}
	}

	private _ensureResizeObserver(): void {
		if (this._resizeObserverReady) {
			return;
		}
		const ResizeObserverCtor = getWindow(this._domNode).ResizeObserver;
		if (!ResizeObserverCtor) {
			return;
		}
		this._resizeObserverReady = true;
		const observer = new ResizeObserverCtor(() => this._updateFit());
		observer.observe(this._domNode);
		this._register(toDisposable(() => observer.disconnect()));
	}

	private _selectNearestTick(pointerY: number): void {
		let nearest = -1;
		let nearestDistance = Number.POSITIVE_INFINITY;
		for (let i = 0; i < this._tickElements.length; i++) {
			const rect = this._tickElements[i].getBoundingClientRect();
			const distance = Math.abs(pointerY - (rect.top + rect.height / 2));
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearest = i;
			}
		}
		if (nearest !== -1) {
			this._onDidSelect.fire(this._ticks[nearest].requestId);
		}
	}
}
