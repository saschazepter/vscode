/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IPromptReviewFileEvent } from './promptTimelineRail.js';
import { PromptFileDiff, PromptTick } from './promptTimelineModel.js';

/** Short day label for grouped ticks (no time, since a bucket spans several prompts). */
function formatTickDate(timestamp: number, now: Date): string {
	const date = new Date(timestamp);
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const startOfYesterday = new Date(startOfToday);
	startOfYesterday.setDate(startOfYesterday.getDate() - 1);
	if (date >= startOfToday) {
		return localize('promptTimeline.today', "Today");
	}
	if (date >= startOfYesterday) {
		return localize('promptTimeline.yesterday', "Yesterday");
	}
	return date.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
	});
}

/** Precise time label for single-prompt ticks. */
function formatTickTime(timestamp: number, now: Date): string {
	const date = new Date(timestamp);
	const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	return `${formatTickDate(timestamp, now)}, ${time}`;
}

/**
 * The interactive preview shown when a prompt mark is hovered or focused, shared
 * by every rail style. Renders the prompt text, its diff summary (a shortcut to
 * review the whole prompt) and per-file rows, and stays open while hovered.
 */
export class PromptTimelineCard extends Disposable {

	private readonly _element: HTMLElement;
	private readonly _contentDisposables = this._register(new DisposableStore());
	private _hovered = false;
	private _hideTimer: ReturnType<typeof setTimeout> | undefined;
	private _filesProvider: (tick: PromptTick) => readonly PromptFileDiff[] = () => [];

	private readonly _onDidReview = this._register(new Emitter<PromptTick>());
	readonly onDidReview: Event<PromptTick> = this._onDidReview.event;

	private readonly _onDidReviewFile = this._register(new Emitter<IPromptReviewFileEvent>());
	readonly onDidReviewFile: Event<IPromptReviewFileEvent> = this._onDidReviewFile.event;

	constructor(private readonly _container: HTMLElement) {
		super();
		this._element = append(this._container, $('.prompt-timeline-card'));
		this._element.classList.add('hidden');
		this._register(addDisposableListener(this._element, EventType.MOUSE_ENTER, () => { this._hovered = true; }));
		this._register(addDisposableListener(this._element, EventType.MOUSE_LEAVE, () => { this._hovered = false; this.scheduleHide(); }));
	}

	setFilesProvider(provider: (tick: PromptTick) => readonly PromptFileDiff[]): void {
		this._filesProvider = provider;
	}

	/** Builds the card for a tick and positions it centered on `anchorCenterY` (relative to the container). */
	show(tick: PromptTick, anchorCenterY: number): void {
		if (this._hideTimer !== undefined) {
			clearTimeout(this._hideTimer);
			this._hideTimer = undefined;
		}
		this._contentDisposables.clear();
		clearNode(this._element);
		const now = new Date();

		const head = append(this._element, $('.prompt-timeline-card-head'));
		append(head, $('.prompt-timeline-card-text')).textContent = tick.text;
		this._renderMeta(append(head, $('.prompt-timeline-card-meta')), tick, now);

		const files = tick.stat ? this._filesProvider(tick) : [];
		if (tick.stat) {
			const diffAction = append(head, $<HTMLButtonElement>('button.prompt-timeline-card-diff-action'));
			diffAction.setAttribute('aria-label', localize(
				'promptTimeline.reviewChangesForPrompt',
				"Review Changes for Prompt: {0}",
				tick.text,
			));
			this._renderStat(append(diffAction, $('span.prompt-timeline-card-stat')), tick.stat.added, tick.stat.removed);
			append(diffAction, $('span')).textContent = tick.stat.fileCount === 1
				? localize('promptTimeline.oneFile', "1 file")
				: localize('promptTimeline.nFiles', "{0} files", tick.stat.fileCount);
			append(diffAction, $('span.prompt-timeline-card-diff-action-chevron')).textContent = '\u203A';
			this._contentDisposables.add(addDisposableListener(diffAction, EventType.CLICK, () => {
				this._onDidReview.fire(tick);
				this.hide();
			}));
		} else {
			append(head, $('div.prompt-timeline-card-no-edits')).textContent = localize('promptTimeline.noEdits', "no edits");
		}

		if (files.length > 0) {
			const list = append(this._element, $('.prompt-timeline-card-files'));
			for (const file of files) {
				const row = append(list, $<HTMLButtonElement>('button.prompt-timeline-card-file'));
				row.title = file.name;
				append(row, $('.prompt-timeline-card-fname')).textContent = file.name;
				this._renderStat(append(row, $('.prompt-timeline-card-fstat')), file.added, file.removed);
				this._contentDisposables.add(addDisposableListener(row, EventType.CLICK, () => {
					this._onDidReviewFile.fire({ tick, file: file.modifiedURI });
					this.hide();
				}));
			}
		}

		this._element.classList.remove('hidden');
		const top = anchorCenterY - this._element.offsetHeight / 2;
		const clampedTop = Math.max(4, Math.min(top, this._container.clientHeight - this._element.offsetHeight - 4));
		this._element.style.top = `${clampedTop}px`;
	}

	private _renderMeta(container: HTMLElement, tick: PromptTick, now: Date): void {
		const time = append(container, $('span'));
		time.textContent = tick.count > 1
			? localize('promptTimeline.groupedMeta', "{0} · {1} prompts", formatTickDate(tick.timestamp, now), tick.count)
			: formatTickTime(tick.timestamp, now);
	}

	private _renderStat(container: HTMLElement, added: number, removed: number): void {
		append(container, $('span.added')).textContent = `+${added}`;
		append(container, $('span.removed')).textContent = `\u2212${removed}`;
	}

	/** Hides the card shortly, unless it (or a mark) is re-hovered first. */
	scheduleHide(): void {
		if (this._hideTimer !== undefined) {
			clearTimeout(this._hideTimer);
		}
		this._hideTimer = setTimeout(() => {
			this._hideTimer = undefined;
			if (!this._hovered) {
				this.hide();
			}
		}, 200);
	}

	hide(): void {
		this._hovered = false;
		this._contentDisposables.clear();
		this._element.classList.add('hidden');
	}

	override dispose(): void {
		if (this._hideTimer !== undefined) {
			clearTimeout(this._hideTimer);
		}
		super.dispose();
	}
}
