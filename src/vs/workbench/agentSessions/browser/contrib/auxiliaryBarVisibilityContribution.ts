/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IChatWidget, IChatWidgetService } from '../../../contrib/chat/browser/chat.js';
import { ChatAgentLocation } from '../../../contrib/chat/common/constants.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';

/**
 * Observes chat widgets in the Chat location to show/hide the auxiliary bar
 * based on whether the chat session has any requests.
 *
 * - When the chat session is empty (no requests), the auxiliary bar is hidden
 * - When the chat session has at least one request, the auxiliary bar is shown
 */
export class AuxiliaryBarVisibilityContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentSessions.auxiliaryBarVisibility';

	private readonly _chatWidgetObservers = this._register(new DisposableStore());

	constructor(
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService
	) {
		super();

		this._observeWidgets();
	}

	private _observeWidgets(): void {
		// Observe existing widgets
		for (const widget of this._chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat)) {
			this._observeWidget(widget);
		}

		// Observe newly added widgets
		this._register(this._chatWidgetService.onDidAddWidget(widget => {
			this._observeWidget(widget);
		}));
	}

	private _observeWidget(widget: IChatWidget): void {
		if (widget.location !== ChatAgentLocation.Chat) {
			return;
		}

		const widgetDisposables = new DisposableStore();

		// Update visibility based on current state
		const updateAuxiliaryBarVisibility = () => {
			const isEmpty = (widget.viewModel?.model.getRequests().length ?? 0) === 0;
			this._layoutService.setPartHidden(isEmpty, Parts.AUXILIARYBAR_PART);
		};

		// Observe when the viewModel changes (e.g., when a session is loaded)
		widgetDisposables.add(widget.onDidChangeViewModel(() => {
			updateAuxiliaryBarVisibility();

			// Also observe the model's changes for add/remove request
			if (widget.viewModel) {
				widgetDisposables.add(widget.viewModel.model.onDidChange(e => {
					if (e.kind === 'addRequest' || e.kind === 'removeRequest') {
						updateAuxiliaryBarVisibility();
					}
				}));
			}
		}));

		// If the widget already has a viewModel, observe it immediately
		if (widget.viewModel) {
			updateAuxiliaryBarVisibility();
			widgetDisposables.add(widget.viewModel.model.onDidChange(e => {
				if (e.kind === 'addRequest' || e.kind === 'removeRequest') {
					updateAuxiliaryBarVisibility();
				}
			}));
		}

		this._chatWidgetObservers.add(widgetDisposables);
	}
}
