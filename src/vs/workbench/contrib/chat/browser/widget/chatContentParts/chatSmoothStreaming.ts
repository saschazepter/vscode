/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatSmoothStreaming.css';
import { getWindow } from '../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ChatConfiguration } from '../../../common/constants.js';

/**
 * Available animation styles for smooth streaming.
 */
type SmoothStreamingAnimationStyle = 'fade' | 'rise' | 'blur' | 'scale' | 'slide';

/** Duration of the animation applied to newly rendered blocks. */
const ANIMATION_DURATION_MS = 600;

/**
 * Delay (ms) between each successive new child's animation start.
 * Creates a cascading top-to-bottom reveal across a batch of new
 * block-level elements without needing a wrapper div.
 */
const STAGGER_DELAY_MS = 150;

/**
 * Maximum number of characters that may accumulate beyond the last
 * rendered block boundary before a render is forced. Prevents a long
 * paragraph with no `\n\n` from staying invisible indefinitely.
 */
const MAX_BUFFERED_CHARS = 4000;

/**
 * Finds the last `\n\n` block boundary that is NOT inside an open
 * fenced code block. This prevents splitting a render in the middle
 * of a code fence, which would cause the code block element to update
 * in place (same DOM index) without triggering a new-child animation.
 *
 * The scan counts backtick-fence openings/closings from the start of
 * the string. A `\n\n` is only a valid boundary when the fence depth
 * is 0 (i.e. outside any code block).
 *
 * @internal Exported for testing.
 */
export function lastBlockBoundary(text: string): number {
	let lastValid = -1;
	let inFence = false;

	for (let i = 0; i < text.length; i++) {
		// Detect fenced code blocks: ``` at the start of a line.
		if ((i === 0 || text[i - 1] === '\n') && text[i] === '`' && text[i + 1] === '`' && text[i + 2] === '`') {
			inFence = !inFence;
			i += 2; // skip past the triple backtick
			continue;
		}
		// Detect block boundary outside code fences.
		if (!inFence && text[i] === '\n' && text[i + 1] === '\n') {
			lastValid = i;
		}
	}

	return lastValid;
}

/**
 * Incremental markdown streaming renderer — rAF-batched, append-only.
 *
 * ## Design
 *
 * Instead of buffering raw text and bypassing the markdown renderer,
 * this renderer works *with* the existing markdown rendering pipeline:
 *
 * 1. On each update the **old** and **new** markdown strings are
 *    compared to verify the new content is a pure append.
 * 2. A `requestAnimationFrame` guard coalesces rapid token arrivals
 *    into at most one DOM update per frame.
 * 3. The owner's render callback performs a full `doRenderMarkdown()`
 *    with the updated markdown through the standard pipeline — so
 *    code blocks, links, tables, KaTeX, and all markdown features
 *    render correctly even while streaming.
 * 4. Newly inserted top-level DOM nodes receive a CSS animation class
 *    as a **post-processing decoration**. Because the animation is
 *    applied *after* correct rendering, it never interferes with
 *    structural markdown.
 *
 * ### Handling partial markdown
 *
 * The underlying markdown renderer already uses
 * `fillInIncompleteTokens` to handle streaming markdown (unclosed
 * bold, incomplete tables, etc.). This renderer leverages that: each
 * update re-renders the content through the same pipeline, so partial
 * tokens are naturally handled and reconciled as more tokens arrive.
 *
 * ### No final re-render
 *
 * Because each incremental update produces correctly rendered
 * markdown, no teardown-and-rebuild pass is needed when the response
 * completes. The caller simply stops calling `tryMorph()`.
 *
 * ### Bail conditions
 *
 * If the new markdown is NOT a pure append of the old (e.g. the model
 * rewrites earlier content), `tryMorph()` returns `false` and the
 * caller falls back to a full re-render.
 */
export class SmoothStreamingDOMMorpher extends Disposable {

	private _lastMarkdown: string = '';
	private _animationStyle: SmoothStreamingAnimationStyle = 'fade';

	/**
	 * The markdown that was last rendered to the DOM. May lag behind
	 * `_lastMarkdown` while a partial block is being buffered.
	 */
	private _renderedMarkdown: string = '';

	/**
	 * High-water mark: the number of top-level children that have been
	 * fully revealed (their animation completed or they existed before
	 * streaming started). Children at indices >= this value are "new"
	 * and get animated on each render.
	 */
	private _revealedChildCount: number = 0;

