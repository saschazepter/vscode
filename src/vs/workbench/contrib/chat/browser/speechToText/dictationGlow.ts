/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { computeVoiceGlowStyle, readVoiceGlowIntensity } from '../voiceClient/voiceGlow.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from './chatSpeechToTextService.js';
import { activeDictationEditor } from './dictationSession.js';

/**
 * Adds the same audio-reactive "listening" glow used by Voice Mode to a chat
 * input while dictation is recording into it.
 *
 * Dictation is a singleton, so several surfaces (main window, active-session
 * `ChatView`, and the new-session composer) can each call this on their own
 * input container; the glow is scoped to whichever container actually owns the
 * editor being dictated into so only one surface lights up at a time.
 */
export function setupDictationGlow(service: IChatSpeechToTextService, inputContainer: HTMLElement): IDisposable {
	const store = new DisposableStore();
	const win = dom.getWindow(inputContainer);

	let animFrameId: number | undefined;
	const glowDataArrayRef: { value: Uint8Array | undefined } = { value: undefined };

	const clearGlow = () => {
		inputContainer.style.borderColor = '';
		inputContainer.style.boxShadow = '';
		inputContainer.classList.remove('dictation-active', 'dictation-listening');
	};

	const stopGlowAnimation = () => {
		if (animFrameId !== undefined) {
			win.cancelAnimationFrame(animFrameId);
			animFrameId = undefined;
		}
		clearGlow();
	};

	const startGlowAnimation = () => {
		if (animFrameId !== undefined) {
			return;
		}
		const animate = () => {
			animFrameId = win.requestAnimationFrame(animate);
			const intensity = readVoiceGlowIntensity(service.analyserNode ?? null, glowDataArrayRef);
			// Reuse Voice Mode's blue "listening" glow.
			const { borderColor, boxShadow } = computeVoiceGlowStyle('listening', intensity, true);
			inputContainer.style.borderColor = borderColor;
			inputContainer.style.boxShadow = boxShadow;
			// Dictation-specific classes so we don't trigger Voice Mode's
			// mic-icon highlight (which targets `.voice-active .codicon-voice-mode`).
			inputContainer.classList.add('dictation-active', 'dictation-listening');
		};
		animFrameId = win.requestAnimationFrame(animate);
	};

	const update = () => {
		// Glow only while recording into an editor owned by this container.
		const editor = activeDictationEditor();
		const owned = !!editor && inputContainer.contains(editor.getDomNode());
		if (service.state === ChatSpeechToTextState.Recording && owned) {
			startGlowAnimation();
		} else {
			stopGlowAnimation();
		}
	};

	store.add(service.onDidChangeState(() => update()));
	store.add({ dispose: () => stopGlowAnimation() });
	update();

	return store;
}
