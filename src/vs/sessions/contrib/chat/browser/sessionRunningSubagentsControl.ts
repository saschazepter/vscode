/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IReader } from '../../../../base/common/observable.js';
import { isEqual } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';
import { ChatOriginKind, IChat, SessionStatus } from '../../../services/sessions/common/session.js';
import './media/sessionRunningSubagentsControl.css';

/** Max characters of a subagent's current-step text before it is ellipsized. */
const STEP_MAX_LENGTH = 48;

interface IRunningSubagent {
	readonly chat: IChat;
	/** True when the subagent is blocked waiting for the user (needs attention). */
	readonly needsAttention: boolean;
	/** Short "current step" text (the subagent's live status description), if any. */
	readonly step: string | undefined;
}

/**
 * An ephemeral status chip shown above the chat input while the currently-viewed
 * chat has **running** (or attention-needing) subagents. It gives an at-a-glance
 * count of in-flight background workers and escalates to an attention state when
 * any is blocked waiting for the user. Activating it opens a menu of those
 * subagents; selecting one reveals its read-only chat. The chip hides entirely
 * when no subagent is running, so it adds no chrome while idle.
 */
export class SessionRunningSubagentsControl extends Disposable {

	readonly element: HTMLElement;
	private readonly _button: Button;

	private readonly _disposables = this._register(new MutableDisposable<DisposableStore>());
	private _session: IActiveSession | undefined;
	private _subagents: readonly IRunningSubagent[] = [];

	constructor(
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super();
		this.element = $('.session-running-subagents');
		this._button = this._register(new Button(this.element, { secondary: true, supportIcons: true, ...defaultButtonStyles }));
		this._button.element.classList.add('session-running-subagents-button');
		this._register(this._button.onDidClick(() => this._showMenu()));
		this._setVisible(false);
	}

	/** Track the currently-viewed chat; the chip monitors its running subagents. */
	setChat(chatResource: URI | undefined): void {
		const store = new DisposableStore();
		this._disposables.value = store;

		if (!chatResource) {
			this._update(undefined, []);
			return;
		}

		store.add(autorun(reader => {
			const session = this._findOwningSession(chatResource, reader);
			const subagents = session ? this._collectRunningSubagents(session, chatResource, reader) : [];
			this._update(session, subagents);
		}));
	}

	private _findOwningSession(chatResource: URI, reader: IReader): IActiveSession | undefined {
		for (const session of this.sessionsService.visibleSessions.read(reader)) {
			if (session?.chats.read(reader).some(c => isEqual(c.resource, chatResource))) {
				return session;
			}
		}
		const active = this.sessionsService.activeSession.read(reader);
		return active?.chats.read(reader).some(c => isEqual(c.resource, chatResource)) ? active : undefined;
	}

	private _collectRunningSubagents(session: IActiveSession, chatResource: URI, reader: IReader): IRunningSubagent[] {
		return session.chats.read(reader)
			.filter(c =>
				c.origin?.kind === ChatOriginKind.Tool &&
				!!c.origin.parentChat &&
				isEqual(c.origin.parentChat, chatResource))
			.map(chat => {
				const status = chat.status.read(reader);
				return { chat, status };
			})
			.filter(({ status }) => status === SessionStatus.InProgress || status === SessionStatus.NeedsInput)
			.map(({ chat, status }) => ({
				chat,
				needsAttention: status === SessionStatus.NeedsInput,
				step: this._stepText(chat, reader),
			}))
			// Surface attention-needing workers first: a blocked subagent stalls
			// the whole background batch and is the thing the user must act on.
			.sort((a, b) => (a.needsAttention === b.needsAttention) ? 0 : a.needsAttention ? -1 : 1);
	}

	private _stepText(chat: IChat, reader: IReader): string | undefined {
		const description = chat.description.read(reader)?.value.trim();
		if (!description) {
			return undefined;
		}
		return description.length > STEP_MAX_LENGTH ? `${description.slice(0, STEP_MAX_LENGTH - 1)}\u2026` : description;
	}

	private _update(session: IActiveSession | undefined, subagents: readonly IRunningSubagent[]): void {
		this._session = session;
		this._subagents = subagents;

		const count = subagents.length;
		const attentionCount = subagents.filter(s => s.needsAttention).length;
		this.element.classList.toggle('needs-attention', attentionCount > 0);
		if (attentionCount > 0) {
			this._button.label = `$(${Codicon.warning.id}) ${localize('runningSubagents.attention', "{0} need attention", attentionCount)}`;
		} else {
			this._button.label = `$(${Codicon.loading.id}~spin) ${localize('runningSubagents.running', "{0} running", count)}`;
		}
		this._setVisible(count > 0);
	}

	private _showMenu(): void {
		const session = this._session;
		if (!session || this._subagents.length === 0) {
			return;
		}
		const actions = this._subagents.map(({ chat, needsAttention, step }) => {
			const title = chat.title.get() || localize('runningSubagents.untitled', "Subagent");
			const label = needsAttention
				? localize('runningSubagents.itemAttention', "{0} (needs attention)", title)
				: (step ? `${title} \u2014 ${step}` : title);
			return toAction({
				id: `runningSubagents.open.${chat.resource.toString()}`,
				label,
				class: ThemeIcon.asClassName(needsAttention ? Codicon.warning : Codicon.loading),
				run: () => this.sessionsService.openChat(session, chat.resource),
			});
		});
		this.contextMenuService.showContextMenu({
			getAnchor: () => this._button.element,
			getActions: () => actions,
		});
	}

	private _setVisible(visible: boolean): void {
		this.element.classList.toggle('hidden', !visible);
	}
}
