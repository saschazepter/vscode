/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveWindow, getWindow } from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { CHAT_CATEGORY } from './chatActions.js';
import { IChatExecuteActionContext } from './chatExecuteActions.js';
import { IChatWidget, IChatWidgetService } from '../chat.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from '../speechToText/chatSpeechToTextService.js';

export const ChatSpeechToTextConfigured = ContextKeyExpr.and(
	ContextKeyExpr.has('config.chat.speechToText.azure.endpoint'),
	ContextKeyExpr.has('config.chat.speechToText.azure.apiKey'),
);

/** Releases shorter than this are treated as an accidental tap and discarded. */
const HOLD_TO_TALK_THRESHOLD_MS = 500;

class ToggleChatSpeechToTextAction extends Action2 {
	static readonly ID = 'workbench.action.chat.toggleSpeechToText';

	constructor() {
		super({
			id: ToggleChatSpeechToTextAction.ID,
			title: localize2('chat.speechToText.start', "Dictate (Speech to Text)"),
			category: CHAT_CATEGORY,
			icon: Codicon.mic,
			f1: false,
			toggled: {
				condition: ChatContextKeys.speechToTextRecording,
				icon: Codicon.stopCircle,
				title: localize2('chat.speechToText.stop', "Stop Dictation").value,
			},
			menu: [{
				id: MenuId.ChatExecute,
				order: 2,
				when: ChatSpeechToTextConfigured,
				group: 'navigation',
			}],
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const context = args[0] as IChatExecuteActionContext | undefined;
		const widgetService = accessor.get(IChatWidgetService);
		const speechService = accessor.get(IChatSpeechToTextService);

		const widget = context?.widget ?? widgetService.lastFocusedWidget;
		if (!widget) {
			return;
		}

		if (speechService.state === ChatSpeechToTextState.Recording) {
			const text = await speechService.stopAndTranscribe();
			if (text) {
				insertText(widget, text);
			}
			return;
		}

		if (speechService.state !== ChatSpeechToTextState.Idle) {
			return;
		}

		const window = getWindow(widget.domNode) ?? getActiveWindow();
		await speechService.start(window);
	}
}

class HoldToSpeechToTextAction extends Action2 {
	static readonly ID = 'workbench.action.chat.holdToSpeechToText';

	constructor() {
		super({
			id: HoldToSpeechToTextAction.ID,
			title: localize2('chat.speechToText.hold', "Hold to Dictate (Speech to Text)"),
			category: CHAT_CATEGORY,
			f1: false,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				when: ContextKeyExpr.and(ChatSpeechToTextConfigured, ChatContextKeys.inChatInput),
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyV,
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const context = args[0] as IChatExecuteActionContext | undefined;
		const widgetService = accessor.get(IChatWidgetService);
		const speechService = accessor.get(IChatSpeechToTextService);
		const keybindingService = accessor.get(IKeybindingService);

		const widget = context?.widget ?? widgetService.lastFocusedWidget;
		if (!widget || speechService.state !== ChatSpeechToTextState.Idle) {
			return;
		}

		// Resolves when the triggering key is released.
		const holdMode = keybindingService.enableKeybindingHoldMode(HoldToSpeechToTextAction.ID);
		if (!holdMode) {
			return;
		}

		const window = getWindow(widget.domNode) ?? getActiveWindow();
		const heldFrom = Date.now();
		try {
			await speechService.start(window);
		} catch {
			return; // microphone acquisition failed; already surfaced to the user
		}

		await holdMode;

		// Treat a quick tap as accidental: discard instead of transcribing.
		if (Date.now() - heldFrom < HOLD_TO_TALK_THRESHOLD_MS) {
			speechService.cancel();
			return;
		}

		const text = await speechService.stopAndTranscribe();
		if (text) {
			insertText(widget, text);
		}
	}
}

function insertText(widget: IChatWidget, text: string): void {
	const editor = widget.inputEditor;
	const model = editor.getModel();
	if (!model) {
		return;
	}
	const selection = editor.getSelection() ?? model.getFullModelRange().collapseToEnd();
	const needsLeadingSpace = selection.startColumn > 1 && !/\s$/.test(model.getValueInRange({
		startLineNumber: selection.startLineNumber,
		startColumn: Math.max(1, selection.startColumn - 1),
		endLineNumber: selection.startLineNumber,
		endColumn: selection.startColumn,
	}));
	const insertion = needsLeadingSpace ? ` ${text}` : text;
	editor.executeEdits('chatSpeechToText', [{ range: selection, text: insertion, forceMoveMarkers: true }]);
	widget.focusInput();
}

export function registerChatSpeechToTextActions(): DisposableStore {
	const store = new DisposableStore();
	store.add(registerAction2(ToggleChatSpeechToTextAction));
	store.add(registerAction2(HoldToSpeechToTextAction));
	return store;
}
