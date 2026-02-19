/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { n } from '../../../../../base/browser/dom.js';
import { ActionBar, IActionBarOptions, IActionOptions } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { IAction } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { createHotClass } from '../../../../../base/common/hotReloadHelpers.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IHoverService, nativeHoverDelegate } from '../../../../../platform/hover/browser/hover.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IStatusbarService, ShowTooltipCommand, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { AI_STATS_SETTING_ID } from '../settingIds.js';
import type { AiStatsFeature, IChatRequestRecord } from './aiStatsFeature.js';
import { createDayOfWeekChart, createModelBarChart, IModelUsageData } from './aiStatsChart.js';
import './media.css';

export class AiStatsStatusBar extends Disposable {
	public static readonly hot = createHotClass(this);

	constructor(
		private readonly _aiStatsFeature: AiStatsFeature,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@ICommandService private readonly _commandService: ICommandService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		super();

		this._register(autorun((reader) => {
			const statusBarItem = this._createStatusBar().keepUpdated(reader.store);

			const store = this._register(new DisposableStore());

			const entryDisposable = reader.store.add(this._statusbarService.addEntry({
				name: localize('aiStats', "AI Usage Statistics"),
				ariaLabel: localize('aiStatsStatusBar', "AI usage statistics"),
				text: '',
				command: ShowTooltipCommand,
				tooltip: {
					element: (_token) => {
						this._sendHoverTelemetry();
						store.clear();
						const elem = createAiStatsHover({
							data: this._aiStatsFeature,
							onOpenSettings: () => openSettingsCommand({ ids: [AI_STATS_SETTING_ID] }).run(this._commandService),
						});
						return elem.keepUpdated(store).element;
					},
				},
				content: statusBarItem.element,
			}, 'aiStatsStatusBar', StatusbarAlignment.RIGHT, 100));

			// The status bar click handler is on the label container, which is hidden
			// when text is empty. Register a click on the content element to show the
			// hover via IHoverService.
			statusBarItem.element.style.cursor = 'pointer';
			statusBarItem.element.addEventListener('click', () => {
				const container = statusBarItem.element.parentElement;
				if (container) {
					this._hoverService.showManagedHover(container);
				}
			});
		}));
	}

	private _sendHoverTelemetry(): void {
		this._telemetryService.publicLog2<{
			aiRate: number;
		}, {
			owner: 'hediet';
			comment: 'Fired when the AI stats status bar hover tooltip is shown';
			aiRate: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The current AI rate percentage' };
		}>(
			'aiStatsStatusBar.hover',
			{
				aiRate: this._aiStatsFeature.aiRate.get(),
			}
		);
	}


	private _createStatusBar() {
		return n.div({
			style: {
				height: '100%',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				marginLeft: '3px',
				marginRight: '3px',
			}
		}, [
			n.div(
				{
					class: 'ai-stats-gauge',
					style: {
						display: 'flex',
						flexDirection: 'column',

						width: 50,
						height: 6,

						borderRadius: 6,
						borderWidth: '1px',
						borderStyle: 'solid',
					}
				},
				[
					n.div({
						style: {
							flex: 1,

							display: 'flex',
							overflow: 'hidden',

							borderRadius: 6,
							border: '1px solid transparent',
						}
					}, [
						n.div({
							style: {
								width: this._aiStatsFeature.aiRate.map(v => `${v * 100}%`),
								backgroundColor: 'currentColor',
							}
						})
					])
				]
			)
		]);
	}
}

export interface IAiStatsHoverData {
	readonly aiRate: IObservable<number>;
	readonly acceptedInlineSuggestionsToday: IObservable<number>;
	readonly chatRequests: IObservable<readonly IChatRequestRecord[]>;
	readonly chatSessionCount: IObservable<number>;
	readonly totalTokenUsage: IObservable<{ total: number; input: number; output: number }>;
	readonly requestsByDayOfWeek: IObservable<number[]>;
	readonly topModels: IObservable<readonly IModelUsageData[]>;
}

export interface IAiStatsHoverOptions {
	readonly data: IAiStatsHoverData;
	readonly onOpenSettings?: () => void;
}

