/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IObservable, observableValue, transaction } from '../../../base/common/observable.js';
import { AgentSessionProviders, resolveAgentSessionProviderName } from '../../../workbench/contrib/chat/browser/agentSessions/agentSessions.js';
import { IChatSessionsService } from '../../../workbench/contrib/chat/common/chatSessionsService.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';

/**
 * Configuration for which agent session targets are available and which is selected.
 * This is the core abstraction that replaces the delegate-based target selection pattern.
 *
 * Targets can be restricted at creation time and modified at runtime.
	 * The selected target is tracked independently of any session - no session is created
 * until the consumer explicitly requests one (typically on send).
 */
export interface IAgentChatTargetConfig {
	/**
	 * Observable set of currently allowed targets.
	 */
	readonly allowedTargets: IObservable<ReadonlySet<AgentSessionProviders>>;

	/**
	 * The currently selected target. May be `undefined` if no target has been selected yet.
	 */
	readonly selectedTarget: IObservable<AgentSessionProviders | undefined>;

	/**
	 * Event that fires when the selected target changes.
	 */
	readonly onDidChangeSelectedTarget: Event<AgentSessionProviders | undefined>;

	/**
	 * Event that fires when the set of allowed targets changes.
	 */
	readonly onDidChangeAllowedTargets: Event<ReadonlySet<AgentSessionProviders>>;

	/**
	 * Change the selected target. The target must be in the allowed set.
	 * @throws if the target is not in the allowed set
	 */
	setSelectedTarget(target: AgentSessionProviders): void;

	/**
	 * Add a target to the allowed set at runtime.
	 * If this is the first target added, it becomes the selected target.
	 */
	addAllowedTarget(target: AgentSessionProviders): void;

	/**
	 * Remove a target from the allowed set at runtime.
	 * If the removed target was the selected target, the selection resets to the first allowed target.
	 */
	removeAllowedTarget(target: AgentSessionProviders): void;

	/**
	 * Replace the entire allowed set.
	 * If the current selected target is not in the new set, it resets to the first allowed target.
	 */
	setAllowedTargets(targets: AgentSessionProviders[]): void;

	/**
	 * Get the display name for a provider, respecting any name overrides.
	 * Falls back to `getAgentSessionProviderName` when no override is set.
	 */
	getProviderName(provider: AgentSessionProviders, agentSessionsDedicatedWindow?: boolean): string;
}

export interface IAgentChatTargetConfigOptions {
	/**
	 * Initial set of allowed targets.
	 */
	allowedTargets: AgentSessionProviders[];

	/**
	 * Default selected target. If not provided, defaults to the first allowed target.
	 */
	defaultTarget?: AgentSessionProviders;

	/**
	 * Optional display name overrides for specific providers.
	 * Keys are provider types, values are the custom display names.
	 */
	providerNameOverrides?: Partial<Record<AgentSessionProviders, string>>;
}

export class AgentSessionsChatTargetConfig extends Disposable implements IAgentChatTargetConfig {

	private readonly _providerNameOverrides: Map<AgentSessionProviders, string>;

	private readonly _allowedTargets = observableValue<ReadonlySet<AgentSessionProviders>>('allowedTargets', new Set());
	readonly allowedTargets: IObservable<ReadonlySet<AgentSessionProviders>> = this._allowedTargets;

	private readonly _selectedTarget = observableValue<AgentSessionProviders | undefined>('selectedTarget', undefined);
	readonly selectedTarget: IObservable<AgentSessionProviders | undefined> = this._selectedTarget;

	private readonly _onDidChangeSelectedTarget = this._register(new Emitter<AgentSessionProviders | undefined>());
	readonly onDidChangeSelectedTarget: Event<AgentSessionProviders | undefined> = this._onDidChangeSelectedTarget.event;

