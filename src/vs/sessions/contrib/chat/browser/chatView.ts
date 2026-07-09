/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voiceChatView.css';
import * as dom from '../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMicCaptureService } from '../../../../workbench/contrib/chat/browser/voiceClient/micCaptureService.js';
import { ITtsPlaybackService } from '../../../../workbench/contrib/chat/browser/voiceClient/ttsPlaybackService.js';
import { IVoiceSessionController } from '../../../../workbench/contrib/chat/browser/voiceClient/voiceSessionController.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { EDITOR_DRAG_AND_DROP_BACKGROUND } from '../../../../workbench/common/theme.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { IChatModelReference, IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../workbench/contrib/chat/common/constants.js';
import { getChatSessionType } from '../../../../workbench/contrib/chat/common/model/chatUri.js';
import { IChatSessionsService, localChatSessionType } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { AbstractChatView, ChatViewKind, IChatViewOptions } from '../../../browser/parts/chatView.js';
import { ChatInteractivity, IChat } from '../../../services/sessions/common/session.js';
import { IChatViewFactory } from '../../../services/chatView/browser/chatViewFactory.js';
import { NewChatWidget } from './newChatWidget.js';
import { NewChatInSessionWidget } from './newChatInSessionWidget.js';
import { SessionInputBanners } from '../../sessionInputBanners/browser/sessionInputBanners.js';
import { SessionRunningSubagentsControl } from './sessionRunningSubagentsControl.js';
import { SessionChatInputToolbar } from './sessionChatInputToolbar.js';
import { AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING } from './sessionsChatHistory.js';
import { activeSessionViewBackground, activeSessionViewForeground, agentsPanelBackground, inactiveSessionViewBackground, inactiveSessionViewForeground } from '../../../common/theme.js';
import { isEqual } from '../../../../base/common/resources.js';

/**
 * A session view that hosts a {@link NewChatWidget} — the "new session" UI
 * shown before a session has been created. This is the default view that
 * the `SessionsPart` grid is seeded with.
 */
export class NewChatView extends AbstractChatView {

	static readonly TYPE = 'sessions.newSession';

	override readonly kind: ChatViewKind;

	private readonly _widget: NewChatWidget | NewChatInSessionWidget;

	constructor(
		isNewChatInSession: boolean,
		options: IChatViewOptions,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();

		this.element.classList.add('chat-view-new');
		this.kind = isNewChatInSession ? 'newChatInSession' : 'newSession';
		this._widget = this._register(isNewChatInSession
			? instantiationService.createInstance(NewChatInSessionWidget, options)
			: instantiationService.createInstance(NewChatWidget, options));
		this._widget.render(this.element);
	}

	override toJSON(): object {
		return { type: NewChatView.TYPE };
	}

	protected override doLayout(width: number, height: number, _top: number, _left: number): void {
		this._widget.layout(height, width);
	}

	override focus(): void {
		this._widget.focusInput();
	}

	override selectWorkspace(folderUri: URI, providerId?: string): void {
		if (this._widget instanceof NewChatWidget) {
			this._widget.selectWorkspace(folderUri, providerId);
		}
	}

	override prefillInput(text: string): void {
		if (this._widget instanceof NewChatWidget) {
			this._widget.prefillInput(text);
		}
	}

	override sendQuery(text: string): void {
		if (this._widget instanceof NewChatWidget) {
			this._widget.sendQuery(text);
		}
	}

	override attach(uris: URI[]): void {
		this._widget.attach(uris);
	}
}

/**
 * A session view that hosts the standard chat {@link ChatWidget} — used to
 * render an active chat session inside the `SessionsPart` grid.
 */
export class ChatView extends AbstractChatView {

	static readonly TYPE = 'sessions.session';

	override readonly kind: ChatViewKind = 'chat';

	private readonly _widget: ChatWidget;

	/** Session banners (CI failures, created comments) shown above the chat input. */
	private readonly _banners: SessionInputBanners;
	/** Ephemeral chip above the input listing the active chat's running subagents. */
	private readonly _runningSubagents: SessionRunningSubagentsControl;
	/** Floating status pills (changes, preview) above the input; agent host only. */
	private readonly _chatPills: SessionChatInputToolbar;

	/** Reference to the loaded chat model; disposing releases the model. */
	private readonly _modelRef = this._register(new MutableDisposable<IChatModelReference>());

	/** Cancels any in-flight model load when a new session is set or the view disposes. */
	private readonly _loadCts = this._register(new MutableDisposable<CancellationTokenSource>());

	/** Tracks the current chat's interactivity and hides the input for read-only chats. */
	private readonly _interactiveDisposable = this._register(new MutableDisposable());

	/** Tracks the currently loaded chat resource to avoid redundant reloads. */
	private _currentChatResource: URI | undefined;
	private _historyKey: string | undefined;

	/** Whether this view currently represents the active session. */
	private _isActive = true;
	/** Observable mirror of {@link _isActive} so the voice overlay can react. */
	private readonly _isActiveObs = observableValue<boolean>(this, true);

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IChatService private readonly chatService: IChatService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IVoiceSessionController private readonly voiceSessionController: IVoiceSessionController,
		@IMicCaptureService private readonly micCaptureService: IMicCaptureService,
		@ITtsPlaybackService private readonly ttsPlaybackService: ITtsPlaybackService,
	) {
		super();

		this.element.classList.add('chat-view-chat');

		const scopedContextKeyService = this._register(contextKeyService.createScoped(this.element));
		const scopedInstantiationService = this._register(instantiationService.createChild(
			new ServiceCollection([IContextKeyService, scopedContextKeyService])
		));

		this._widget = this._register(scopedInstantiationService.createInstance(
			ChatWidget,
			ChatAgentLocation.Chat,
			undefined,
			{
				autoScroll: mode => mode !== ChatModeKind.Ask,
				renderFollowups: true,
				supportsFileReferences: true,
				rendererOptions: {
					referencesExpandedWhenEmptyResponse: false,
					progressMessageAtBottomOfResponse: mode => mode !== ChatModeKind.Ask,
				},
				enableImplicitContext: true,
				enableWorkingSet: 'implicit',
				supportsChangingModes: true,
				inputEditorMinLines: 2,
				isSessionsWindow: true
			},
			this._buildStyles(this._isActive)
		));
		this._widget.render(this.element);
		this._widget.setVisible(true);

		// Mount the session banners directly above the chat input.
		this._banners = this._register(instantiationService.createInstance(SessionInputBanners));
		this._banners.setActive(this._isActive);

		// Ephemeral running-subagents chip above the input (hidden while idle).
		this._runningSubagents = this._register(instantiationService.createInstance(SessionRunningSubagentsControl));
		// Floating status pills above the input (hidden unless an agent host session
		// has changes or a previewable file).
		this._chatPills = this._register(instantiationService.createInstance(SessionChatInputToolbar));
		this._ensureBannersMounted();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING)) {
				this._applyHistoryKey();
			}
		}));

		// Voice mode transcript overlay + audio-reactive glow on the chat input.
		this._setupVoiceOverlay();
	}

	override dispose(): void {
		this._loadCts.value?.cancel();
		super.dispose();
	}

	private _buildStyles(active: boolean) {
		return {
			listForeground: active ? activeSessionViewForeground : inactiveSessionViewForeground,
			listBackground: active ? activeSessionViewBackground : inactiveSessionViewBackground,
			overlayBackground: EDITOR_DRAG_AND_DROP_BACKGROUND,
			inputEditorBackground: inactiveSessionViewBackground,
			resultEditorBackground: agentsPanelBackground,
		};
	}

	/** The underlying chat widget. */
	get widget(): ChatWidget {
		return this._widget;
	}

	override setChat(chat: IChat, historyKey?: string): void {
		const resource = chat.resource;
		this._historyKey = historyKey;
		this._applyHistoryKey();

		// Monitor this chat's running subagents in the ephemeral chip.
		this._runningSubagents.setChat(resource);

		// Reflect this chat's last-turn changes and status in the floating pills.
		this._chatPills.setChat(chat);

		// Reflect read-only (non-interactive) chats: hide the composer and gate
		// mutating actions (Start Over / Restore Checkpoint) via the widget. Any
		// non-Full interactivity is treated as read-only here (hidden chats are
		// filtered out of the visible model before they reach a ChatView).
		this._interactiveDisposable.value = autorun(reader => {
			this._widget.setReadOnly(chat.interactivity.read(reader) !== ChatInteractivity.Full);
		});

		// Skip loading if we're already showing this chat
		if (isEqual(this._currentChatResource, resource)) {
			return;
		}

		const previousChatResource = this._currentChatResource;
		this._currentChatResource = resource;

		// Cancel any in-flight load for the previous chat and start a fresh one.
		this._loadCts.value?.cancel();
		if (previousChatResource) {
			this._clearCurrentChat();
		}
		const cts = new CancellationTokenSource();
		this._loadCts.value = cts;
		const token = cts.token;

		const loadPromise = this.chatService.acquireOrLoadSession(resource, ChatAgentLocation.Chat, token, 'ChatView').then(ref => {
			if (token.isCancellationRequested || !ref || !isEqual(this._currentChatResource, resource)) {
				ref?.dispose();
				return;
			}
			this._modelRef.value = ref;
			this._updateWidgetLockState(getChatSessionType(ref.object.sessionResource));
			this._widget.setModel(ref.object);
			// Expose the bound chat resource on the DOM so test automation
			// can synchronize with the post-rebind state without polling timeouts.
			// Set AFTER `setModel` so observers see the attribute only once the
			// inner widget is fully attached to the loaded model.
			this.element.dataset.boundChatResource = resource.toString();
		}, err => {
			if (!token.isCancellationRequested) {
				this.logService.error('[ChatView] Failed to load chat model for chat', err);
			}
			if (isEqual(this._currentChatResource, resource)) { // might have changed while we were waiting, only reset if it is still the same
				this._currentChatResource = undefined;
			}
		});

		// Surface progress on this leaf's own bar while the chat model loads,
		// matching how each editor group shows progress independently. The short
		// delay avoids flashing the bar for fast cached loads.
		this.showProgressWhile(loadPromise, 800);
	}

	private _clearCurrentChat(): void {
		this._widget.clear().catch(err => this.logService.error('[ChatView] Failed to clear chat widget', err));
		this._widget.setModel(undefined);
		this._modelRef.clear();
		// Clear the bound-resource attribute while the rebind is in flight so
		// test automation can wait for the next `setChat` cycle to finish
		// before acting on the view.
		delete this.element.dataset.boundChatResource;
	}

	private _applyHistoryKey(): void {
		const scopedHistory = this.configurationService.getValue<boolean>(AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING) !== false;
		this._widget.inputPart.setHistoryKey(scopedHistory ? this._historyKey : undefined);
	}

	private _updateWidgetLockState(sessionType: string): void {
		if (sessionType === localChatSessionType) {
			this._widget.unlockFromCodingAgent();
			return;
		}

		const contribution = this.chatSessionsService.getChatSessionContribution(sessionType);
		if (contribution) {
			this._widget.lockToCodingAgent(contribution.name, contribution.displayName, sessionType, contribution.agentHostProviderId);
		} else {
			this._widget.unlockFromCodingAgent();
		}
	}

	override toJSON(): object {
		return { type: ChatView.TYPE };
	}

	protected override doLayout(width: number, height: number, _top: number, _left: number): void {
		this._ensureBannersMounted();
		this._widget.layout(height, width);
	}

	/**
	 * Mounts the running-subagents chip and the session banners above the chat
	 * input, as the first children of the input part (the chip sits directly above
	 * the banners). Idempotent — re-runs cheaply on layout to recover if the chat
	 * widget rebuilds its input part DOM.
	 */
	private _ensureBannersMounted(): void {
		const inputPartElement = this._widget.inputPart.element;
		const pillsNode = this._chatPills.element;
		const subagentsNode = this._runningSubagents.element;
		const bannersNode = this._banners.domNode;
		// Desired order at the top of the input part: [pillsNode, subagentsNode, bannersNode, ...].
		// Keyed off the pills first so this is a true no-op once the DOM has settled.
		if (inputPartElement.firstChild !== pillsNode) {
			inputPartElement.insertBefore(pillsNode, inputPartElement.firstChild);
		}
		if (pillsNode.nextSibling !== subagentsNode) {
			inputPartElement.insertBefore(subagentsNode, pillsNode.nextSibling);
		}
		if (subagentsNode.nextSibling !== bannersNode) {
			inputPartElement.insertBefore(bannersNode, subagentsNode.nextSibling);
		}
	}

	//#region Voice overlay

	/**
	 * Sets up the voice mode transcript overlay and audio-reactive glow on this
	 * view's chat input, mirroring the main-window `ChatViewPane`. The overlay is
	 * only shown while voice mode is connected and this view is the active
	 * session; the transcript is hidden when the voice backend is targeting a
	 * different session so it is never misrouted.
	 */
	private _setupVoiceOverlay(): void {
		const inputContainerEl = this._widget.inputPart.inputContainerElement;
		if (!inputContainerEl) {
			return;
		}
		inputContainerEl.style.position = 'relative';

		const transcriptOverlay = dom.$('.voice-transcript-overlay');
		const transcriptScrollable = this._register(new DomScrollableElement(transcriptOverlay, {
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
				const voiceState = this.voiceSessionController.voiceState.get();

				const analyser = this.ttsPlaybackService.analyserNode
					?? (voiceState === 'listening' ? this.micCaptureService.analyserNode : null)
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
				const transcriptHidden = this.configurationService.getValue<boolean>('agents.voice.showTranscript') === false;
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

		this._register(autorun(reader => {
			const connected = this.voiceSessionController.isConnected.read(reader);
			const voiceState = this.voiceSessionController.voiceState.read(reader);
			const active = this._isActiveObs.read(reader);
			if (connected && active && (voiceState === 'listening' || voiceState === 'speaking')) {
				startGlowAnimation();
			} else {
				stopGlowAnimation();
			}
		}));
		this._register({ dispose: () => stopGlowAnimation() });

		// --- Transcript rendering ---
		this._register(autorun(reader => {
			const turns = this.voiceSessionController.transcriptTurns.read(reader);
			const connected = this.voiceSessionController.isConnected.read(reader);
			const voiceState = this.voiceSessionController.voiceState.read(reader);
			const targetSession = this.voiceSessionController.targetSession.read(reader);
			const active = this._isActiveObs.read(reader);
			const showTranscript = this.configurationService.getValue<boolean>('agents.voice.showTranscript') !== false;
			const current = this._currentChatResource;
			const visible = turns.filter(t => t.text.length > 0 || (t.speaker === 'user' && t.isPartial));

			// Only the active session view renders the transcript, and never a
			// transcript the backend is targeting at a different session.
			const targetedElsewhere = !!targetSession && !!current && !isEqual(targetSession, current);
			if (!connected || !active || targetedElsewhere) {
				transcriptOverlayNode.style.display = 'none';
				transcriptOverlayNode.classList.remove('has-transcript');
				return;
			}

			if (visible.length === 0 || !showTranscript) {
				const handsFree = this.configurationService.getValue<boolean>('agents.voice.handsFree') !== false;
				if (voiceState === 'idle' && visible.length === 0 && showTranscript && !handsFree) {
					transcriptOverlayNode.style.display = '';
					transcriptOverlayNode.classList.remove('has-transcript');
					transcriptOverlay.replaceChildren();
					const hint = dom.$('span.partial');
					const kb = this.keybindingService.lookupKeybinding('agentsVoice.pushToTalk');
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
	}

	//#endregion

	override focus(): void {
		this._widget.focusInput();
	}

	override attach(uris: URI[]): void {
		for (const uri of uris) {
			this._widget.attachmentModel.addFile(uri).catch(err => this.logService.error('[ChatView] Failed to attach file as context', err));
		}
	}

	override setActive(active: boolean): void {
		if (this._isActive === active) {
			return;
		}
		this._isActive = active;
		this._isActiveObs.set(active, undefined);
		this._banners.setActive(active);
		this._widget.setStyles(this._buildStyles(active));
	}
}

/**
 * Default {@link IChatViewFactory} implementation. Lives in the contrib
 * layer where the concrete views are defined and is registered as an eager
 * singleton via the entry point.
 */
export class ChatViewFactory implements IChatViewFactory {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) { }

	createNewChatView(isNewChatInSession: boolean, options: IChatViewOptions): AbstractChatView {
		return this.instantiationService.createInstance(NewChatView, isNewChatInSession, options);
	}

	createChatView(): AbstractChatView {
		return this.instantiationService.createInstance(ChatView);
	}
}
