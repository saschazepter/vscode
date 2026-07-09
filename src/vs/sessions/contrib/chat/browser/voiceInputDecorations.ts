/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import './media/voiceChatView.css';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IObservable, autorun } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IMicCaptureService } from '../../../../workbench/contrib/chat/browser/voiceClient/micCaptureService.js';
import { ITtsPlaybackService } from '../../../../workbench/contrib/chat/browser/voiceClient/ttsPlaybackService.js';
import { IVoiceSessionController } from '../../../../workbench/contrib/chat/browser/voiceClient/voiceSessionController.js';

export interface IVoiceInputDecorationsServices {
	readonly voiceSessionController: IVoiceSessionController;
	readonly ttsPlaybackService: ITtsPlaybackService;
	readonly micCaptureService: IMicCaptureService;
	readonly configurationService: IConfigurationService;
	readonly keybindingService: IKeybindingService;
}

export interface IVoiceInputDecorationsOptions {
	/** The input container that receives the audio-reactive glow and hosts the transcript overlay. */
	readonly inputContainer: HTMLElement;
	/** Whether this surface is the active/visible one; decorations only render when active. */
	readonly isActive: IObservable<boolean>;
	/** Resource identifying this surface, compared against the voice backend's target to avoid misrouting. */
	readonly getCurrentResource: () => URI | undefined;
}

/**
 * Sets up the voice mode transcript overlay and audio-reactive glow on a chat
 * input container. Shared by the Agents window's active-session `ChatView` and
 * the new-session composer so both surfaces render identical voice decorations.
 *
 * The overlay/glow are only shown while voice mode is connected and this surface
 * is active; they are suppressed when the voice backend is targeting a different
 * session so the transcript is never misrouted.
 */