	private readonly _onDidChangeAllowedTargets = this._register(new Emitter<ReadonlySet<AgentSessionProviders>>());
	readonly onDidChangeAllowedTargets: Event<ReadonlySet<AgentSessionProviders>> = this._onDidChangeAllowedTargets.event;

	constructor(
		options: IAgentChatTargetConfigOptions,
		private readonly _chatSessionsService: IChatSessionsService,
	) {
		super();

		this._providerNameOverrides = new Map(
			Object.entries(options.providerNameOverrides ?? {}) as [AgentSessionProviders, string][]
		);

		// Propagate local overrides to the service so that all consumers
		// (e.g. ChatInputPart) see the same names via resolveAgentSessionProviderName.
		for (const [provider, name] of this._providerNameOverrides) {
			this._chatSessionsService.setProviderNameOverride(provider, name);
		}

		const initialSet = new Set(options.allowedTargets);
		this._allowedTargets.set(initialSet, undefined);

		const defaultTarget = options.defaultTarget && initialSet.has(options.defaultTarget)
			? options.defaultTarget
			: this._firstAllowed(initialSet);
		this._selectedTarget.set(defaultTarget, undefined);
	}

	setSelectedTarget(target: AgentSessionProviders): void {
		const allowed = this._allowedTargets.get();
		if (!allowed.has(target)) {
			throw new Error(`Target "${target}" is not in the allowed set`);
		}

		const previous = this._selectedTarget.get();
		if (previous !== target) {
			this._selectedTarget.set(target, undefined);
			this._onDidChangeSelectedTarget.fire(target);
		}
	}

	addAllowedTarget(target: AgentSessionProviders): void {
		const current = this._allowedTargets.get();
		if (current.has(target)) {
			return;
		}

		const updated = new Set(current);
		updated.add(target);

		transaction(tx => {
			this._allowedTargets.set(updated, tx);

			// If no target was selected, select the newly added one
			if (this._selectedTarget.get() === undefined) {
				this._selectedTarget.set(target, tx);
				this._onDidChangeSelectedTarget.fire(target);
			}
		});

		this._onDidChangeAllowedTargets.fire(updated);
	}

	removeAllowedTarget(target: AgentSessionProviders): void {
		const current = this._allowedTargets.get();
		if (!current.has(target)) {
			return;
		}

		const updated = new Set(current);
		updated.delete(target);

		transaction(tx => {
			this._allowedTargets.set(updated, tx);

			// If the removed target was selected, reset to first allowed
			if (this._selectedTarget.get() === target) {
				const newSelected = this._firstAllowed(updated);
				this._selectedTarget.set(newSelected, tx);
				this._onDidChangeSelectedTarget.fire(newSelected);
			}
		});

		this._onDidChangeAllowedTargets.fire(updated);
	}

	setAllowedTargets(targets: AgentSessionProviders[]): void {
		const updated = new Set(targets);

		transaction(tx => {
			this._allowedTargets.set(updated, tx);

			const currentSelected = this._selectedTarget.get();
			if (currentSelected === undefined || !updated.has(currentSelected)) {
				const newSelected = this._firstAllowed(updated);
				this._selectedTarget.set(newSelected, tx);
				this._onDidChangeSelectedTarget.fire(newSelected);
			}
		});

		this._onDidChangeAllowedTargets.fire(updated);
	}

	getProviderName(provider: AgentSessionProviders, agentSessionsDedicatedWindow?: boolean): string {
		return this._providerNameOverrides.get(provider) ?? resolveAgentSessionProviderName(this._chatSessionsService, provider, agentSessionsDedicatedWindow);
	}

	override dispose(): void {
		// Clear service-level overrides that were set by this instance
		for (const [provider] of this._providerNameOverrides) {
			this._chatSessionsService.setProviderNameOverride(provider, undefined);
		}
		super.dispose();
	}

	private _firstAllowed(set: ReadonlySet<AgentSessionProviders>): AgentSessionProviders | undefined {
		for (const target of set) {
			return target;
		}
		return undefined;
	}
}
