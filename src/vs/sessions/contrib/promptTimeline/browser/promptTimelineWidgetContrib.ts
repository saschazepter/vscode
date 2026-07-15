/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IChatWidget } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatWidgetContrib, ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { ChatAgentLocation } from '../../../../workbench/contrib/chat/common/constants.js';
import { MIN_PROMPTS, PROMPT_TIMELINE_CONTRIB_ID, PROMPT_TIMELINE_ENABLED_SETTING } from '../common/promptTimeline.js';
import { PromptTimelineModel, PromptEntry } from './promptTimelineModel.js';
import { IPromptTimelineRail } from './promptTimelineRail.js';
import { PromptTimelineRulerRail } from './promptTimelineRulerRail.js';

/** Wheel distance (|deltaY|) that must accumulate within {@link WHEEL_WINDOW_MS} to count as a hard/fast scroll. */
const HARD_WHEEL_DISTANCE = 800;
/** Rolling window for the wheel-velocity accumulator; a pause longer than this resets it. */
const WHEEL_WINDOW_MS = 120;

/**
 * Per-widget contribution that overlays a prompt timeline rail on the chat
 * transcript and exposes a navigation API for keyboard-driven commands. The rail
 * exists only while `sessions.promptTimeline.enabled` is set, and is torn down
 * and re-created when the enablement changes.
 */
export class PromptTimelineWidgetContrib extends Disposable implements IChatWidgetContrib {

	static readonly ID = PROMPT_TIMELINE_CONTRIB_ID;
	readonly id = PromptTimelineWidgetContrib.ID;

	private _model: PromptTimelineModel | undefined;
	private _rail: IPromptTimelineRail | undefined;

	/** Holds the model, rail and all their wiring while the feature is enabled. */
	private readonly _enablement = this._register(new DisposableStore());
	private _enabled = false;

