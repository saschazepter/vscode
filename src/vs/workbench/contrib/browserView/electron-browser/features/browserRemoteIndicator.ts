/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { $ } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { BrowserEditor, BrowserEditorContribution, IBrowserEditorWidgetContribution } from '../browserEditor.js';
import { IBrowserViewModel } from '../../common/browserView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';

class BrowserRemoteIndicatorContribution extends BrowserEditorContribution {
	private readonly _container: HTMLElement;

	private _isRemoteConnected = false;

	constructor(
		editor: BrowserEditor,
		@IHoverService hoverService: IHoverService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		super(editor);

		this._container = $('.browser-remote-indicator');

		// Always display the icon in remote workspaces -- just update the state based on whether we're actually serving via remote.
		this._container.style.display = environmentService.remoteAuthority ? '' : 'none';

		const icon = renderIcon(Codicon.remote);
		this._container.appendChild(icon);

		this._register(hoverService.setupDelayedHover(
			this._container,
			() => ({
				content: this._isRemoteConnected
					? localize('browser.remoteSession', "Connected via remote")
					: localize('browser.remoteSessionDisconnected', "Connected locally"),
			})
		));
	}

	override get preUrlWidgets(): readonly IBrowserEditorWidgetContribution[] {
		return [{ element: this._container, order: 0 }];
	}

	protected override subscribeToModel(model: IBrowserViewModel, _store: DisposableStore): void {
		this.setRemoteConnected(model.isRemoteSession && !model.url.startsWith('file://'));
		if (model.isRemoteSession) {
			this._register(model.onDidNavigate((event) => {
				this.setRemoteConnected(!event.url.startsWith('file://'));
			}));
		}
	}

	override clear(): void {
		this.setRemoteConnected(false);
	}

	private setRemoteConnected(isConnected: boolean): void {
		this._isRemoteConnected = isConnected;
		this._container.classList.toggle('connected', isConnected);
	}
}

BrowserEditor.registerContribution(BrowserRemoteIndicatorContribution);
