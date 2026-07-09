/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { isEqual } from '../../../../base/common/resources.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IVoiceSessionController } from '../../../../workbench/contrib/chat/browser/voiceClient/voiceSessionController.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { INewChatVoiceTargetService, NEW_CHAT_VOICE_SENTINEL } from './newChatVoice.js';

/**
 * Bridges the shared {@link IVoiceSessionController} to the Agents (Sessions)
 * window chat surfaces. The controller drives the chat exclusively through the
 * `_chat.voice.*` commands; in the main VS Code window these are registered by
 * `ChatViewPane`. The Agents window hosts chats through {@link ISessionsService}
 * instead, so it registers its own bridge here.
 *
 * The commands are only registered while `agents.voice.enabled` is set, matching
 * the main-window behavior, and are wired to the sessions model:
 * - `_chat.voice.acceptInput` injects transcribed text into the focused chat widget.
 * - `_chat.voice.getCurrentSession` reports the active session's chat resource.
 * - `_chat.voice.switchToSession` activates the session that owns a chat resource.
 */
class SessionsVoiceBridgeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.voiceBridge';

	private readonly _commandDisposables = this._register(new DisposableStore());

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@ISessionsManagementService private readonly sessionsManagementService: ISessionsManagementService,
		@INewChatVoiceTargetService private readonly newChatVoiceTargetService: INewChatVoiceTargetService,
	) {
		super();

		this._updateCommands();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('agents.voice.enabled')) {
				this._updateCommands();
			}
		}));
	}

	private _updateCommands(): void {
		this._commandDisposables.clear();

		if (this.configurationService.getValue<boolean>('agents.voice.enabled') !== true) {
			return;
		}

		// Inject transcribed text into the active session's chat widget. Unlike
		// the main window (a single chat pane), the Agents window keeps DOM focus
		// on the sessions list while showing a chat, so `lastFocusedWidget` is
		// frequently stale; prefer the active session's widget and only fall back
		// to the focused widget when there is no active session.
		this._commandDisposables.add(CommandsRegistry.registerCommand('_chat.voice.acceptInput', (_accessor, text: string) => {
			if (!text) {
				return;
			}
			// If a new-session composer is the voice target (no session exists yet),
			// submit through it so the transcribed request creates the session.
			// This takes priority over `lastFocusedWidget`, which can still point at
			// a previously-opened session's chat widget on the welcome screen.
			const composer = this._activeComposerTarget();
			if (composer) {
				composer.sendQuery(text);
				return;
			}
			const widget = this._activeSessionWidget() ?? this.chatWidgetService.lastFocusedWidget;
			if (widget?.viewModel) {
				if (widget.viewModel.editing) {
					// When editing an old message, populate the active input editor
					// so the user can review before submitting.
					widget.input.setValue(text, false);
				} else {
					widget.acceptInput(text, { preserveFocus: true });
				}
			}
		}));

		// Report the currently shown session's chat resource. Mirrors the main
		// window's use of its single pane's shown session (not DOM focus): in the
		// Agents window the shown session is the active session. When no session
		// exists yet but a new-session composer is mounted, report the composer
		// sentinel so the controller routes input to it instead of spinning up a
		// bare, unconfigured chat session.
		this._commandDisposables.add(CommandsRegistry.registerCommand('_chat.voice.getCurrentSession', (): string | undefined => {
			const activeChat = this._createdActiveChatResource();
			if (activeChat) {
				return activeChat.toString();
			}
			if (this._activeComposerTarget()) {
				return NEW_CHAT_VOICE_SENTINEL.toString();
			}
			return this.chatWidgetService.lastFocusedWidget?.viewModel?.sessionResource?.toString();
		}));

		// Activate the session that owns the given chat resource so its response
		// becomes visible to the user.
		this._commandDisposables.add(CommandsRegistry.registerCommand('_chat.voice.switchToSession', async (_accessor, resourceStr: string): Promise<boolean> => {
			if (!resourceStr) {
				return false;
			}
			// The composer sentinel has no session to open; just focus the composer.
			if (resourceStr === NEW_CHAT_VOICE_SENTINEL.toString()) {
				const composer = this._activeComposerTarget();
				composer?.focus();
				return !!composer;
			}
			let resource: URI;
			try {
				resource = URI.parse(resourceStr);
			} catch {
				return false;
			}

			// A chat resource maps to its owning session (and specific chat).
			const owner = this.sessionsManagementService.getSessionForChatResource(resource);
			if (owner) {
				await this.sessionsService.openSession(owner.session.resource, { preserveFocus: true });
				if (!isEqual(owner.chat.resource, owner.session.resource)) {
					await this.sessionsService.openChat(owner.session, owner.chat.resource);
				}
				return true;
			}

			// Otherwise treat the resource as a session resource.
			const session = this.sessionsManagementService.getSession(resource);
			if (session) {
				await this.sessionsService.openSession(session.resource, { preserveFocus: true });
				return true;
			}

			try {
				await this.sessionsService.openSession(resource, { preserveFocus: true });
				return true;
			} catch {
				return false;
			}
		}));
	}

	/**
	 * The active session's chat resource, but only once the session has actually
	 * been created. A draft new-session (welcome composer) also surfaces as the
	 * active session with an `activeChat`, so gating on {@link IActiveSession.isCreated}
	 * is what distinguishes a real session from the composer.
	 */
	private _createdActiveChatResource(): URI | undefined {
		const active = this.sessionsService.activeSession.get();
		return active?.isCreated.get() ? active.activeChat.get()?.resource : undefined;
	}

	/** The chat widget backing the currently active (created) session, if any. */
	private _activeSessionWidget() {
		const resource = this._createdActiveChatResource();
		return resource ? this.chatWidgetService.getWidgetBySessionResource(resource) : undefined;
	}

	/**
	 * The new-session composer to route voice input through, but only while no
	 * session has been created yet — once a real session exists, voice targets
	 * its chat widget instead.
	 */
	private _activeComposerTarget() {
		return this._createdActiveChatResource() ? undefined : this.newChatVoiceTargetService.activeComposer.get();
	}
}

