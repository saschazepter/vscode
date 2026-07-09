/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IObservable, autorun, derived, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { HiddenItemStrategy, MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IMicCaptureService } from '../../../../workbench/contrib/chat/browser/voiceClient/micCaptureService.js';
import { ITtsPlaybackService } from '../../../../workbench/contrib/chat/browser/voiceClient/ttsPlaybackService.js';
import { IVoiceSessionController } from '../../../../workbench/contrib/chat/browser/voiceClient/voiceSessionController.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { setupVoiceInputDecorations } from './voiceInputDecorations.js';

/**
 * Stable resource that identifies the new-session composer as the voice backend's
 * target while no session exists yet. `_chat.voice.getCurrentSession` returns this
 * so the controller routes transcribed input through the composer (creating the
 * session) instead of falling back to a bare, unconfigured chat session.
 */
export const NEW_CHAT_VOICE_SENTINEL = URI.from({ scheme: 'sessions-voice', authority: 'new-chat', path: '/composer' });

/** The subset of the new-session composer that voice mode drives. */
export interface INewChatVoiceComposer {
	/** Fires when the composer input gains focus, so it becomes the active voice target. */
	readonly onDidFocus: Event<void>;
	/** Set the input to `text` and submit it, creating the session. */
	sendQuery(text: string): void;
	/** Set the input to `text` without submitting. */
	prefillInput(text: string): void;
	/** Focus the composer input. */
	focus(): void;
}

export const INewChatVoiceTargetService = createDecorator<INewChatVoiceTargetService>('newChatVoiceTargetService');

/**
 * Tracks the currently active new-session composer so the voice command bridge
 * can route transcribed input to it while no session exists yet.
 */
export interface INewChatVoiceTargetService {
	readonly _serviceBrand: undefined;
	/** The most recently focused/registered composer, if any is mounted. */
	readonly activeComposer: IObservable<INewChatVoiceComposer | undefined>;
	/** Register a composer as a potential voice target; disposing removes it. */
	registerComposer(composer: INewChatVoiceComposer): IDisposable;
	/** Promote `composer` to the active voice target (e.g. on focus). */
	setActive(composer: INewChatVoiceComposer): void;
}

export class NewChatVoiceTargetService extends Disposable implements INewChatVoiceTargetService {
	declare readonly _serviceBrand: undefined;

	private readonly _composers = new Set<INewChatVoiceComposer>();
	private readonly _activeComposer = observableValue<INewChatVoiceComposer | undefined>(this, undefined);
	readonly activeComposer: IObservable<INewChatVoiceComposer | undefined> = this._activeComposer;

	registerComposer(composer: INewChatVoiceComposer): IDisposable {
		this._composers.add(composer);
		this._activeComposer.set(composer, undefined);
		return toDisposable(() => {
			this._composers.delete(composer);
			if (this._activeComposer.get() === composer) {
				// Fall back to any remaining composer (last inserted), else none.
				const remaining = [...this._composers];
				this._activeComposer.set(remaining.length ? remaining[remaining.length - 1] : undefined, undefined);
			}
		});
	}

	setActive(composer: INewChatVoiceComposer): void {
		if (this._composers.has(composer)) {
			this._activeComposer.set(composer, undefined);
		}
	}
}

registerSingleton(INewChatVoiceTargetService, NewChatVoiceTargetService, InstantiationType.Delayed);

// --- Voice toolbar menu for the new-session composer ---
// The composer uses a hand-built toolbar (not the standard ChatWidget), so the
// shared voice actions registered against `MenuId.ChatExecute` never appear here.
// Re-surface the same commands in a dedicated menu whose visibility is driven by
// the global voice state keys plus the composer-scoped `agentsVoiceInitiatedHere`.

export const SessionsNewChatVoiceMenu = new MenuId('SessionsNewChatVoiceMenu');

const WHEN_VOICE_ENABLED = ContextKeyExpr.equals('config.agents.voice.enabled', true);
const WHEN_CONNECTING = ContextKeyExpr.equals('agentsVoiceConnecting', true);
const WHEN_LISTENING = ContextKeyExpr.equals('agentsVoiceListening', true);
const WHEN_CONNECTED = ContextKeyExpr.equals('agentsVoiceConnected', true);
const WHEN_INITIATED_HERE = ContextKeyExpr.equals('agentsVoiceInitiatedHere', true);
const WHEN_VOICE_SURFACE = ContextKeyExpr.equals('newChatVoiceSurface', true);

MenuRegistry.appendMenuItem(SessionsNewChatVoiceMenu, {
	command: { id: 'agentsVoice.connecting', title: localize('agentsVoice.connecting', "Connecting..."), icon: Codicon.loading },
	when: ContextKeyExpr.and(WHEN_VOICE_ENABLED, WHEN_CONNECTING, WHEN_INITIATED_HERE),
	group: 'navigation',
	order: -10,
});

MenuRegistry.appendMenuItem(SessionsNewChatVoiceMenu, {
	command: { id: 'agentsVoice.startVoiceInChat', title: localize('agentsVoice.startVoiceInChat', "Voice Mode"), icon: Codicon.voiceMode },
	when: ContextKeyExpr.and(WHEN_VOICE_ENABLED, WHEN_VOICE_SURFACE, WHEN_LISTENING.negate(), WHEN_CONNECTING.negate()),
	group: 'navigation',
	order: -10,
});

