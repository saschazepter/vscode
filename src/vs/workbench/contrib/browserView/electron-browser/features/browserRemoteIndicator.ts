/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { $ } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { RawContextKey, IContextKeyService, IContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { BrowserEditor, BrowserEditorContribution, IBrowserEditorWidgetContribution } from '../browserEditor.js';
import { IBrowserViewModel } from '../../common/browserView.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';

export const CONTEXT_BROWSER_IS_REMOTE_SESSION = new RawContextKey<boolean>(
	'browserIsRemoteSession',
	false,
	localize('browser.isRemoteSession', "Whether the current browser view is using a remote network session")
);

class BrowserRemoteIndicatorContribution extends BrowserEditorContribution {
	private readonly _container: HTMLElement;
	private readonly _isRemoteSessionContext: IContextKey<boolean>;

	constructor(
		editor: BrowserEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IHoverService hoverService: IHoverService,
	) {
		super(editor);
		this._isRemoteSessionContext = CONTEXT_BROWSER_IS_REMOTE_SESSION.bindTo(contextKeyService);

		this._container = $('.browser-remote-indicator');
		this._container.style.display = 'none';

		const icon = renderIcon(Codicon.remote);
		this._container.appendChild(icon);

		this._register(hoverService.setupManagedHover(
			getDefaultHoverDelegate('mouse'),
			this._container,
			localize('browser.remoteSession', "Connected via remote")
		));
	}

	override get preUrlWidgets(): readonly IBrowserEditorWidgetContribution[] {
		return [{ element: this._container, order: 0 }];
	}

	protected override subscribeToModel(model: IBrowserViewModel, _store: DisposableStore): void {
		const isRemote = model.isRemoteSession;
		this._isRemoteSessionContext.set(isRemote);
		this._container.style.display = isRemote ? '' : 'none';
	}

	override clear(): void {
		this._isRemoteSessionContext.reset();
		this._container.style.display = 'none';
	}
}

BrowserEditor.registerContribution(BrowserRemoteIndicatorContribution);