	/**
	 * Timestamp (via `Date.now()`) when children at indices >=
	 * `_revealedChildCount` first appeared. Used to continue the
	 * animation across re-renders with the correct remaining duration.
	 * 0 means no animation is in progress.
	 */
	private _animationStartTime: number = 0;

	/**
	 * The total child count at the end of the most recent render that
	 * participated in the current animation batch. When the animation
	 * expires, the watermark advances to this value (not to the live
	 * `currentCount`) so that children arriving in the same frame as
	 * the expiry start a fresh animation instead of being skipped.
	 */
	private _batchChildCount: number = 0;

	/** Whether a rAF-batched render is already scheduled. */
	private _rafScheduled: boolean = false;

	/** The pending markdown waiting to be flushed on the next rAF. */
	private _pendingMarkdown: string | undefined;

	/** rAF handle for cancellation on dispose. */
	private _rafHandle: number | undefined;

	/**
	 * Callback provided by the owner to re-render the markdown part.
	 * Set via {@link setRenderCallback}.
	 */
	private _renderCallback: ((newMarkdown: string) => void) | undefined;

	constructor(
		private readonly _domNode: HTMLElement,
		@IConfigurationService private readonly _configService: IConfigurationService,
	) {
		super();
		this._animationStyle = this._readAnimationStyle();

		this._register(this._configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ChatConfiguration.SmoothStreamingStyle)) {
				this._animationStyle = this._readAnimationStyle();
			}
		}));
	}

	private _readAnimationStyle(): SmoothStreamingAnimationStyle {
		const raw = this._configService.getValue<string>(ChatConfiguration.SmoothStreamingStyle);
		const valid: SmoothStreamingAnimationStyle[] = ['fade', 'rise', 'blur', 'scale', 'slide'];
		return valid.includes(raw as SmoothStreamingAnimationStyle) ? raw as SmoothStreamingAnimationStyle : 'fade';
	}

	/**
	 * Register the callback that performs the actual markdown re-render.
	 * The callback receives the full new markdown string and should
	 * call the owner's `doRenderMarkdown()` equivalent with it.
	 */
	setRenderCallback(cb: (newMarkdown: string) => void): void {
		this._renderCallback = cb;
	}

	/**
	 * Seeds the renderer with the initial markdown string.
	 * Call after the first full render so the renderer knows the
	 * baseline content and DOM state.
	 *
	 * @param animateInitial When `true`, the children already in the
	 *   DOM receive the entrance animation. Use this when a markdown
	 *   part appears mid-response (e.g. after thinking content) and
	 *   its initial content should animate in.
	 */
	seed(markdown: string, animateInitial?: boolean): void {
		this._lastMarkdown = markdown;
		this._renderedMarkdown = markdown;
		this._revealedChildCount = animateInitial ? 0 : this._domNode.children.length;
		this._animationStartTime = 0;
		if (animateInitial) {
			this._animateNewChildren();
		}
	}

	/**
	 * Attempts an incremental DOM update via rAF-batched re-render.
	 *
	 * @returns `true` if the update was absorbed (caller should treat
	 *          the part as unchanged). `false` if a full re-render is
	 *          needed (non-append change detected).
	 */
	tryMorph(newMarkdown: string): boolean {
		// Non-append edit — bail to full re-render.
		if (!newMarkdown.startsWith(this._lastMarkdown)) {
			return false;
		}

		const appended = newMarkdown.slice(this._lastMarkdown.length);
		if (appended.length === 0) {
			return true; // No change — nothing to do.
		}

		// Update stored markdown immediately so that `hasSameContent()`
		// checks succeed for subsequent diff passes within the same frame.
		this._lastMarkdown = newMarkdown;

		// Buffer at block boundaries: only render up to the last
		// paragraph break (\n\n) that is outside a fenced code block.
		// This avoids rendering partially formed blocks — text
		// mid-paragraph, incomplete list groups, or half a code fence.
		// The comparison uses length because content is append-only,
		// making this O(1).
		const lastBlock = lastBlockBoundary(newMarkdown);
		let renderable = lastBlock === -1
			? this._renderedMarkdown   // no complete block yet — keep current
			: newMarkdown.slice(0, lastBlock + 2);

		// Escape hatch: if too much content has accumulated without a
		// block boundary, render what we have to avoid a long invisible
		// paragraph.
		if (newMarkdown.length - renderable.length > MAX_BUFFERED_CHARS) {
			renderable = newMarkdown;
		}

		if (renderable.length > this._renderedMarkdown.length) {
			this._renderedMarkdown = renderable;
			this._pendingMarkdown = renderable;
			this._scheduleRender();
		}

		return true;
	}

	// ---- rAF batching ----

	private _scheduleRender(): void {
		if (this._rafScheduled) {
			return; // Already scheduled — the pending markdown is updated in-place.
		}
		this._rafScheduled = true;
		const win = getWindow(this._domNode);
		this._rafHandle = win.requestAnimationFrame(() => {
			this._rafScheduled = false;
			this._rafHandle = undefined;
			this._flushRender();
		});
	}

	private _flushRender(): void {
		const markdown = this._pendingMarkdown;
		this._pendingMarkdown = undefined;

		if (markdown === undefined || !this._renderCallback) {
			return;
		}

		// Delegate to the owner's render pipeline. This does a full
		// markdown render into this._domNode (the markdown part's root).
		// doRenderMarkdown() calls dom.clearNode() first, destroying all
		// existing children, then rebuilds the DOM from the full markdown.
		this._renderCallback(markdown);

		// (Re-)apply animation on newly appeared children. Because the
		// DOM was torn down and rebuilt, we use the high-water mark
		// (_revealedChildCount) to know which indices are "new".
		this._animateNewChildren();
	}

	// ---- animation ----

	/**
	 * Applies or re-applies a CSS animation on top-level children that
	 * appeared after the high-water mark (`_revealedChildCount`).
	 *
	 * All new children receive the same animation class and identical
	 * timing variables so they reveal in unison as one visual unit,
	 * without wrapping them in a container div (which would change
	 * margin collapsing and cause layout shifts during scrolling).
	 *
	 * Because `doRenderMarkdown()` tears down and rebuilds the entire
	 * DOM on each call, any in-progress animations are destroyed. This
	 * method re-applies the animation with a **negative animation-delay**
	 * equal to the elapsed time, which causes the browser to start the
	 * animation partway through — at the correct opacity/transform —
	 * so there is no visible snap-back.
	 *
	 * Once the full animation duration has elapsed, the high-water mark
	 * advances and the children are considered fully revealed.
	 */
	private _animateNewChildren(): void {
		const children = this._domNode.children;
		const currentCount = children.length;

		if (currentCount <= this._revealedChildCount) {
			return; // No new children — nothing to animate.
		}

		const now = Date.now();

		// If the previous animation batch has completed, advance the
		// watermark to the snapshot from the last render (not to
		// currentCount — children that arrived in THIS render should
		// start a fresh animation, not be skipped).
		if (this._animationStartTime !== 0 && (now - this._animationStartTime) >= ANIMATION_DURATION_MS) {
			this._revealedChildCount = this._batchChildCount;
			this._animationStartTime = 0;
			this._batchChildCount = 0;
		}

		// Recheck after advancing — the batch may have covered everything.
		if (currentCount <= this._revealedChildCount) {
			return;
		}

		// First time seeing children beyond the watermark — start timer.
		if (this._animationStartTime === 0) {
			this._animationStartTime = now;
		}

		// Record how many children are part of this batch so the
		// watermark advances correctly when the animation expires.
		this._batchChildCount = currentCount;

		const elapsed = now - this._animationStartTime;
		const className = `chat-smooth-animate-${this._animationStyle}`;

		// Apply the same animation class and timing to every new child
		// so they reveal together as one coordinated unit. Each child
		// receives a small additional stagger offset so the reveal
		// cascades top-to-bottom rather than all at once.
		for (let i = this._revealedChildCount; i < currentCount; i++) {
			const child = children[i] as HTMLElement;
			if (!child.classList) {
				continue;
			}

			const staggerOffset = (i - this._revealedChildCount) * STAGGER_DELAY_MS;
			const childDelay = -elapsed + staggerOffset;

			child.classList.add(className);
			child.style.setProperty('--chat-smooth-duration', `${ANIMATION_DURATION_MS}ms`);
			child.style.setProperty('--chat-smooth-delay', `${childDelay}ms`);

			child.addEventListener('animationend', () => {
				child.classList.remove(className);
				child.style.removeProperty('--chat-smooth-duration');
				child.style.removeProperty('--chat-smooth-delay');
			}, { once: true });
		}
	}

	override dispose(): void {
		// Cancel any pending rAF.
		if (this._rafHandle !== undefined) {
			getWindow(this._domNode).cancelAnimationFrame(this._rafHandle);
			this._rafHandle = undefined;
		}
		this._rafScheduled = false;
		this._pendingMarkdown = undefined;
		this._renderCallback = undefined;
		super.dispose();
	}
}
