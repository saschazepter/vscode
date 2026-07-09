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
			const widget = this._activeSessionWidget() ?? this.chatWidgetService.lastFocusedWidget;
			if (text && widget?.viewModel) {
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
		// Agents window the shown session is the active session.
		this._commandDisposables.add(CommandsRegistry.registerCommand('_chat.voice.getCurrentSession', (): string | undefined => {
			const activeChat = this.sessionsService.activeSession.get()?.activeChat.get()?.resource;
			if (activeChat) {
				return activeChat.toString();
			}
			return this.chatWidgetService.lastFocusedWidget?.viewModel?.sessionResource?.toString();
		}));

		// Activate the session that owns the given chat resource so its response
		// becomes visible to the user.
		this._commandDisposables.add(CommandsRegistry.registerCommand('_chat.voice.switchToSession', async (_accessor, resourceStr: string): Promise<boolean> => {
			if (!resourceStr) {
				return false;
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

	/** The chat widget backing the currently active session, if any. */
	private _activeSessionWidget() {
		const resource = this.sessionsService.activeSession.get()?.activeChat.get()?.resource;
		return resource ? this.chatWidgetService.getWidgetBySessionResource(resource) : undefined;
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
			this.sessionsService.activeSession.read(reader)?.activeChat.read(reader);
			this._apply();
		}));
		// Widgets can be created after voice connects (opening a session slot).
		this._register(this.chatWidgetService.onDidAddWidget(() => this._apply()));
	}

	private _apply(): void {
		const voiceActive = this.voiceSessionController.isConnected.get() || this.voiceSessionController.isConnecting.get();
		const activeResource = this.sessionsService.activeSession.get()?.activeChat.get()?.resource;
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
