/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Gesture, EventType as TouchEventType } from '../../../../../base/browser/touch.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun, IObservable } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionListItemKind, IActionListDelegate, IActionListItem } from '../../../../../platform/actionWidget/browser/actionList.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { reportNewChatPickerClosed } from '../../../chat/browser/newChatPickerTelemetry.js';

const FILTER_THRESHOLD = 10;

/** Minimal contract the BranchPicker needs to render and interact. */
export interface IBranchPickerModel {
	readonly branches: IObservable<readonly string[]>;
	readonly branch: IObservable<string | undefined>;
	readonly loading: IObservable<boolean>;
	readonly disabled: IObservable<boolean>;
	setBranch(name: string): void;
}

interface IBranchItem {
	readonly name: string;
}

/**
 * A widget for selecting a git branch.
 * Renders branch state from the provided {@link IBranchPickerModel}.
 */
export class BranchPicker extends Disposable {

	private readonly _renderDisposables = this._register(new DisposableStore());
	private _slotElement: HTMLElement | undefined;
	private _triggerElement: HTMLElement | undefined;

	constructor(
		private readonly _model: IObservable<IBranchPickerModel | undefined>,
		@IActionWidgetService private readonly actionWidgetService: IActionWidgetService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) {
		super();

		this._register(autorun(reader => {
			const model = this._model.read(reader);
			if (model) {
				model.loading.read(reader);
				model.branches.read(reader);
				model.branch.read(reader);
				model.disabled.read(reader);
			}
			this._updateTriggerLabel();
		}));
	}

	render(container: HTMLElement): void {
		this._renderDisposables.clear();

		const slot = dom.append(container, dom.$('.sessions-chat-picker-slot'));
		this._slotElement = slot;
		this._renderDisposables.add({ dispose: () => slot.remove() });

		const trigger = dom.append(slot, dom.$('a.action-label'));
		trigger.tabIndex = 0;
		trigger.role = 'button';
		this._triggerElement = trigger;
		this._updateTriggerLabel();

		this._renderDisposables.add(Gesture.addTarget(trigger));
		for (const eventType of [dom.EventType.CLICK, TouchEventType.Tap]) {
			this._renderDisposables.add(dom.addDisposableListener(trigger, eventType, (e) => {
				dom.EventHelper.stop(e, true);
				this.showPicker();
			}));
		}

		this._renderDisposables.add(dom.addDisposableListener(trigger, dom.EventType.KEY_DOWN, (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				dom.EventHelper.stop(e, true);
				this.showPicker();
			}
		}));
	}

	showPicker(): void {
		const model = this._model.get();
		const branches = model?.branches.get() ?? [];
		if (!this._triggerElement || this.actionWidgetService.isVisible || branches.length === 0 || model?.disabled.get()) {
			return;
		}

		const selectedBranch = model?.branch.get();
		const items: IActionListItem<IBranchItem>[] = branches.map(branch => ({
			kind: ActionListItemKind.Action,
			label: branch,
			group: { title: '', icon: Codicon.gitBranch },
			item: { name: branch, checked: branch === selectedBranch || undefined },
		}));

		const triggerElement = this._triggerElement;
		const delegate: IActionListDelegate<IBranchItem> = {
			onSelect: (item) => {
				this.actionWidgetService.hide();
				reportNewChatPickerClosed(this.telemetryService, {
					id: 'NewChatBranchPicker',
					name: 'NewChatBranchPicker',
					optionIdBefore: selectedBranch,
					optionIdAfter: item.name,
					optionLabelBefore: selectedBranch,
					optionLabelAfter: item.name,
					isPII: true,
				});
				model?.setBranch(item.name);
			},
			onHide: () => { triggerElement.focus(); },
		};

		const totalActions = items.filter(i => i.kind === ActionListItemKind.Action).length;

		this.actionWidgetService.show<IBranchItem>(
			'branchPicker',
			false,
			items,
			delegate,
			this._triggerElement,
			undefined,
			[],
			{
				getAriaLabel: (item) => item.label ?? '',
				getWidgetAriaLabel: () => localize('branchPicker.ariaLabel', "Branch Picker"),
			},
			totalActions > FILTER_THRESHOLD ? { showFilter: true, filterPlaceholder: localize('branchPicker.filter', "Filter branches...") } : undefined,
		);
	}

	private _updateTriggerLabel(): void {
		if (!this._triggerElement) {
			return;
		}
		dom.clearNode(this._triggerElement);

		const model = this._model.get();
		const isLoading = model?.loading.get() ?? false;
		const isDisabled = model?.disabled.get() ?? false;
		const label = model?.branch.get() ?? localize('branchPicker.select', "Branch");

		dom.append(this._triggerElement, renderIcon(Codicon.gitBranch));
		const labelSpan = dom.append(this._triggerElement, dom.$('span.sessions-chat-dropdown-label'));
		labelSpan.textContent = label;
		dom.append(this._triggerElement, renderIcon(Codicon.chevronDown));

		this._triggerElement.ariaLabel = localize('branchPicker.triggerAriaLabel', "Pick Branch, {0}", label);

		this._slotElement?.classList.toggle('disabled', isLoading || isDisabled);
		this._triggerElement.setAttribute('aria-disabled', String(isLoading || isDisabled));
		this._triggerElement.tabIndex = (isLoading || isDisabled) ? -1 : 0;
	}
}
