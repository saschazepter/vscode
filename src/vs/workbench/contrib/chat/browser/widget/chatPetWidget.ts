/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatPet.css';
import * as dom from '../../../../../base/browser/dom.js';
import { IHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegate.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { autorun, IObservable, observableFromEvent, observableValue } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import product from '../../../../../platform/product/common/product.js';
import { IChatModel } from '../../common/model/chatModel.js';
import { IChatPetService } from '../chatPetService.js';

export type ChatPetState = 'idle' | 'sleep' | 'processing' | 'complete' | 'love' | 'clapping';

const IDLE_SLEEP_DELAY = 60_000;
const TRANSIENT_STATE_DURATION = 2_000;

export function getChatPetBuddyName(quality: string | undefined): 'buddy-idle-stable' | 'buddy-idle-insiders' {
	return quality === 'stable' ? 'buddy-idle-stable' : 'buddy-idle-insiders';
}

const buddyName = getChatPetBuddyName(product.quality);
const buddySources = createSpriteSources(buddyName);
const spriteSources: Record<ChatPetState, { animated: string; reducedMotion: string }> = {
	idle: buddySources,
	sleep: buddySources,
	processing: buddySources,
	complete: buddySources,
	love: buddySources,
	clapping: buddySources,
};

function createSpriteSources(name: string): { animated: string; reducedMotion: string } {
	const root = 'vs/workbench/contrib/chat/browser/widget/media/chatPet';
	return {
		animated: FileAccess.asBrowserUri(`${root}/${name}-96.gif`).toString(true),
		reducedMotion: FileAccess.asBrowserUri(`${root}/${name}-96.png`).toString(true),
	};
}

export function getChatPetBaseState(hasActiveRequest: boolean, needsInput: boolean, idleExpired: boolean): ChatPetState {
	if (needsInput) {
		return 'clapping';
	}
	if (hasActiveRequest) {
		return 'processing';
	}
	return idleExpired ? 'sleep' : 'idle';
}

export class ChatPetWidget extends Disposable {

	private readonly _button: HTMLButtonElement;
	private readonly _image: HTMLImageElement;
	private readonly _idleExpired = observableValue(this, false);
	private readonly _transientState = observableValue<ChatPetState | undefined>(this, undefined);
	private readonly _idleScheduler = this._register(new RunOnceScheduler(() => this._idleExpired.set(true, undefined), IDLE_SLEEP_DELAY));
	private readonly _transientScheduler = this._register(new RunOnceScheduler(() => this._transientState.set(undefined, undefined), TRANSIENT_STATE_DURATION));
	private _currentState: ChatPetState = 'idle';
	private _motionReduced = false;
	private _enabled = false;
	private _enablementInitialized = false;

	constructor(
		parent: HTMLElement,
		model: IObservable<IChatModel | undefined>,
		@IChatPetService private readonly chatPetService: IChatPetService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
		@IHoverService hoverService: IHoverService,
	) {
		super();

		parent.classList.add('chat-pet-host');
		this._button = dom.append(parent, dom.$('button.chat-pet-button')) as HTMLButtonElement;
		this._button.type = 'button';
		this._button.setAttribute('aria-label', localize('chatPet.love', "Show the VS Code pet some love!"));
		this._image = dom.append(this._button, dom.$('img.chat-pet-sprite')) as HTMLImageElement;
		this._image.alt = '';
		this._image.setAttribute('aria-hidden', 'true');
		this._register(dom.addDisposableListener(this._button, dom.EventType.ANIMATION_END, event => {
			if (event.animationName === 'chat-pet-exit' && !this._enabled) {
				this._finishDisable();
			}
		}));

		const defaultHoverDelegate = getDefaultHoverDelegate('element');
		const hoverDelegate: IHoverDelegate = {
			get delay() { return defaultHoverDelegate.delay; },
			showHover: (options, focus) => hoverService.showInstantHover({
				...options,
				position: {
					...options.position,
					hoverPosition: HoverPosition.ABOVE,
				},
			}, focus),
		};
		const managedHover = this._register(hoverService.setupManagedHover(
			hoverDelegate,
			this._button,
			localize('chatPet.hover', "Show the VS Code pet some love! Stay tuned for more interactions..."),
		));

		this._register(dom.addDisposableListener(this._button, dom.EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this._showTransientState('love');
			managedHover.show();
			status(localize('chatPet.loved', "The VS Code pet feels loved"));
		}));

		const motionReduced = observableFromEvent(this, this.accessibilityService.onDidChangeReducedMotion, () => this.accessibilityService.isMotionReduced());
		this._register(autorun(reader => {
			this._motionReduced = motionReduced.read(reader);
			const enabled = this.chatPetService.enabled.read(reader);
			const chatModel = model.read(reader);
			const request = chatModel?.lastRequestObs.read(reader);
			const needsInput = !!request?.response?.isPendingConfirmation.read(reader);
			const hasActiveRequest = chatModel?.hasActiveRequest.read(reader) ?? false;
			const idleExpired = this._idleExpired.read(reader);
			const transientState = this._transientState.read(reader);

			if (!this._enablementInitialized || enabled !== this._enabled) {
				const wasInitialized = this._enablementInitialized;
				this._enablementInitialized = true;
				this._enabled = enabled;
				if (enabled) {
					this._startEnableAnimation();
				} else if (wasInitialized) {
					this._startDisableAnimation();
				} else {
					this._finishDisable();
				}
			}

			if (!enabled) {
				this._idleScheduler.cancel();
				this._transientScheduler.cancel();
				if (this._motionReduced) {
					this._finishDisable();
				}
				return;
			}

			if (hasActiveRequest || needsInput) {
				this._idleScheduler.cancel();
				if (idleExpired) {
					this._idleExpired.set(false, undefined);
				}
			} else if (!idleExpired && !this._idleScheduler.isScheduled()) {
				this._idleScheduler.schedule();
			}

			this._renderState(transientState ?? getChatPetBaseState(hasActiveRequest, needsInput, idleExpired));
		}));

		this._register(autorun(reader => {
			const chatModel = model.read(reader);
			if (!chatModel) {
				return;
			}
			reader.store.add(chatModel.onDidChange(e => {
				if (e.kind === 'completedRequest' && !e.request.response?.isCanceled) {
					this._showTransientState('complete');
				}
			}));
		}));
	}

	private _startEnableAnimation(): void {
		this._button.classList.remove('hidden', 'exiting', 'entering');
		this._button.tabIndex = 0;
		this._button.getBoundingClientRect();
		if (!this._motionReduced) {
			this._button.classList.add('entering');
		}
	}

	private _startDisableAnimation(): void {
		this._button.tabIndex = -1;
		this._button.classList.remove('entering');
		if (this._motionReduced || this._button.classList.contains('hidden')) {
			this._finishDisable();
			return;
		}
		this._button.classList.add('exiting');
	}

	private _finishDisable(): void {
		this._button.classList.remove('entering', 'exiting');
		this._button.classList.add('hidden');
		this._image.removeAttribute('src');
	}

	private _showTransientState(state: ChatPetState): void {
		if (!this.chatPetService.enabled.get()) {
			return;
		}

		this._idleExpired.set(false, undefined);
		this._idleScheduler.schedule();
		this._transientState.set(state, undefined);
		this._transientScheduler.schedule();
		this._renderState(state, true);
	}

	private _renderState(state: ChatPetState, restart = false): void {
		const source = this._motionReduced ? spriteSources[state].reducedMotion : spriteSources[state].animated;
		if (restart || this._currentState !== state || this._image.src !== source) {
			if (restart) {
				this._image.removeAttribute('src');
			}
			this._image.src = source;
		}
		this._currentState = state;
		this._button.dataset.state = state;
	}
}