MenuRegistry.appendMenuItem(SessionsNewChatVoiceMenu, {
	command: { id: 'agentsVoice.pttStopInChat', title: localize('agentsVoice.pttStopInChat', "Voice Mode: Stop Recording"), icon: Codicon.voiceMode },
	when: ContextKeyExpr.and(WHEN_VOICE_ENABLED, WHEN_LISTENING, WHEN_INITIATED_HERE),
	group: 'navigation',
	order: -10,
});

MenuRegistry.appendMenuItem(SessionsNewChatVoiceMenu, {
	command: { id: 'agentsVoice.openSettings', title: localize('agentsVoice.openSettings', "Voice Mode Settings"), icon: Codicon.settingsGear },
	when: ContextKeyExpr.and(WHEN_VOICE_ENABLED, WHEN_CONNECTED, WHEN_INITIATED_HERE),
	group: 'navigation',
	order: -9.5,
});

MenuRegistry.appendMenuItem(SessionsNewChatVoiceMenu, {
	command: { id: 'agentsVoice.disconnect', title: localize('agentsVoice.disconnect', "Disconnect Voice Mode"), icon: Codicon.debugDisconnect },
	when: ContextKeyExpr.and(WHEN_VOICE_ENABLED, WHEN_CONNECTED, WHEN_INITIATED_HERE),
	group: 'navigation',
	order: -9,
});

export interface INewChatVoiceControllerOptions {
	/** Container the voice toolbar (mic/stop/settings/disconnect) is appended to. */
	readonly toolbarContainer: HTMLElement;
	/** Input container that receives the audio-reactive glow + transcript overlay. */
	readonly inputContainer: HTMLElement;
	/** The composer voice drives. */
	readonly composer: INewChatVoiceComposer;
}

/**
 * Wires voice mode into a new-session composer: renders the voice toolbar,
 * binds the composer-scoped `agentsVoiceInitiatedHere` key while the composer is
 * the voice target, sets up the input glow/transcript, and registers the
 * composer with {@link INewChatVoiceTargetService} for command-bridge routing.
 */
export class NewChatVoiceController extends Disposable {

	constructor(
		options: INewChatVoiceControllerOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@INewChatVoiceTargetService targetService: INewChatVoiceTargetService,
		@IVoiceSessionController voiceSessionController: IVoiceSessionController,
		@ISessionsService sessionsService: ISessionsService,
		@ITtsPlaybackService ttsPlaybackService: ITtsPlaybackService,
		@IMicCaptureService micCaptureService: IMicCaptureService,
		@IConfigurationService configurationService: IConfigurationService,
		@IKeybindingService keybindingService: IKeybindingService,
	) {
		super();

		this._register(targetService.registerComposer(options.composer));
		this._register(options.composer.onDidFocus(() => targetService.setActive(options.composer)));

		// Scoped context so the voice toolbar's gating is local to this composer
		// and does not leak to other surfaces.
		const scopedContextKeyService = this._register(contextKeyService.createScoped(options.toolbarContainer));
		// True while this composer is a valid voice surface (mounted, focused, and
		// no real session created yet). Drives whether the mic button appears.
		const voiceSurfaceKey = scopedContextKeyService.createKey<boolean>('newChatVoiceSurface', false);
		// True while voice is active *and* this composer is the surface — gates the
		// post-connect Stop/Disconnect/Settings controls, mirroring the chat widget.
		const initiatedHereKey = scopedContextKeyService.createKey<boolean>('agentsVoiceInitiatedHere', false);
		const scopedInstantiationService = this._register(instantiationService.createChild(new ServiceCollection([IContextKeyService, scopedContextKeyService])));

		this._register(scopedInstantiationService.createInstance(MenuWorkbenchToolBar, options.toolbarContainer, SessionsNewChatVoiceMenu, {
			hiddenItemStrategy: HiddenItemStrategy.NoHide,
		}));

		// This composer is the voice surface while it is the active composer and no
		// session has been created yet (the welcome/new-session screen). A draft
		// new-session still surfaces as `activeSession` with an `activeChat`, so we
		// must gate on `isCreated`, not merely on the presence of an active chat.
		const isVoiceSurface = derived(reader => {
			const active = sessionsService.activeSession.read(reader);
			const hasCreatedSession = !!active && active.isCreated.read(reader);
			const isActiveComposer = targetService.activeComposer.read(reader) === options.composer;
			return !hasCreatedSession && isActiveComposer;
		});
		const isVoiceTarget = derived(reader => {
			const voiceActive = voiceSessionController.isConnected.read(reader) || voiceSessionController.isConnecting.read(reader);
			return voiceActive && isVoiceSurface.read(reader);
		});
		this._register(autorun(reader => {
			voiceSurfaceKey.set(isVoiceSurface.read(reader));
			initiatedHereKey.set(isVoiceTarget.read(reader));
		}));

		this._register(setupVoiceInputDecorations({
			voiceSessionController,
			ttsPlaybackService,
			micCaptureService,
			configurationService,
			keybindingService,
		}, {
			inputContainer: options.inputContainer,
			isActive: isVoiceTarget,
			getCurrentResource: () => NEW_CHAT_VOICE_SENTINEL,
		}));
	}
}
