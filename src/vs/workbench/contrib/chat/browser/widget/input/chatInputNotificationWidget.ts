/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { WorkbenchActionExecutedClassification, WorkbenchActionExecutedEvent } from '../../../../../../base/common/actions.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { ChatInputNotificationSeverity, IChatInputNotification, IChatInputNotificationService } from './chatInputNotificationService.js';
import './media/chatInputNotificationWidget.css';

const $ = dom.$;

const severityToClass: Record<ChatInputNotificationSeverity, string> = {
	[ChatInputNotificationSeverity.Info]: 'severity-info',
	[ChatInputNotificationSeverity.Warning]: 'severity-warning',
	[ChatInputNotificationSeverity.Error]: 'severity-error',
};

const severityToIcon: Record<ChatInputNotificationSeverity, ThemeIcon> = {
	[ChatInputNotificationSeverity.Info]: Codicon.info,
	[ChatInputNotificationSeverity.Warning]: Codicon.warning,
	[ChatInputNotificationSeverity.Error]: Codicon.error,
};

/**
 * Widget that renders a single notification banner above the chat input area.
 * Subscribes to {@link IChatInputNotificationService} and shows the highest-severity
 * active notification with severity-colored borders, action buttons, and a dismiss button.
 */
export class ChatInputNotificationWidget extends Disposable {

	readonly domNode: HTMLElement;

	private readonly _contentDisposables = this._register(new DisposableStore());

	constructor(
		@IChatInputNotificationService private readonly _notificationService: IChatInputNotificationService,
		@ICommandService private readonly _commandService: ICommandService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
		super();

		this.domNode = $('.chat-input-notification-container');

		this._register(this._notificationService.onDidChange(() => this._render()));
		this._render();
	}

	private _render(): void {
		this._contentDisposables.clear();
		dom.clearNode(this.domNode);

		const notification = this._notificationService.getActiveNotification();
		if (!notification) {
			this.domNode.style.display = 'none';
			return;
		}

		this.domNode.style.display = '';
		this._renderNotification(notification);
	}

	private _renderNotification(notification: IChatInputNotification): void {
		const container = dom.append(this.domNode, $('.chat-input-notification'));

		// Apply severity class
		container.classList.add(severityToClass[notification.severity]);

		// Header row: icon + title + dismiss
		const headerRow = dom.append(container, $('.chat-input-notification-header'));

		// Severity icon
		const iconElement = dom.append(headerRow, $('.chat-input-notification-icon'));
		iconElement.appendChild(dom.$(ThemeIcon.asCSSSelector(severityToIcon[notification.severity])));

		// Title
		const titleElement = dom.append(headerRow, $('.chat-input-notification-title'));
		titleElement.textContent = notification.message;

		// Dismiss button (in header row, pushed to the right)
		if (notification.dismissible) {
			const dismissButton = dom.append(headerRow, $('.chat-input-notification-dismiss'));
			dismissButton.appendChild(dom.$(ThemeIcon.asCSSSelector(Codicon.close)));
			dismissButton.tabIndex = 0;
			dismissButton.role = 'button';
			dismissButton.ariaLabel = 'Dismiss notification';

			this._contentDisposables.add(dom.addDisposableListener(dismissButton, dom.EventType.CLICK, () => {
				this._notificationService.dismissNotification(notification.id);
			}));
			this._contentDisposables.add(dom.addDisposableListener(dismissButton, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					this._notificationService.dismissNotification(notification.id);
				}
			}));
		}

		// Progress bar (optional, below header)
		if (notification.progress !== undefined) {
			const progressContainer = dom.append(container, $('.chat-input-notification-progress'));
			const progressBar = dom.append(progressContainer, $('.chat-input-notification-progress-bar'));
			progressBar.style.width = `${Math.max(0, Math.min(100, notification.progress))}%`;
		}

		// Detail row: "X% used" + detail text + link-style actions (when progress is set)
		const hasDetailRow = notification.progress !== undefined || notification.detail || notification.actions.length > 0;
		if (hasDetailRow && notification.progress !== undefined) {
			const detailRow = dom.append(container, $('.chat-input-notification-detail-row'));

			// Progress label "X% used"
			const progressLabel = dom.append(detailRow, $('.chat-input-notification-progress-label'));
			progressLabel.textContent = `${Math.round(notification.progress)}% used`;

			// Detail text
			if (notification.detail) {
				const detailText = dom.append(detailRow, $('.chat-input-notification-detail'));
				detailText.textContent = notification.detail;
			}

			// Spacer
			dom.append(detailRow, $('.chat-input-notification-detail-spacer'));

			// Actions as links
			for (const action of notification.actions) {
				const link = dom.append(detailRow, $('a.chat-input-notification-action-link'));
				link.textContent = action.label;
				link.tabIndex = 0;
				link.role = 'button';
				link.ariaLabel = `${notification.message} ${action.label}`;

				this._contentDisposables.add(dom.addDisposableListener(link, dom.EventType.CLICK, async (e) => {
					e.preventDefault();
					this._telemetryService.publicLog2<WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification>('workbenchActionExecuted', {
						id: action.commandId,
						from: 'chatInputNotification',
					});
					await this._commandService.executeCommand(action.commandId, ...(action.commandArgs ?? []));
				}));
			}
		}

		// Description (optional, below detail row)
		if (notification.description) {
			const descriptionElement = dom.append(container, $('.chat-input-notification-description'));
			descriptionElement.textContent = notification.description;
		}

		// Actions as buttons (only when no progress bar — fallback layout)
		if (notification.progress === undefined && notification.actions.length > 0) {
			const actionsContainer = dom.append(container, $('.chat-input-notification-actions'));

			for (const action of notification.actions) {
				const button = this._contentDisposables.add(new Button(actionsContainer, {
					...defaultButtonStyles,
					supportIcons: true,
				}));
				button.element.classList.add('chat-input-notification-action-button');
				button.label = action.label;
				button.element.ariaLabel = `${notification.message} ${action.label}`;

				this._contentDisposables.add(button.onDidClick(async () => {
					this._telemetryService.publicLog2<WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification>('workbenchActionExecuted', {
						id: action.commandId,
						from: 'chatInputNotification',
					});
					await this._commandService.executeCommand(action.commandId, ...(action.commandArgs ?? []));
				}));
			}
		}
	}
}
