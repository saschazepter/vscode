/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentSessionTitleBarWidget.css';
import { $, addDisposableListener, EventType, reset } from '../../../base/browser/dom.js';

import { Disposable, DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { getDefaultHoverDelegate } from '../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { MenuRegistry, SubmenuItemAction } from '../../../platform/actions/common/actions.js';
import { AgentSessionsWorkbenchMenus } from './agentSessionsWorkbenchMenus.js';
import { IWorkbenchContribution } from '../../common/contributions.js';
import { IActionViewItemService } from '../../../platform/actions/browser/actionViewItemService.js';
import { URI } from '../../../base/common/uri.js';
import { IActiveAgentSessionService } from '../../contrib/chat/browser/agentSessions/agentSessionsService.js';
import { FocusAgentSessionsAction } from '../../contrib/chat/browser/agentSessions/agentSessionsActions.js';
import { AgentSessionsPicker } from '../../contrib/chat/browser/agentSessions/agentSessionsPicker.js';
import { autorun } from '../../../base/common/observable.js';
import { IChatService } from '../../contrib/chat/common/chatService/chatService.js';

/**
 * Agent Sessions Title Bar Status Widget - renders the active chat session title
 * in the command center.
 *
 * Shows the current chat session label as a clickable pill. On click, opens the
 * sessions view (like the agentTitleBarStatusWidget).
 */
export class AgentSessionsTitleBarWidget extends BaseActionViewItem {

	private _container: HTMLElement | undefined;
	private readonly _dynamicDisposables = this._register(new DisposableStore());
	private readonly _modelChangeListener = this._register(new MutableDisposable());

	/** Cached render state to avoid unnecessary DOM rebuilds */
	private _lastRenderState: string | undefined;

	/** Guard to prevent re-entrant rendering */
	private _isRendering = false;

	constructor(
		action: SubmenuItemAction,
		options: IBaseActionViewItemOptions | undefined,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IHoverService private readonly hoverService: IHoverService,
		@IActiveAgentSessionService private readonly activeAgentSessionService: IActiveAgentSessionService,
		@IChatService private readonly chatService: IChatService,
	) {
		super(undefined, action, options);

		// Re-render when the active session changes
		this._register(autorun(reader => {
			const activeSession = this.activeAgentSessionService.activeSession.read(reader);
			this._trackModelTitleChanges(activeSession?.resource);
			this._lastRenderState = undefined;
			this._render();
		}));
	}

	override render(container: HTMLElement): void {
		super.render(container);

		this._container = container;
		container.classList.add('agent-sessions-titlebar-container');

		// Initial render
		this._render();
	}

	override setFocusable(_focusable: boolean): void {
		// Don't set focusable on the container
	}

	// Override onClick to prevent the base class from running the underlying
	// submenu action when the widget handles clicks itself.
	override onClick(): void {
		// No-op: click handling is done by the pill handler
	}

	private _render(): void {
		if (!this._container) {
			return;
		}

		if (this._isRendering) {
			return;
		}
		this._isRendering = true;

		try {
			const label = this._getActiveSessionLabel();

			// Skip re-render if state hasn't changed
			if (this._lastRenderState === label) {
				return;
			}
			this._lastRenderState = label;

			// Clear existing content
			reset(this._container);
			this._dynamicDisposables.clear();

			// Set up container as the button directly
			this._container.setAttribute('role', 'button');
			this._container.setAttribute('aria-label', localize('agentSessionsShowSessions', "Show Sessions"));
			this._container.tabIndex = 0;

			// Label
			const labelEl = $('span.agent-sessions-titlebar-label');
			labelEl.textContent = label;
			this._container.appendChild(labelEl);

			// Hover
			this._dynamicDisposables.add(this.hoverService.setupManagedHover(
				getDefaultHoverDelegate('mouse'),
				this._container,
				label
			));

			// Click handler - show sessions picker
			this._dynamicDisposables.add(addDisposableListener(this._container, EventType.MOUSE_DOWN, (e) => {
				e.preventDefault();
				e.stopPropagation();
			}));
			this._dynamicDisposables.add(addDisposableListener(this._container, EventType.CLICK, (e) => {
				e.preventDefault();
				e.stopPropagation();
				this._showSessionsPicker();
			}));

			// Keyboard handler
			this._dynamicDisposables.add(addDisposableListener(this._container, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					e.stopPropagation();
					this._showSessionsPicker();
				}
			}));
		} finally {
			this._isRendering = false;
		}
	}

	/**
	 * Track title changes on the chat model for the given session resource.
	 * When the model title changes, re-render the widget.
	 */
	private _trackModelTitleChanges(sessionResource: URI | undefined): void {
		this._modelChangeListener.clear();

		if (!sessionResource) {
			return;
		}

		const model = this.chatService.getSession(sessionResource);
		if (!model) {
			return;
		}

		this._modelChangeListener.value = model.onDidChange(e => {
			if (e.kind === 'setCustomTitle' || e.kind === 'addRequest') {
				this._lastRenderState = undefined;
				this._render();
			}
		});
	}

	/**
	 * Get the label of the active chat session.
	 * Prefers the live model title over the snapshot label from the active session service.
	 * Falls back to a generic label if no active session is found.
	 */
	private _getActiveSessionLabel(): string {
		const activeSession = this.activeAgentSessionService.getActiveSession();
		if (activeSession?.resource) {
			const model = this.chatService.getSession(activeSession.resource);
			if (model?.title) {
				return model.title;
			}
		}

		if (activeSession?.label) {
			return activeSession.label;
		}

		return localize('agentSessions.newSession', "New Session");
	}

	private _showSessionsPicker(): void {
		const picker = this.instantiationService.createInstance(AgentSessionsPicker, undefined);
		picker.pickAgentSession();
	}
}

/**
 * Provides custom rendering for the Agent Sessions title bar status widget
 * in the command center. Uses IActionViewItemService to render a custom widget
 * for the AgentSessionsTitleBarControlMenu submenu.
 */
export class AgentSessionsTitleBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.agentSessionsTitleBar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		// Register the submenu item in the Agent Sessions command center
		this._register(MenuRegistry.appendMenuItem(AgentSessionsWorkbenchMenus.CommandCenter, {
			submenu: AgentSessionsWorkbenchMenus.TitleBarControlMenu,
			title: localize('agentSessionsControl', "Agent Sessions"),
			order: 101,
		}));

		// Register a placeholder action so the submenu appears
		this._register(MenuRegistry.appendMenuItem(AgentSessionsWorkbenchMenus.TitleBarControlMenu, {
			command: {
				id: FocusAgentSessionsAction.id,
				title: localize('showSessions', "Show Sessions"),
			},
			group: 'a_sessions',
			order: 1
		}));

		this._register(actionViewItemService.register(AgentSessionsWorkbenchMenus.CommandCenter, AgentSessionsWorkbenchMenus.TitleBarControlMenu, (action, options) => {
			if (!(action instanceof SubmenuItemAction)) {
				return undefined;
			}
			return instantiationService.createInstance(AgentSessionsTitleBarWidget, action, options);
		}, undefined));
	}
}