export function createAiStatsHover(options: IAiStatsHoverOptions) {
	const aiRatePercent = options.data.aiRate.map(r => `${Math.round(r * 100)}%`);

	return n.div({
		class: 'ai-stats-tooltip',
		style: { minWidth: '280px' },
	}, [
		// Header
		n.div({ class: 'header' }, [
			n.div({ style: { flex: 1 } }, [localize('aiStatsStatusBarHeader', "AI Usage Statistics")]),
			n.div({ style: { marginLeft: 'auto' } }, options.onOpenSettings
				? actionBar([{
					action: {
						id: 'aiStats.statusBar.settings',
						label: '',
						enabled: true,
						run: options.onOpenSettings,
						class: ThemeIcon.asClassName(Codicon.gear),
						tooltip: localize('aiStats.statusBar.configure', "Configure")
					},
					options: { icon: true, label: false, hoverDelegate: nativeHoverDelegate }
				}])
				: []),
		]),

		// AI rate
		n.div({ class: 'stat-row' }, [
			n.div({}, [localize('aiRateLabel', "AI vs Typing Average")]),
			n.div({ class: 'stat-value' }, [aiRatePercent]),
		]),

		// Inline suggestions
		n.div({ class: 'stat-row' }, [
			n.div({}, [localize('inlineSuggestionsLabel', "Accepted Inline Suggestions Today")]),
			n.div({ class: 'stat-value' }, [options.data.acceptedInlineSuggestionsToday.map(v => `${v}`)]),
		]),

		// --- Agent Usage ---
		n.elem('hr', {}),
		n.div({ class: 'header' }, [localize('agentStatsHeader', "Agent Usage")]),
		n.div({ class: 'stat-row' }, [
			n.div({}, [localize('sessions', "Sessions")]),
			n.div({ class: 'stat-value' }, [options.data.chatSessionCount.map(v => `${v}`)]),
		]),
		n.div({ class: 'stat-row' }, [
			n.div({}, [localize('totalRequests', "Total Requests")]),
			n.div({ class: 'stat-value' }, [options.data.chatRequests.map(r => `${r.length}`)]),
		]),

		// --- Token Usage ---
		n.elem('hr', {}),
		n.div({ class: 'header' }, [localize('tokenUsageHeader', "Token Usage")]),
		n.div({ class: 'stat-row' }, [
			n.div({}, [localize('totalTokens', "Total")]),
			n.div({ class: 'stat-value' }, [options.data.totalTokenUsage.map(t => formatTokenCount(t.total))]),
		]),
		n.div({ class: 'stat-row' }, [
			n.div({}, [localize('inputTokens', "Input")]),
			n.div({ class: 'stat-value' }, [options.data.totalTokenUsage.map(t => formatTokenCount(t.input))]),
		]),
		n.div({ class: 'stat-row' }, [
			n.div({}, [localize('outputTokens', "Output")]),
			n.div({ class: 'stat-value' }, [options.data.totalTokenUsage.map(t => formatTokenCount(t.output))]),
		]),

		// --- Requests by Day of Week ---
		n.elem('hr', {}),
		n.div({ class: 'header' }, [localize('popularDaysHeader', "Requests by Day of Week")]),
		derived(reader => {
			const dayData = options.data.requestsByDayOfWeek.read(reader);
			return n.div({
				ref: (el) => {
					el.appendChild(createDayOfWeekChart(dayData));
				}
			});
		}),

		// --- Top Models ---
		n.elem('hr', {}),
		n.div({ class: 'header' }, [localize('topModelsHeader', "Top Models")]),
		derived(reader => {
			const models = options.data.topModels.read(reader);
			return n.div({
				ref: (el) => {
					el.appendChild(createModelBarChart([...models]));
				}
			});
		}),
	]);
}

function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1)}M`;
	}
	if (count >= 1_000) {
		return `${(count / 1_000).toFixed(1)}K`;
	}
	return `${count}`;
}

function actionBar(actions: { action: IAction; options: IActionOptions }[], options?: IActionBarOptions) {
	return derived((_reader) => n.div({
		ref: elem => {
			const actionBar = _reader.store.add(new ActionBar(elem, options));
			for (const { action, options } of actions) {
				actionBar.push(action, options);
			}
		}
	}));
}

class CommandWithArgs {
	constructor(
		public readonly commandId: string,
		public readonly args: unknown[] = [],
	) { }

	public run(commandService: ICommandService): void {
		commandService.executeCommand(this.commandId, ...this.args);
	}
}

function openSettingsCommand(options: { ids?: string[] } = {}) {
	return new CommandWithArgs('workbench.action.openSettings', [{
		query: options.ids ? options.ids.map(id => `@id:${id}`).join(' ') : undefined,
	}]);
}
