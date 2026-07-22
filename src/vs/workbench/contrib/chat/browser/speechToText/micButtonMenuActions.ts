/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAction, toAction } from '../../../../../base/common/actions.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';

/** Command that opens the microphone picker shared by dictation and Voice Mode. */
export const SELECT_MICROPHONE_COMMAND = 'workbench.action.chat.selectSpeechToTextMicrophone';
/** Setting that enables dictation; toggled off by "Disable Dictation". */
const DICTATION_ENABLED_SETTING = 'chat.speechToText.enabled';
/** Setting that enables Voice Mode; toggled off by "Disable Voice Mode". */
const VOICE_ENABLED_SETTING = 'agents.voice.enabled';
/** Command that tears down an active Voice Mode session. */
const VOICE_DISCONNECT_COMMAND = 'agentsVoice.disconnect';

/**
 * "Select Microphone" entry shared by every dictation / Voice Mode mic button
 * context menu. Opens the picker shared by both features.
 */
export function createSelectMicrophoneAction(commandService: ICommandService): IAction {
	return toAction({
		id: SELECT_MICROPHONE_COMMAND,
		label: localize('mic.selectMicrophone', "Select Microphone"),
		run: () => commandService.executeCommand(SELECT_MICROPHONE_COMMAND),
	});
}

/** "Disable Dictation" entry — turns off the dictation feature setting. */
export function createDisableDictationAction(configurationService: IConfigurationService): IAction {
	return toAction({
		id: 'chat.dictation.disable',
		label: localize('dictation.disable', "Disable Dictation"),
		run: () => configurationService.updateValue(DICTATION_ENABLED_SETTING, false),
	});
}

/**
 * "Disable Voice Mode" entry. Tears down any active session first so disabling
 * the setting doesn't leave the microphone capturing while the toolbar
 * affordance disappears, then turns off the feature setting.
 */
export function createDisableVoiceModeAction(commandService: ICommandService, configurationService: IConfigurationService): IAction {
	return toAction({
		id: 'chat.voiceMode.disable',
		label: localize('voiceMode.disable', "Disable Voice Mode"),
		run: async () => {
			await commandService.executeCommand(VOICE_DISCONNECT_COMMAND);
			await configurationService.updateValue(VOICE_ENABLED_SETTING, false);
		},
	});
}
