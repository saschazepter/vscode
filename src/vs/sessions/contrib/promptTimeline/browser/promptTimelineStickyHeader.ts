/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';

/**
 * A flat, opaque header pinned to the top of the chat transcript, modelled on the editor's sticky
 * scroll: it names the prompt currently scrolled off the top and offers previous/next buttons to
 * step through prompts. Activating the label opens the prompt picker to jump elsewhere. Purely
 * presentational — the owner drives its content and visibility.
 */
export class PromptTimelineStickyHeader extends Disposable {

	private readonly _domNode: HTMLElement;
	private readonly _labelButton: HTMLButtonElement;
	private readonly _label: HTMLElement;
	private readonly _count: HTMLElement;
	private readonly _prevButton: HTMLButtonElement;
	private readonly _nextButton: HTMLButtonElement;

	private readonly _onDidActivate = this._register(new Emitter<void>());
	/** Fired when the label is clicked or activated by keyboard (opens the prompt picker). */
	readonly onDidActivate: Event<void> = this._onDidActivate.event;

	private readonly _onDidNavigate = this._register(new Emitter<number>());
	/** Fired with `-1` (previous prompt) or `+1` (next prompt) when a navigation button is activated. */
	readonly onDidNavigate: Event<number> = this._onDidNavigate.event;

	get domNode(): HTMLElement { return this._domNode; }

	constructor(container: HTMLElement) {
		super();
		this._domNode = append(container, $('.prompt-timeline-sticky.hidden'));
		// The inner content is constrained to the transcript's message column (see promptTimeline.css)
		// so the pinned prompt text lines up with the prompts scrolling underneath.
		const content = append(this._domNode, $('.prompt-timeline-sticky-content'));

		this._labelButton = append(content, $<HTMLButtonElement>('button.prompt-timeline-sticky-label-button'));
		this._label = append(this._labelButton, $('span.prompt-timeline-sticky-label'));
		this._count = append(this._labelButton, $('span.prompt-timeline-sticky-count'));
		// A native <button> already activates on click and on Enter/Space, so no manual key handling.
		this._register(addDisposableListener(this._labelButton, EventType.CLICK, () => this._onDidActivate.fire()));

		const nav = append(content, $('.prompt-timeline-sticky-nav'));
		this._prevButton = append(nav, $<HTMLButtonElement>('button.prompt-timeline-sticky-nav-button'));
		append(this._prevButton, $(`span${ThemeIcon.asCSSSelector(Codicon.chevronUp)}`));
		this._register(addDisposableListener(this._prevButton, EventType.CLICK, () => this._onDidNavigate.fire(-1)));

		this._nextButton = append(nav, $<HTMLButtonElement>('button.prompt-timeline-sticky-nav-button'));
		append(this._nextButton, $(`span${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`));
		this._register(addDisposableListener(this._nextButton, EventType.CLICK, () => this._onDidNavigate.fire(1)));
	}

	/** Names the pinned prompt (1-based index within all prompts). */
	update(text: string, index: number, total: number): void {
		const label = text || localize('promptTimeline.emptyPrompt', "(empty prompt)");
		this._label.textContent = label;
		this._count.textContent = localize('promptTimeline.stickyCount', "{0}/{1}", index, total);
		this._labelButton.title = label;
		this._labelButton.setAttribute('aria-label', localize('promptTimeline.stickyLabel', "Go to prompt {0} of {1}: {2}", index, total, label));

		// The ends of the prompt list have nowhere to step to, so disable the matching button.
		this._prevButton.disabled = index <= 1;
		this._nextButton.disabled = index >= total;
		const prevLabel = localize('promptTimeline.previousPrompt', "Go to Previous Prompt");
		const nextLabel = localize('promptTimeline.nextPrompt', "Go to Next Prompt");
		this._prevButton.title = prevLabel;
		this._prevButton.setAttribute('aria-label', prevLabel);
		this._nextButton.title = nextLabel;
		this._nextButton.setAttribute('aria-label', nextLabel);
	}

	setVisible(visible: boolean): void {
		this._domNode.classList.toggle('hidden', !visible);
	}

	override dispose(): void {
		this._domNode.remove();
		super.dispose();
	}
}
