/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';

const $ = dom.$;

/**
 * The vote a user can cast on a chat response in the helpfulness banner.
 */
export const enum ChatHelpfulnessVote {
	Yes = 'yes',
	No = 'no',
}

/**
 * Event fired when the user submits feedback through the {@link ChatHelpfulnessBanner}.
 */
export interface IChatHelpfulnessFeedback {
	readonly vote: ChatHelpfulnessVote;
	readonly detail: string;
}

/**
 * A prototype banner shown below a chat response that asks "Was this response
 * helpful?". The user can answer Yes or No, after which a text box is revealed
 * for adding more detail.
 */
export class ChatHelpfulnessBanner extends Disposable {

	private readonly _onDidSubmit = this._register(new Emitter<IChatHelpfulnessFeedback>());
	readonly onDidSubmit: Event<IChatHelpfulnessFeedback> = this._onDidSubmit.event;

	private readonly domNode: HTMLElement;
	private readonly promptRow: HTMLElement;
	private readonly detailRow: HTMLElement;
	private readonly thanksRow: HTMLElement;
	private readonly detailInput: HTMLTextAreaElement;

	private vote: ChatHelpfulnessVote | undefined;

	constructor(container: HTMLElement) {
		super();

		this.domNode = dom.append(container, $('.chat-helpfulness-banner'));

		// Prompt row: question + Yes / No buttons
		this.promptRow = dom.append(this.domNode, $('.chat-helpfulness-prompt'));
		dom.append(this.promptRow, $('span.chat-helpfulness-question')).textContent = localize('chat.helpfulness.question', "How do you rate this response?");

		const buttons = dom.append(this.promptRow, $('.chat-helpfulness-buttons'));
		this.createVoteButton(buttons, ChatHelpfulnessVote.Yes, localize('chat.helpfulness.positive', "Positive"));
		this.createVoteButton(buttons, ChatHelpfulnessVote.No, localize('chat.helpfulness.negative', "Negative"));

		// Detail row: textarea + submit button (hidden until a vote is cast)
		this.detailRow = dom.append(this.domNode, $('.chat-helpfulness-details.hidden'));
		this.detailInput = dom.append(this.detailRow, $('textarea.chat-helpfulness-input')) as HTMLTextAreaElement;
		this.detailInput.rows = 2;
		this.detailInput.placeholder = localize('chat.helpfulness.detailPlaceholder', "Add more detail (optional)");

		const submitContainer = dom.append(this.detailRow, $('.chat-helpfulness-submit'));
		const submitButton = this._register(new Button(submitContainer, { ...defaultButtonStyles, title: localize('chat.helpfulness.submit', "Submit") }));
		submitButton.label = localize('chat.helpfulness.submit', "Submit");
		this._register(submitButton.onDidClick(() => this.submit()));

		// Thanks row: shown after submitting
		this.thanksRow = dom.append(this.domNode, $('.chat-helpfulness-thanks.hidden'));
		this.thanksRow.textContent = localize('chat.helpfulness.thanks', "Thanks for your feedback!");
	}

	private createVoteButton(container: HTMLElement, vote: ChatHelpfulnessVote, label: string): void {
		const button = this._register(new Button(container, { ...defaultButtonStyles, secondary: true, title: label }));
		button.element.classList.add('chat-helpfulness-vote', `chat-helpfulness-vote-${vote}`);
		button.label = label;
		this._register(button.onDidClick(() => this.onVote(vote)));
	}

	private onVote(vote: ChatHelpfulnessVote): void {
		this.vote = vote;

		// Highlight the selected vote and reveal the detail text box
		this.domNode.classList.toggle('voted-yes', vote === ChatHelpfulnessVote.Yes);
		this.domNode.classList.toggle('voted-no', vote === ChatHelpfulnessVote.No);
		this.detailRow.classList.remove('hidden');
		this.detailInput.focus();
	}

	private submit(): void {
		if (!this.vote) {
			return;
		}

		this._onDidSubmit.fire({ vote: this.vote, detail: this.detailInput.value.trim() });

		this.promptRow.classList.add('hidden');
		this.detailRow.classList.add('hidden');
		this.thanksRow.classList.remove('hidden');
	}

	/**
	 * Resets the banner back to its initial state. Used when the row template is
	 * recycled for a different response.
	 */
	reset(): void {
		this.vote = undefined;
		this.detailInput.value = '';
		this.domNode.classList.remove('voted-yes', 'voted-no');
		this.promptRow.classList.remove('hidden');
		this.detailRow.classList.add('hidden');
		this.thanksRow.classList.add('hidden');
	}

	setVisible(visible: boolean): void {
		this.domNode.classList.toggle('hidden', !visible);
	}
}
