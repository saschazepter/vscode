/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './mobileChatShell.css';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { $, append } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';

/**
 * Mobile top bar component — a simple DOM element prepended to the
 * workbench container on phone viewports. Replaces the desktop titlebar
 * with a native-feeling mobile app bar.
 *
 * Layout: [hamburger] [session title] [+ new]
 */
export class MobileTopBar extends Disposable {

	readonly element: HTMLElement;

	private readonly sessionTitleElement: HTMLElement;

	private readonly _onDidClickHamburger = this._register(new Emitter<void>());
	readonly onDidClickHamburger: Event<void> = this._onDidClickHamburger.event;

	private readonly _onDidClickNewSession = this._register(new Emitter<void>());
	readonly onDidClickNewSession: Event<void> = this._onDidClickNewSession.event;

	private readonly _onDidClickTitle = this._register(new Emitter<void>());
	readonly onDidClickTitle: Event<void> = this._onDidClickTitle.event;

	constructor(parent: HTMLElement) {
		super();

		this.element = document.createElement('div');
		this.element.className = 'mobile-top-bar';
		parent.prepend(this.element);

		// Hamburger button
		const hamburger = append(this.element, $('button.mobile-top-bar-button'));
		hamburger.setAttribute('aria-label', 'Open sessions');
		const hamburgerIcon = append(hamburger, $('span'));
		hamburgerIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.menu));
		hamburger.addEventListener('click', () => this._onDidClickHamburger.fire());

		// Session title
		this.sessionTitleElement = append(this.element, $('div.mobile-session-title'));
		this.sessionTitleElement.textContent = 'New Session';
		this.sessionTitleElement.addEventListener('click', () => this._onDidClickTitle.fire());

		// New session button (+)
		const newSession = append(this.element, $('button.mobile-top-bar-button'));
		newSession.setAttribute('aria-label', 'New session');
		const newSessionIcon = append(newSession, $('span'));
		newSessionIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.plus));
		newSession.addEventListener('click', () => this._onDidClickNewSession.fire());

		this._register({ dispose: () => this.element.remove() });
	}

	setTitle(title: string): void {
		this.sessionTitleElement.textContent = title;
	}
}