	constructor(
		private readonly widget: IChatWidget,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		// The rail only makes sense for the main chat transcript location.
		if (widget.location !== ChatAgentLocation.Chat) {
			return;
		}

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PROMPT_TIMELINE_ENABLED_SETTING)) {
				this._updateRail();
			}
		}));
		this._updateRail();
	}

	/** Creates or disposes the rail to match the enablement setting. */
	private _updateRail(): void {
		const enabled = this.configurationService.getValue<boolean>(PROMPT_TIMELINE_ENABLED_SETTING) !== false;
		if (enabled === this._enabled) {
			return;
		}
		this._enabled = enabled;
		this._enablement.clear();
		this._model = undefined;
		this._rail = undefined;
		if (enabled) {
			this._createRail();
		}
	}

	private _createRail(): void {
		// CONTRIBS always constructs contribs with the concrete widget.
		const model = this._enablement.add(this.instantiationService.createInstance(PromptTimelineModel, this.widget as ChatWidget));
		const rail: IPromptTimelineRail = this._enablement.add(new PromptTimelineRulerRail());
		this._model = model;
		this._rail = rail;

		this._mountRail(rail);

		rail.setFilesProvider(tick => model.getRequestFiles(tick));
		this._enablement.add(rail.onDidSelect(requestId => model.reveal(requestId)));
		// Dragging the rail lane scrubs the transcript (the rail is the scrollbar now, so it drives scroll).
		this._enablement.add(rail.onDidScrub(scrollTop => { (this.widget as ChatWidget).scrollTop = scrollTop; }));
		this._enablement.add(rail.onDidReview(tick => { void model.reviewChanges(tick); }));
		this._enablement.add(rail.onDidReviewFile(e => { void model.reviewChanges(e.tick, e.file); }));

		// The transcript stays calm at rest AND during gentle scrolling — a plain scrollbar. Only a
		// HARD / FAST scroll (a deliberate flick) that ACTUALLY moves the transcript reveals the
		// timeline and blooms the fisheye "fan", which then follows the viewport as you continue. It
		// lingers for a few seconds after you stop before collapsing back to a plain scrollbar.
		//
		// Two-part gate: (1) here we detect the hard flick from WHEEL velocity and record it via
		// `notifyHardWheel()`; (2) the rail only blooms if a real scroll movement follows shortly after
		// (see `setScrollLayout`). Splitting it this way means a flick against the top/bottom limit —
		// which fires wheel events but scrolls nothing — never opens the fan, and programmatic scroll
		// nudges during virtualization re-measure (no recent hard wheel) don't either.
		//
		// The listener is on the CAPTURE phase: the transcript's own ScrollableElement consumes the
		// wheel and stops its propagation while there is room to scroll, so a bubble-phase listener
		// here would only ever fire at the top/bottom scroll limit. Capturing on the widget root sees
		// every wheel first, so a hard flick is detected anywhere in the transcript, not just the ends.
		let wheelAcc = 0;
		let wheelWindowStart = 0;
		this._enablement.add(addDisposableListener(this.widget.domNode, 'wheel', (e: WheelEvent) => {
			const now = Date.now();
			// Rolling window: a pause longer than the window resets the accumulator, so only a sustained
			// fast flick (lots of wheel distance in a short time) crosses the threshold — a gentle,
			// steady scroll never accumulates enough.
			if (now - wheelWindowStart > WHEEL_WINDOW_MS) {
				wheelAcc = 0;
				wheelWindowStart = now;
			}
			wheelAcc += Math.abs(e.deltaY);
			if (wheelAcc >= HARD_WHEEL_DISTANCE) {
				wheelAcc = 0;
				rail.notifyHardWheel();
			}
		}, { capture: true, passive: true }));

		this._enablement.add(autorun(reader => {
			const ticks = model.ticks.read(reader);
			// Toggle visibility before rendering so the rail's fit measurement in
			// setTicks runs against the displayed (non-zero height) element.
			const active = ticks.length >= MIN_PROMPTS;
			rail.domNode.classList.toggle('hidden', !active);
			// Mark the host so the transcript's native scrollbar is hidden only while the rail is
			// actually showing (the rail becomes the scrollbar); few-prompt chats keep the native one.
			this.widget.domNode.classList.toggle('prompt-timeline-active', active);
			rail.setTicks(ticks);
		}));

		this._enablement.add(autorun(reader => {
			rail.setActive(model.activeRequestId.read(reader));
		}));

		// Supply proportional scroll positions for the marks and viewport thumb.
		this._enablement.add(autorun(reader => {
			model.onDidChangeScrollLayout.read(reader);
			rail.setScrollLayout(model.getScrollLayout());
		}));
	}

	private _mountRail(rail: IPromptTimelineRail): void {
		const railNode = rail.domNode;
		const host = this.widget.domNode;
		// Anchor the absolutely-positioned overlay to the chat widget via a class
		// we own, removed on teardown so we never leave the foreign container mutated.
		host.classList.add('prompt-timeline-host');
		this._enablement.add(toDisposable(() => host.classList.remove('prompt-timeline-host', 'prompt-timeline-active')));
		host.appendChild(railNode);
		this._enablement.add(toDisposable(() => railNode.remove()));

		// Keep the rail above the input part so it only spans the transcript.
		const inputPart = this.widget.inputPart;
		this._enablement.add(autorun(reader => {
			railNode.style.setProperty('--prompt-timeline-bottom', `${inputPart.height.read(reader)}px`);
		}));

		// Report the host width so the rail can hide on very narrow transcripts.
		const ResizeObserverCtor = getWindow(host).ResizeObserver;
		if (ResizeObserverCtor) {
			const observer = new ResizeObserverCtor(() => rail.setHostWidth(host.clientWidth));
			observer.observe(host);
			this._enablement.add(toDisposable(() => observer.disconnect()));
		}
		rail.setHostWidth(host.clientWidth);
	}

	// -- Navigation API (used by promptTimelineActions) --

	/** All user prompts for the picker (every prompt, not just the bucketed ticks). */
	getAllPrompts(): readonly PromptEntry[] {
		return this._model?.getAllPrompts() ?? [];
	}

	reveal(requestId: string): void {
		this._model?.reveal(requestId);
		this._rail?.focusTick(requestId);
	}
}
