/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { createMarkdownCommandLink, MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { Disposable, IDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { IMarkdownRendererService, openLinkFromMarkdown } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { localize } from '../../../../../../nls.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IChatRendererContent } from '../../../common/model/chatViewModel.js';
import { IChatCloudSyncConsentPart } from '../../../common/chatService/chatService.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';
import './media/chatCloudSyncConsentContent.css';

export class ChatCloudSyncConsentContentPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	constructor(
		_data: IChatCloudSyncConsentPart,
		_context: IChatContentPartRenderContext,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IMarkdownRendererService private readonly _markdownRendererService: IMarkdownRendererService,
	) {
		super();

		this.domNode = dom.$('.chat-cloud-sync-consent');
		const messageContainer = dom.$('.chat-cloud-sync-consent-message');

		const icon = dom.$('.chat-cloud-sync-consent-icon');
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.cloudUpload));

		const continueLink = createMarkdownCommandLink({
			text: localize('chat.cloudSyncConsent.continueLink', "Continue"),
			id: 'github.copilot.chat.enableCloudSync',
			tooltip: localize('chat.cloudSyncConsent.continueLink.tooltip', "Allow cloud session sync to proceed"),
		});
		const disableLink = createMarkdownCommandLink({
			text: localize('chat.cloudSyncConsent.disableLink', "Disable"),
			id: 'github.copilot.chat.disableCloudSync',
			tooltip: localize('chat.cloudSyncConsent.disableLink.tooltip', "Disable cloud session sync"),
		});
		const message = localize(
			'chat.cloudSyncConsent.message',
			"Session data will be synced with the cloud for cross-device history and richer insights. {0} \u00b7 {1}",
			continueLink,
			disableLink,
		);
		const content = new MarkdownString(message, { isTrusted: true });

		const rendered = this._register(this._markdownRendererService.render(content, {
			actionHandler: (href) => {
				const isEnable = href.includes('enableCloudSync');
				openLinkFromMarkdown(this._openerService, href, true);

				// Replace content with feedback message
				const feedbackMessage = isEnable
					? localize('chat.cloudSyncConsent.enabled', "Cloud sync enabled.")
					: localize('chat.cloudSyncConsent.disabled', "Cloud sync disabled.");
				const feedbackContent = new MarkdownString(feedbackMessage);
				const feedbackRendered = this._register(this._markdownRendererService.render(feedbackContent));
				rendered.element.replaceWith(feedbackRendered.element);
			},
		}));

		messageContainer.appendChild(icon);
		messageContainer.appendChild(rendered.element);
		this.domNode.appendChild(messageContainer);
	}

	hasSameContent(other: IChatRendererContent): boolean {
		return other.kind === 'cloudSyncConsent';
	}

	addDisposable(disposable: IDisposable): void {
		this._register(disposable);
	}
}