registerWorkbenchContribution2(SessionsVoiceBridgeContribution.ID, SessionsVoiceBridgeContribution, WorkbenchPhase.AfterRestored);

/**
 * Context key mirror of `agentsVoice.contribution`'s per-widget
 * `agentsVoiceInitiatedHere` key. The shared voice actions (Stop, Disconnect,
 * Settings, Connecting) only appear in the chat widget whose scoped context has
 * this key set, and it is normally set by `startVoiceInChat` on
 * `IChatWidgetService.lastFocusedWidget`. In the Agents window DOM focus stays
 * on the sessions list, so `lastFocusedWidget` is unreliable and the post-connect
 * voice controls fail to appear. This contribution deterministically binds the
 * key to the active session's chat widget while voice is connected/connecting,
 * so the controls follow the session the user is viewing.
 */
class SessionsVoiceInitiatedContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.voiceInitiated';

	/** Matches `AGENTS_VOICE_INITIATED_HERE` in agentsVoice.contribution.ts. */
	private static readonly _INITIATED_HERE_KEY = 'agentsVoiceInitiatedHere';

	constructor(
		@IVoiceSessionController private readonly voiceSessionController: IVoiceSessionController,
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
	) {
		super();

		this._register(autorun(reader => {
			this.voiceSessionController.isConnected.read(reader);
			this.voiceSessionController.isConnecting.read(reader);
			const active = this.sessionsService.activeSession.read(reader);
			active?.isCreated.read(reader);
			active?.activeChat.read(reader);
			this._apply();
		}));
		// Widgets can be created after voice connects (opening a session slot).
		this._register(this.chatWidgetService.onDidAddWidget(() => this._apply()));
	}

	private _apply(): void {
		const voiceActive = this.voiceSessionController.isConnected.get() || this.voiceSessionController.isConnecting.get();
		// Only a created session has a chat widget; a draft new-session (welcome
		// composer) manages its own `agentsVoiceInitiatedHere` key instead.
		const active = this.sessionsService.activeSession.get();
		const activeResource = active?.isCreated.get() ? active.activeChat.get()?.resource : undefined;
		for (const widget of this.chatWidgetService.getAllWidgets()) {
			const widgetResource = widget.viewModel?.sessionResource;
			const isActiveWidget = voiceActive && !!activeResource && !!widgetResource && isEqual(widgetResource, activeResource);
			widget.scopedContextKeyService.createKey(SessionsVoiceInitiatedContribution._INITIATED_HERE_KEY, isActiveWidget);
		}
	}
}

registerWorkbenchContribution2(SessionsVoiceInitiatedContribution.ID, SessionsVoiceInitiatedContribution, WorkbenchPhase.AfterRestored);

/**
 * Keeps hands-free voice listening anchored to the session the user is dictating
 * into. When the active session changes while the microphone is listening, the
 * turn is only stopped if dictation is actually in progress (so it isn't
 * misrouted to the newly focused session); otherwise listening follows the user
 * into the new session. This mirrors the main-window `ChatViewPane` behavior
 * (see microsoft/vscode#325134), adapted to the Agents window's active-session
 * model.
 */
class SessionsVoiceListeningContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.voiceListening';

	constructor(
		@IVoiceSessionController voiceSessionController: IVoiceSessionController,
		@ISessionsService sessionsService: ISessionsService,
	) {
		super();

		let listeningSession: URI | undefined;
		this._register(autorun(reader => {
			const turns = voiceSessionController.transcriptTurns.read(reader);
			const connected = voiceSessionController.isConnected.read(reader);
			const voiceState = voiceSessionController.voiceState.read(reader);
			const targetSession = voiceSessionController.targetSession.read(reader);
			const activeSession = sessionsService.activeSession.read(reader);
			const currentSession = activeSession?.activeChat.read(reader)?.resource;

			if (!connected) {
				listeningSession = undefined;
				return;
			}

			if (voiceState !== 'listening') {
				// Allow the next dictation to re-capture the owning session.
				listeningSession = undefined;
				return;
			}

			if (!listeningSession) {
				listeningSession = targetSession ?? currentSession;
			} else if (!targetSession && currentSession && !isEqual(currentSession, listeningSession)) {
				// User switched to a different session while listening. Only stop
				// when there's dictation in progress, so it isn't misrouted to the
				// newly focused session. If nothing has been recorded yet, keep
				// listening and follow the new session.
				const activelyDictating = turns.some(t => t.speaker === 'user' && t.isPartial && t.text.trim().length > 0);
				if (activelyDictating) {
					voiceSessionController.stopListening();
					listeningSession = undefined;
				} else {
					listeningSession = currentSession;
				}
			}
		}));
	}
}

registerWorkbenchContribution2(SessionsVoiceListeningContribution.ID, SessionsVoiceListeningContribution, WorkbenchPhase.Eventually);