export function setupVoiceInputDecorations(services: IVoiceInputDecorationsServices, options: IVoiceInputDecorationsOptions): IDisposable {
	const { voiceSessionController, ttsPlaybackService, micCaptureService, configurationService, keybindingService } = services;
	const { inputContainer: inputContainerEl, isActive, getCurrentResource } = options;

	const store = new DisposableStore();

	inputContainerEl.style.position = 'relative';

	const transcriptOverlay = dom.$('.voice-transcript-overlay');
	const transcriptScrollable = store.add(new DomScrollableElement(transcriptOverlay, {
		horizontal: ScrollbarVisibility.Hidden,
		vertical: ScrollbarVisibility.Auto,
	}));
	const transcriptOverlayNode = transcriptScrollable.getDomNode();
	transcriptOverlayNode.classList.add('voice-transcript-overlay-scrollable');
	transcriptOverlayNode.style.display = 'none';
	inputContainerEl.append(transcriptOverlayNode);

	// --- Audio-reactive glow (matches main-window behavior) ---
	const win = dom.getWindow(inputContainerEl);
	let animFrameId: number | undefined;
	let glowDataArray: Uint8Array | undefined;
	const startGlowAnimation = () => {
		if (animFrameId !== undefined) {
			return;
		}
		const animate = () => {
			animFrameId = win.requestAnimationFrame(animate);
			const voiceState = voiceSessionController.voiceState.get();

			const analyser = ttsPlaybackService.analyserNode
				?? (voiceState === 'listening' ? micCaptureService.analyserNode : null)
				?? null;
			let intensity: number;
			if (!analyser) {
				intensity = 0.3;
			} else {
				if (!glowDataArray || glowDataArray.length !== analyser.frequencyBinCount) {
					glowDataArray = new Uint8Array(analyser.frequencyBinCount);
				}
				analyser.getByteFrequencyData(glowDataArray as Uint8Array<ArrayBuffer>);
				let sum = 0;
				for (let i = 0; i < glowDataArray.length; i++) {
					sum += glowDataArray[i];
				}
				intensity = Math.min(1, (sum / glowDataArray.length) / 80);
			}

			// Blue when listening, purple when speaking.
			const rgb = voiceState === 'speaking' ? '163,113,247' : '88,166,255';
			const transcriptHidden = configurationService.getValue<boolean>('agents.voice.showTranscript') === false;
			let borderAlpha: number;
			let shadowSpread: number;
			let shadowAlpha: number;
			if (voiceState === 'listening' && transcriptHidden) {
				borderAlpha = 0.6 + intensity * 0.4;
				shadowSpread = 6 + intensity * 20;
				shadowAlpha = 0.25 + intensity * 0.55;
			} else {
				borderAlpha = 0.4 + intensity * 0.5;
				shadowSpread = 4 + intensity * 12;
				shadowAlpha = 0.15 + intensity * 0.35;
			}
			inputContainerEl.style.borderColor = `rgba(${rgb},${borderAlpha})`;
			if (voiceState === 'listening' && transcriptHidden) {
				inputContainerEl.style.boxShadow = `0 0 ${shadowSpread}px rgba(${rgb},${shadowAlpha}), 0 0 ${shadowSpread * 2}px rgba(${rgb},${shadowAlpha * 0.3}), inset 0 0 ${shadowSpread * 0.5}px rgba(${rgb},${shadowAlpha * 0.4})`;
			} else {
				inputContainerEl.style.boxShadow = `0 0 ${shadowSpread}px rgba(${rgb},${shadowAlpha}), inset 0 0 ${shadowSpread * 0.4}px rgba(${rgb},${shadowAlpha * 0.3})`;
			}
			inputContainerEl.classList.add('voice-active');
			inputContainerEl.classList.toggle('voice-listening', voiceState === 'listening');
		};
		animFrameId = win.requestAnimationFrame(animate);
	};
	const stopGlowAnimation = () => {
		if (animFrameId !== undefined) {
			win.cancelAnimationFrame(animFrameId);
			animFrameId = undefined;
		}
		inputContainerEl.style.borderColor = '';
		inputContainerEl.style.boxShadow = '';
		inputContainerEl.classList.remove('voice-active', 'voice-listening');
	};

	store.add(autorun(reader => {
		const connected = voiceSessionController.isConnected.read(reader);
		const voiceState = voiceSessionController.voiceState.read(reader);
		const active = isActive.read(reader);
		const targetSession = voiceSessionController.targetSession.read(reader);
		const current = getCurrentResource();
		// The Sessions window renders multiple session slots at once; only glow
		// the active slot, and never a slot the backend is targeting elsewhere.
		const targetedElsewhere = !!targetSession && !!current && !isEqual(targetSession, current);
		if (connected && active && !targetedElsewhere && (voiceState === 'listening' || voiceState === 'speaking')) {
			startGlowAnimation();
		} else {
			stopGlowAnimation();
		}
	}));
	store.add({ dispose: () => stopGlowAnimation() });

	// --- Transcript rendering ---
	store.add(autorun(reader => {
		const turns = voiceSessionController.transcriptTurns.read(reader);
		const connected = voiceSessionController.isConnected.read(reader);
		const voiceState = voiceSessionController.voiceState.read(reader);
		const targetSession = voiceSessionController.targetSession.read(reader);
		const active = isActive.read(reader);
		const showTranscript = configurationService.getValue<boolean>('agents.voice.showTranscript') !== false;
		const current = getCurrentResource();
		const visible = turns.filter(t => t.text.length > 0 || (t.speaker === 'user' && t.isPartial));

		// Only the active surface renders the transcript, and never a transcript
		// the backend is targeting at a different session.
		const targetedElsewhere = !!targetSession && !!current && !isEqual(targetSession, current);
		if (!connected || !active || targetedElsewhere) {
			transcriptOverlayNode.style.display = 'none';
			transcriptOverlayNode.classList.remove('has-transcript');
			return;
		}

		if (visible.length === 0 || !showTranscript) {
			const handsFree = configurationService.getValue<boolean>('agents.voice.handsFree') !== false;
			if (voiceState === 'idle' && visible.length === 0 && showTranscript && !handsFree) {
				transcriptOverlayNode.style.display = '';
				transcriptOverlayNode.classList.remove('has-transcript');
				transcriptOverlay.replaceChildren();
				const hint = dom.$('span.partial');
				const kb = keybindingService.lookupKeybinding('agentsVoice.pushToTalk');
				const kbLabel = kb?.getLabel();
				hint.textContent = kbLabel
					? localize('voiceMode.pttHint', "Press {0} to talk", kbLabel)
					: localize('voiceMode.clickMicHint', "Click voice mode to talk");
				transcriptOverlay.append(hint);
				transcriptScrollable.scanDomNode();
			} else {
				transcriptOverlayNode.style.display = 'none';
				transcriptOverlayNode.classList.remove('has-transcript');
			}
			return;
		}

		transcriptOverlayNode.style.display = '';
		transcriptOverlayNode.classList.add('has-transcript');
		// Show only the latest visible turn.
		const lastTurn = visible[visible.length - 1];
		const contentElements: HTMLElement[] = [];
		if (lastTurn.speaker === 'user') {
			const span = dom.$('span');
			if (lastTurn.isPartial) {
				const committedPart = lastTurn.committed || '';
				const unsurePart = lastTurn.text.slice(committedPart.length);
				if (committedPart) {
					const c = dom.$('span.committed');
					c.textContent = committedPart;
					span.append(c);
				}
				const u = dom.$('span.partial');
				u.textContent = unsurePart + '\u2589';
				span.append(u);
			} else {
				span.className = 'committed';
				span.textContent = lastTurn.text;
			}
			contentElements.push(span);
		} else {
			const div = dom.$('div.assistant-text');
			div.textContent = lastTurn.text;
			contentElements.push(div);
		}
		transcriptOverlay.replaceChildren(...contentElements);
		transcriptScrollable.scanDomNode();
		transcriptScrollable.setScrollPosition({ scrollTop: 0 });
	}));

	return store;
}
