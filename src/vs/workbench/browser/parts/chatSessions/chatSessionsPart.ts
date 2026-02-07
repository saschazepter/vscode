/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatSessionsPart.css';
import { $, append } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { LayoutPriority } from '../../../../base/browser/ui/splitview/splitview.js';
import { localize } from '../../../../nls.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { SIDE_BAR_BACKGROUND, SIDE_BAR_BORDER, SIDE_BAR_FOREGROUND } from '../../../common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { Part } from '../../part.js';
import { IWorkbenchLayoutService, Parts, Position } from '../../../services/layout/browser/layoutService.js';
import { AgentSessionsControl } from '../../../contrib/chat/browser/agentSessions/agentSessionsControl.js';
import { AgentSessionsFilter, AgentSessionsGrouping } from '../../../contrib/chat/browser/agentSessions/agentSessionsFilter.js';
import { ACTION_ID_NEW_CHAT } from '../../../contrib/chat/browser/actions/chatActions.js';
import { IAgentSession } from '../../../contrib/chat/browser/agentSessions/agentSessionsModel.js';

export const IChatSessionsPartService = createDecorator<IChatSessionsPartService>('chatSessionsPartService');

export interface IChatSessionsPartService {
	readonly _serviceBrand: undefined;
	getFocusedSessions(): IAgentSession[];
	focusSessions(): void;
}

export class ChatSessionsPart extends Part implements IChatSessionsPartService {

	declare readonly _serviceBrand: undefined;

	static readonly ID = 'workbench.parts.chatsessions';

	override readonly minimumWidth: number = 170;
	override readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	override readonly minimumHeight: number = 0;
	override readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	readonly priority = LayoutPriority.Low;

	private sessionsControl: AgentSessionsControl | undefined;
	private sessionsControlContainer: HTMLElement | undefined;
	private newSessionButtonContainer: HTMLElement | undefined;

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(Parts.CHAT_SESSIONS_PART, { hasTitle: false }, themeService, storageService, layoutService);
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		const contentContainer = append(parent, $('.chat-sessions-content'));

		// New Session Button
		this.newSessionButtonContainer = append(contentContainer, $('.chat-sessions-new-button-container'));
		const newSessionButton = this._register(new Button(this.newSessionButtonContainer, { ...defaultButtonStyles, secondary: true }));
		newSessionButton.label = localize('newSession', "New Session");
		this._register(newSessionButton.onDidClick(() => this.commandService.executeCommand(ACTION_ID_NEW_CHAT)));

		// Sessions Filter
		const sessionsFilter = this._register(this.instantiationService.createInstance(AgentSessionsFilter, {
			filterMenuId: MenuId.AgentSessionsViewerFilterSubMenu,
			groupResults: () => AgentSessionsGrouping.Date
		}));

		// Sessions Control
		this.sessionsControlContainer = append(contentContainer, $('.chat-sessions-control-container'));
		this.sessionsControl = this._register(this.instantiationService.createInstance(AgentSessionsControl, this.sessionsControlContainer, {
			source: 'chatSessionsPart',
			filter: sessionsFilter,
			overrideStyles: {
				listBackground: SIDE_BAR_BACKGROUND,
				treeStickyScrollBackground: SIDE_BAR_BACKGROUND,
			},
			getHoverPosition: () => this.getSessionHoverPosition(),
			trackActiveEditorSession: () => true,
		}));

		return contentContainer;
	}

	private getSessionHoverPosition(): HoverPosition {
		const sideBarPosition = this.layoutService.getSideBarPosition();
		// Sessions part is always on the opposite side of the sidebar
		return sideBarPosition === Position.RIGHT ? HoverPosition.RIGHT : HoverPosition.LEFT;
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = this.getContainer();
		if (container) {
			const backgroundColor = this.getColor(SIDE_BAR_BACKGROUND);
			container.style.backgroundColor = backgroundColor || '';

			const foregroundColor = this.getColor(SIDE_BAR_FOREGROUND);
			container.style.color = foregroundColor || '';

			const borderColor = this.getColor(SIDE_BAR_BORDER);
			const isPositionRight = this.layoutService.getSideBarPosition() === Position.RIGHT;
			container.style.borderLeftWidth = isPositionRight ? '' : (borderColor ? '1px' : '');
			container.style.borderLeftStyle = isPositionRight ? '' : (borderColor ? 'solid' : '');
			container.style.borderLeftColor = isPositionRight ? '' : (borderColor || '');
			container.style.borderRightWidth = isPositionRight ? (borderColor ? '1px' : '') : '';
			container.style.borderRightStyle = isPositionRight ? (borderColor ? 'solid' : '') : '';
			container.style.borderRightColor = isPositionRight ? (borderColor || '') : '';
		}
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);

		const contentResult = this.layoutContents(width, height);
		const controlHeight = contentResult.contentSize.height - (this.newSessionButtonContainer?.offsetHeight ?? 0);

		if (this.sessionsControl && this.sessionsControlContainer) {
			this.sessionsControlContainer.style.height = `${controlHeight}px`;
			this.sessionsControl.layout(controlHeight, contentResult.contentSize.width);
		}
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);

		this.sessionsControl?.setVisible(visible);
	}

	getFocusedSessions(): IAgentSession[] {
		return this.sessionsControl?.getFocus() ?? [];
	}

	focusSessions(): void {
		this.sessionsControl?.focus();
	}

	override toJSON(): object {
		return {
			type: Parts.CHAT_SESSIONS_PART
		};
	}
}

registerSingleton(IChatSessionsPartService, ChatSessionsPart, InstantiationType.Eager);
