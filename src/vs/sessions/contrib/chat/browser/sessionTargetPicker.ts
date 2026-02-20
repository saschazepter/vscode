/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Radio } from '../../../../base/browser/ui/radio/radio.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AgentSessionProviders } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';

/**
 * A self-contained widget for selecting the session target (Folder vs Cloud).
 * Encapsulates state, events, and rendering. Can be placed anywhere in the view.
 */
export class SessionTargetPicker extends Disposable {

	private _selectedTarget: AgentSessionProviders;
	private _allowedTargets: AgentSessionProviders[];

	private readonly _onDidChangeTarget = this._register(new Emitter<AgentSessionProviders>());
	readonly onDidChangeTarget: Event<AgentSessionProviders> = this._onDidChangeTarget.event;

	private readonly _renderDisposables = this._register(new DisposableStore());
	private _container: HTMLElement | undefined;

	get selectedTarget(): AgentSessionProviders {
		return this._selectedTarget;
	}

	constructor(
		allowedTargets: AgentSessionProviders[],
		defaultTarget: AgentSessionProviders,
	) {
		super();
		this._allowedTargets = allowedTargets;
		this._selectedTarget = allowedTargets.includes(defaultTarget)
			? defaultTarget
			: allowedTargets[0];
	}

	/**
	 * Renders the target radio (Folder / Cloud) into the given container.
	 */
	render(container: HTMLElement): void {
		this._container = container;
		this._renderRadio();
	}

	updateAllowedTargets(targets: AgentSessionProviders[]): void {
		this._allowedTargets = targets;
		if (!targets.includes(this._selectedTarget)) {
			this._selectedTarget = targets[0];
			this._onDidChangeTarget.fire(this._selectedTarget);
		}
		if (this._container) {
			this._renderRadio();
		}
	}

	private _renderRadio(): void {
		if (!this._container) {
			return;
		}

		this._renderDisposables.clear();
		dom.clearNode(this._container);

		if (this._allowedTargets.length === 0) {
			return;
		}

		const targets = [AgentSessionProviders.Background, AgentSessionProviders.Cloud].filter(t => this._allowedTargets.includes(t));
		const activeIndex = targets.indexOf(this._selectedTarget);

		const radio = new Radio({
			items: targets.map(target => ({
				text: getTargetLabel(target),
				isActive: target === this._selectedTarget,
			})),
		});
		this._renderDisposables.add(radio);
		this._container.appendChild(radio.domNode);

		if (activeIndex >= 0) {
			radio.setActiveItem(activeIndex);
		}

		this._renderDisposables.add(radio.onDidSelect(index => {
			const target = targets[index];
			if (this._selectedTarget !== target) {
				this._selectedTarget = target;
				this._onDidChangeTarget.fire(target);
			}
		}));
	}
}

function getTargetLabel(provider: AgentSessionProviders): string {
	switch (provider) {
		case AgentSessionProviders.Local:
		case AgentSessionProviders.Background:
			return localize('chat.session.providerLabel.folder', "Folder");
		case AgentSessionProviders.Cloud:
			return localize('chat.session.providerLabel.cloud', "Cloud");
		case AgentSessionProviders.Claude:
			return 'Claude';
		case AgentSessionProviders.Codex:
			return 'Codex';
		case AgentSessionProviders.Growth:
			return 'Growth';
	}
}
