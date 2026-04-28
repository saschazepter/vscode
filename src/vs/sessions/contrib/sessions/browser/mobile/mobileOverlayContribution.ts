/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerAction2, Action2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ITextFileService } from '../../../../../workbench/services/textfile/common/textfiles.js';
import { IChatTerminalToolInvocationData } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IEditSessionEntryDiff } from '../../../../../workbench/contrib/chat/common/editing/chatEditingService.js';
import { openMobileTerminalView } from '../../../../../sessions/browser/parts/mobile/contributions/mobileTerminalView.js';
import { openMobileDiffView } from '../../../../../sessions/browser/parts/mobile/contributions/mobileDiffView.js';
import { IsPhoneLayoutContext } from '../../../../../sessions/common/contextkeys.js';

/**
 * Command ID for opening the mobile terminal output view.
 *
 * Accepts {@link IChatTerminalToolInvocationData} as the single argument.
 * Phone-only: guarded by {@link IsPhoneLayoutContext}.
 */
export const MOBILE_OPEN_TERMINAL_VIEW_COMMAND_ID = 'sessions.mobile.openTerminalView';

/**
 * Command ID for opening the mobile diff view.
 *
 * Accepts {@link IEditSessionEntryDiff} as the single argument.
 * Phone-only: guarded by {@link IsPhoneLayoutContext}.
 */
export const MOBILE_OPEN_DIFF_VIEW_COMMAND_ID = 'sessions.mobile.openDiffView';

class MobileOpenTerminalViewAction extends Action2 {
	constructor() {
		super({
			id: MOBILE_OPEN_TERMINAL_VIEW_COMMAND_ID,
			title: { value: 'Open Terminal Output', original: 'Open Terminal Output' },
			precondition: IsPhoneLayoutContext,
			f1: false,
		});
	}

	run(accessor: ServicesAccessor, terminalData: IChatTerminalToolInvocationData): void {
		const layoutService = accessor.get(ILayoutService);
		openMobileTerminalView(layoutService.mainContainer, { terminalData });
	}
}

class MobileOpenDiffViewAction extends Action2 {
	constructor() {
		super({
			id: MOBILE_OPEN_DIFF_VIEW_COMMAND_ID,
			title: { value: 'Open File Diff', original: 'Open File Diff' },
			precondition: IsPhoneLayoutContext,
			f1: false,
		});
	}

	run(accessor: ServicesAccessor, diff: IEditSessionEntryDiff): void {
		const layoutService = accessor.get(ILayoutService);
		const textFileService = accessor.get(ITextFileService);
		openMobileDiffView(layoutService.mainContainer, { diff }, textFileService);
	}
}

registerAction2(MobileOpenTerminalViewAction);
registerAction2(MobileOpenDiffViewAction);
