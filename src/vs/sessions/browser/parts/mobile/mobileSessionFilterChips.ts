/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/mobileSessionFilterChips.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Gesture, EventType as TouchEventType } from '../../../../base/browser/touch.js';
import { EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { SessionStatus } from '../../../services/sessions/common/session.js';

const $ = DOM.$;

/**
 * Chip definition for a status filter in the mobile session list.
 */
interface IFilterChipDef {
	readonly label: string;
	/** Status values that this chip toggles (e.g., "In Progress" covers both InProgress and NeedsInput). */
	readonly statuses: readonly SessionStatus[];
}

/**
 * Callback interface for driving the filter state from chips.
 * This mirrors the filter API on {@link ISessionsList} so the chip widget
 * doesn't depend on the tree control directly.
 */
export interface IMobileSessionFilterChipHost {
	isStatusExcluded(status: SessionStatus): boolean;
	setStatusExcluded(status: SessionStatus, excluded: boolean): void;
	readonly onDidUpdate: Event<void>;
}

/**
 * The event fired when the user taps the "Sort & Filter" chip,
 * signaling the view to open the full filter surface.
 */
export type MobileFilterChipSortFilterEvent = void;

/**
 * Horizontally scrollable chip row for quick session status filtering on
 * phone-sized viewports. Shows three fixed status chips and a trailing
 * "Sort & Filter" chip that delegates to the host for the full filter
 * bottom sheet.
 *
 * Architecture note: this widget is phone-only and created conditionally
 * in {@link SessionsView}. It does NOT branch on IsPhoneLayoutContext
 * internally — the conditional instantiation happens at the call site.
 */
export class MobileSessionFilterChips extends Disposable {

	private readonly container: HTMLElement;
	private readonly chipElements = new Map<string, HTMLElement>();
	private readonly chipDisposables = this._register(new DisposableStore());

	private readonly _onDidRequestSortFilter = this._register(new Emitter<MobileFilterChipSortFilterEvent>());
	/**
	 * Fired when the user taps the "Sort & Filter" chip.
	 * The host should open a bottom sheet / quick pick with the full filter
	 * and sort surface.
	 */
	readonly onDidRequestSortFilter: Event<MobileFilterChipSortFilterEvent> = this._onDidRequestSortFilter.event;

	private static readonly CHIP_DEFS: readonly IFilterChipDef[] = [
		{
			label: localize('chipCompleted', "Completed"),
			statuses: [SessionStatus.Completed],
		},
		{
			label: localize('chipInProgress', "In Progress"),
			statuses: [SessionStatus.InProgress, SessionStatus.NeedsInput],
		},
		{
			label: localize('chipFailed', "Failed"),
			statuses: [SessionStatus.Error],
		},
	];

	constructor(
		parent: HTMLElement,
		private readonly host: IMobileSessionFilterChipHost,
	) {
		super();

		this.container = DOM.append(parent, $('.mobile-session-filter-chips'));
		this.container.setAttribute('role', 'toolbar');
		this.container.setAttribute('aria-label', localize('filterChipsLabel', "Session status filters"));

		this.renderChips();

		// Re-sync active state when the list updates (filters may have
		// changed via the full filter menu or programmatic reset).
		this._register(this.host.onDidUpdate(() => this.syncActiveStates()));
	}

	private renderChips(): void {
		this.chipDisposables.clear();
		this.chipElements.clear();
		DOM.clearNode(this.container);

		for (const def of MobileSessionFilterChips.CHIP_DEFS) {
			this.createStatusChip(def);
		}

		this.createSortFilterChip();
		this.syncActiveStates();
	}

	private createStatusChip(def: IFilterChipDef): void {
		const chip = DOM.append(this.container, $('.mobile-session-filter-chip'));
		chip.setAttribute('role', 'button');
		chip.setAttribute('tabindex', '0');
		chip.setAttribute('aria-pressed', 'false');

		const label = DOM.append(chip, $('span.chip-label'));
		label.textContent = def.label;

		this.chipElements.set(def.label, chip);

		// Touch + click handling (iOS requires both per sessions instructions)
		this.chipDisposables.add(Gesture.addTarget(chip));
		this.chipDisposables.add(DOM.addDisposableListener(chip, EventType.CLICK, (e) => {
			e.preventDefault();
			this.toggleStatusChip(def);
		}));
		this.chipDisposables.add(DOM.addDisposableListener(chip, TouchEventType.Tap, () => {
			this.toggleStatusChip(def);
		}));

		// Keyboard activation
		this.chipDisposables.add(DOM.addDisposableListener(chip, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.toggleStatusChip(def);
			}
		}));
	}

	private createSortFilterChip(): void {
		const chip = DOM.append(this.container, $('.mobile-session-filter-chip'));
		chip.setAttribute('role', 'button');
		chip.setAttribute('tabindex', '0');
		chip.setAttribute('aria-label', localize('sortFilterAriaLabel', "Sort and filter options"));

		const icon = DOM.append(chip, $('span.chip-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.filter));

		const label = DOM.append(chip, $('span.chip-label'));
		label.textContent = localize('sortFilter', "Sort & Filter");

		this.chipDisposables.add(Gesture.addTarget(chip));
		this.chipDisposables.add(DOM.addDisposableListener(chip, EventType.CLICK, (e) => {
			e.preventDefault();
			this._onDidRequestSortFilter.fire();
		}));
		this.chipDisposables.add(DOM.addDisposableListener(chip, TouchEventType.Tap, () => {
			this._onDidRequestSortFilter.fire();
		}));

		this.chipDisposables.add(DOM.addDisposableListener(chip, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this._onDidRequestSortFilter.fire();
			}
		}));
	}

	/**
	 * Toggle a status filter chip. The chip applies an _inclusive_ filter:
	 *
	 * - When a chip is activated, only sessions matching the chip's statuses
	 *   are shown (all other statuses become excluded).
	 * - Tapping the same chip again deactivates it, restoring the default
	 *   (no status exclusions).
	 * - When multiple chips are active, sessions matching ANY active chip
	 *   are shown.
	 */
	private toggleStatusChip(def: IFilterChipDef): void {
		const isCurrentlyActive = this.isChipActive(def);

		if (isCurrentlyActive) {
			// Deactivate: clear all status exclusions (show everything)
			for (const chipDef of MobileSessionFilterChips.CHIP_DEFS) {
				for (const status of chipDef.statuses) {
					this.host.setStatusExcluded(status, false);
				}
			}
		} else {
			// Activate: exclude all statuses NOT covered by any active chip
			// First, compute the new set of active chips (current + this one)
			const willBeActive = new Set<IFilterChipDef>();
			willBeActive.add(def);
			for (const otherDef of MobileSessionFilterChips.CHIP_DEFS) {
				if (otherDef !== def && this.isChipActive(otherDef)) {
					willBeActive.add(otherDef);
				}
			}

			const includedStatuses = new Set<SessionStatus>();
			for (const activeDef of willBeActive) {
				for (const status of activeDef.statuses) {
					includedStatuses.add(status);
				}
			}

			// Exclude every status not in the included set,
			// include every status in the included set
			for (const chipDef of MobileSessionFilterChips.CHIP_DEFS) {
				for (const status of chipDef.statuses) {
					this.host.setStatusExcluded(status, !includedStatuses.has(status));
				}
			}
		}

		this.syncActiveStates();
	}

	/**
	 * A chip is considered "active" when ALL of its statuses are NOT excluded
	 * AND at least one other status IS excluded (meaning the user is
	 * filtering).
	 */
	private isChipActive(def: IFilterChipDef): boolean {
		const allStatuses = MobileSessionFilterChips.CHIP_DEFS.flatMap(d => [...d.statuses]);
		const hasAnyExclusion = allStatuses.some(s => this.host.isStatusExcluded(s));
		if (!hasAnyExclusion) {
			return false; // no filters active → no chip is "active"
		}
		return def.statuses.every(s => !this.host.isStatusExcluded(s));
	}

	private syncActiveStates(): void {
		for (const def of MobileSessionFilterChips.CHIP_DEFS) {
			const chip = this.chipElements.get(def.label);
			if (chip) {
				const active = this.isChipActive(def);
				chip.classList.toggle('active', active);
				chip.setAttribute('aria-pressed', String(active));
			}
		}
	}

	get element(): HTMLElement {
		return this.container;
	}
}
