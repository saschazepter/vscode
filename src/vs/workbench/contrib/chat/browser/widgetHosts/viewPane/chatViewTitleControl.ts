/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatViewTitleControl.css';
import { h } from '../../../../../../base/browser/dom.js';
import { renderAsPlaintext } from '../../../../../../base/browser/markdownRenderer.js';

import { Emitter } from '../../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { Disposable, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { MarshalledId } from '../../../../../../base/common/marshallingIds.js';
import { localize } from '../../../../../../nls.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { MenuId } from '../../../../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IChatViewTitleActionContext } from '../../../common/actions/chatActions.js';
import { IChatModel } from '../../../common/model/chatModel.js';

export interface IChatViewTitleDelegate {
	focusChat(): void;
}

export class ChatViewTitleControl extends Disposable {

	private static readonly DEFAULT_TITLE = localize('chat', "Chat");

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	readonly onDidChangeHeight = this._onDidChangeHeight.event;

	private title: string | undefined = undefined;

	private titleContainer: HTMLElement | undefined;
	private titleLabel: HTMLElement | undefined;

	private model: IChatModel | undefined;
	private modelDisposables = this._register(new MutableDisposable());

	private actionsToolbar?: MenuWorkbenchToolBar;

	private lastKnownHeight = 0;

	constructor(
		private readonly container: HTMLElement,
		_delegate: IChatViewTitleDelegate,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		this.render(this.container);
	}

	private render(parent: HTMLElement): void {
		const elements = h('div.chat-view-title-container', [
			h('div.chat-view-title-inner', [
				h('span.chat-view-title-label@titleLabel'),
				h('div.chat-view-title-actions-toolbar@actionsToolbar'),
			]),
		]);

		// Title label (plain text)
		this.titleLabel = elements.titleLabel;

		// Actions toolbar on the right
		this.actionsToolbar = this._register(this.instantiationService.createInstance(MenuWorkbenchToolBar, elements.actionsToolbar, MenuId.ChatViewSessionTitleToolbar, {
			menuOptions: { shouldForwardArgs: true },
			hiddenItemStrategy: HiddenItemStrategy.NoHide
		}));

		// Title controls
		this.titleContainer = elements.root;

		parent.appendChild(this.titleContainer);
	}

	update(model: IChatModel | undefined): void {
		this.model = model;

		this.modelDisposables.value = model?.onDidChange(e => {
			if (e.kind === 'setCustomTitle' || e.kind === 'addRequest') {
				this.doUpdate();
			}
		});

		this.doUpdate();
	}

	private doUpdate(): void {
		const markdownTitle = new MarkdownString(this.model?.title ?? '');
		this.title = renderAsPlaintext(markdownTitle);

		this.updateTitle(this.title ?? ChatViewTitleControl.DEFAULT_TITLE);

		const context = this.model && {
			$mid: MarshalledId.ChatViewContext,
			sessionResource: this.model.sessionResource
		} satisfies IChatViewTitleActionContext;

		if (this.actionsToolbar) {
			this.actionsToolbar.context = context;
		}
	}

	private updateTitle(title: string): void {
		if (!this.titleContainer || !this.titleLabel) {
			return;
		}

		this.titleContainer.classList.toggle('visible', this.shouldRender());
		this.titleLabel.textContent = title || ChatViewTitleControl.DEFAULT_TITLE;

		const currentHeight = this.getHeight();
		if (currentHeight !== this.lastKnownHeight) {
			this.lastKnownHeight = currentHeight;

			this._onDidChangeHeight.fire();
		}
	}

	private shouldRender(): boolean {
		return !!this.model?.title; // we need a chat showing and not being empty
	}

	getHeight(): number {
		if (!this.titleContainer || this.titleContainer.style.display === 'none') {
			return 0;
		}

		return this.titleContainer.offsetHeight;
	}
}
