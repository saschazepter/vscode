/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { n } from '../../../../../base/browser/dom.js';
import { ActionBar, IActionBarOptions, IActionOptions } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { IAction } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { safeIntl } from '../../../../../base/common/date.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { derived, IObservable, ISettableObservable } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { nativeHoverDelegate } from '../../../../../platform/hover/browser/hover.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { AI_STATS_SETTING_ID } from '../settingIds.js';
import { AiStatsRange, IAiStatsOverview } from './aiStatsFeature.js';
import './media.css';

const numberFormatter = safeIntl.NumberFormat();
const compactFormatter = safeIntl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const hourFormatter = safeIntl.DateTimeFormat(undefined, { hour: 'numeric' });

export class AiStatsStatusBar extends Disposable {

	constructor(
		private readonly _feature: IAiStatsHoverData,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@ICommandService private readonly _commandService: ICommandService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
		super();

		const statusBarItem = this._createStatusBar().keepUpdated(this._store);
		const hoverStore = this._register(new DisposableStore());

		this._register(this._statusbarService.addEntry({
			name: localize('aiStatsStatusBar.name', "AI Usage Statistics"),
			ariaLabel: localize('aiStatsStatusBar.aria', "AI usage statistics status bar"),
			text: '',
			tooltip: {
				element: async (_token) => {
					this._sendHoverTelemetry();
					hoverStore.clear();
					this._feature.triggerRecompute();
					const elem = createAiStatsHover({
						data: this._feature,
						onOpenSettings: () => this._commandService.executeCommand('workbench.action.openSettings', { query: `@id:${AI_STATS_SETTING_ID}` }),
					});
					return elem.keepUpdated(hoverStore).element;
				},
				markdownNotSupportedFallback: undefined,
			},
			content: statusBarItem.element,
		}, 'aiStatsStatusBar', StatusbarAlignment.RIGHT, 100));
	}

	private _sendHoverTelemetry(): void {
		const overview = this._feature.overview.get();
		this._telemetryService.publicLog2<{
			sessions: number;
			messages: number;
			totalTokens: number;
			activeDays: number;
		}, {
			owner: 'hediet';
			comment: 'Fired when the AI usage stats status bar hover tooltip is shown';
			sessions: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Total chat sessions counted' };
			messages: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Total chat messages counted' };
			totalTokens: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Total completion tokens counted' };
			activeDays: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Distinct active days in window' };
		}>('aiStatsStatusBar.hover', {
			sessions: overview.sessions,
			messages: overview.messages,
			totalTokens: overview.totalTokens,
			activeDays: overview.activeDays,
		});
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
			n.div({ class: ThemeIcon.asClassName(Codicon.graphLine) }),
		]);
	}
}

/**
 * Minimal interface used by the status bar so this file does not depend on
 * the concrete feature class (avoids cyclic import).
 */
export interface IAiStatsHoverData {
	readonly overview: IObservable<IAiStatsOverview>;
	readonly range: ISettableObservable<AiStatsRange>;
	triggerRecompute(): void;
}

export interface IAiStatsHoverOptions {
	readonly data: IAiStatsHoverData;
	readonly onOpenSettings?: () => void;
}

export function createAiStatsHover(options: IAiStatsHoverOptions) {
	return n.div({
		class: 'ai-stats-status-bar',
		style: { minWidth: '320px' },
	}, [
		// Header row
		n.div({
			class: 'header',
		}, [
			n.div({ style: { flex: 1 } }, [localize('aiStatsStatusBarHeader', "AI Usage Statistics")]),
			n.div({ style: { marginLeft: 'auto' } }, options.onOpenSettings
				? actionBar([
					{
						action: {
							id: 'aiStats.statusBar.settings',
							label: '',
							enabled: true,
							run: options.onOpenSettings,
							class: ThemeIcon.asClassName(Codicon.gear),
							tooltip: localize('aiStats.statusBar.configure', "Configure")
						},
						options: { icon: true, label: false, hoverDelegate: nativeHoverDelegate }
					}
				])
				: [])
		]),

		// Time range filter
		n.div({
			class: 'ai-stats-range-pills',
		}, [
			rangePill(options.data, 'all', localize('aiStats.range.all', "All")),
			rangePill(options.data, '30d', localize('aiStats.range.30d', "30d")),
			rangePill(options.data, '7d', localize('aiStats.range.7d', "7d")),
		]),

		// Stats grid
		derived(reader => {
			const overview = options.data.overview.read(reader);
			return n.div({ class: 'ai-stats-grid' }, [
				statCell(localize('aiStats.metric.sessions', "Sessions"), numberFormatter.value.format(overview.sessions)),
				statCell(localize('aiStats.metric.messages', "Messages"), numberFormatter.value.format(overview.messages)),
				statCell(localize('aiStats.metric.totalTokens', "Total tokens"), compactFormatter.value.format(overview.totalTokens)),
				statCell(localize('aiStats.metric.activeDays', "Active days"), numberFormatter.value.format(overview.activeDays)),
				statCell(localize('aiStats.metric.currentStreak', "Current streak"), formatStreak(overview.currentStreak)),
				statCell(localize('aiStats.metric.longestStreak', "Longest streak"), formatStreak(overview.longestStreak)),
				statCell(localize('aiStats.metric.peakHour', "Peak hour"), formatHour(overview.peakHour)),
				statCell(localize('aiStats.metric.favoriteModel', "Favorite model"), overview.favoriteModel ?? '\u2014'),
			]);
		}),

		// Heatmap
		derived(reader => {
			const overview = options.data.overview.read(reader);
			return renderHeatmap(overview.heatmap);
		}),

		// Footer comparison
		n.div({
			class: 'ai-stats-footer',
		}, [
			derived(reader => {
				const overview = options.data.overview.read(reader);
				return n.div({}, [tokenComparisonText(overview.totalTokens)]);
			}),
		]),
	]);
}

function statCell(label: string, value: string) {
	return n.div({ class: 'ai-stats-cell' }, [
		n.div({ class: 'ai-stats-cell-label' }, [label]),
		n.div({ class: 'ai-stats-cell-value' }, [value]),
	]);
}

function rangePill(data: IAiStatsHoverData, value: AiStatsRange, label: string) {
	return derived(reader => {
		const current = data.range.read(reader);
		const isActive = current === value;
		return n.div({
			class: ['ai-stats-range-pill', isActive ? 'active' : ''],
			onclick: () => data.range.set(value, undefined),
		}, [label]);
	});
}

function renderHeatmap(heatmap: ReadonlyArray<ReadonlyArray<number>>) {
	let max = 0;
	for (const row of heatmap) {
		for (const v of row) {
			if (v > max) {
				max = v;
			}
		}
	}
	return n.div({ class: 'ai-stats-heatmap' },
		heatmap.map((row, dow) =>
			n.div({ class: 'ai-stats-heatmap-row' },
				row.map((v, hour) => {
					const intensity = max === 0 ? 0 : Math.ceil((v / max) * 4);
					return n.div({
						class: ['ai-stats-heatmap-cell', `level-${intensity}`],
						title: `${dayLabel(dow)} ${formatHour(hour)} \u2014 ${v}`,
					});
				})
			)
		)
	);
}

function dayLabel(dow: number): string {
	switch (dow) {
		case 0: return localize('aiStats.day.sun', "Sun");
		case 1: return localize('aiStats.day.mon', "Mon");
		case 2: return localize('aiStats.day.tue', "Tue");
		case 3: return localize('aiStats.day.wed', "Wed");
		case 4: return localize('aiStats.day.thu', "Thu");
		case 5: return localize('aiStats.day.fri', "Fri");
		default: return localize('aiStats.day.sat', "Sat");
	}
}

function formatStreak(days: number): string {
	if (days <= 0) {
		return '\u2014';
	}
	if (days === 1) {
		return localize('aiStats.streakDay', "1 day");
	}
	return localize('aiStats.streakDays', "{0} days", days);
}

function formatHour(hour: number | undefined): string {
	if (hour === undefined) {
		return '\u2014';
	}
	const date = new Date();
	date.setHours(hour, 0, 0, 0);
	return hourFormatter.value.format(date);
}

interface ITokenReference {
	readonly minTokens: number;
	readonly label: string;
}

function tokenComparisonText(totalTokens: number): string {
	if (totalTokens <= 0) {
		return localize('aiStats.comparison.none', "Send your first chat message to start tracking your usage.");
	}
	// Curated reference points (approximate token counts for well-known texts).
	const references: ITokenReference[] = [
		{ minTokens: 5_000_000, label: localize('aiStats.ref.encyclopedia', "the entire English Wikipedia front page archive") },
		{ minTokens: 1_000_000, label: localize('aiStats.ref.lotr', "the Lord of the Rings trilogy") },
		{ minTokens: 200_000, label: localize('aiStats.ref.mobyDick', "Moby-Dick") },
		{ minTokens: 70_000, label: localize('aiStats.ref.gatsby', "The Great Gatsby") },
		{ minTokens: 20_000, label: localize('aiStats.ref.novella', "a short novella") },
		{ minTokens: 5_000, label: localize('aiStats.ref.shortStory', "a short story") },
		{ minTokens: 0, label: localize('aiStats.ref.email', "a long email") },
	];
	const ref = references.find(r => totalTokens >= r.minTokens) ?? references[references.length - 1];
	return localize('aiStats.comparison', "You've used about as many tokens as {0}.", ref.label);
}

function actionBar(actions: { action: IAction; options: IActionOptions }[], options?: IActionBarOptions) {
	return derived(_reader => n.div({
		ref: elem => {
			const ab = _reader.store.add(new ActionBar(elem, options));
			for (const { action, options } of actions) {
				ab.push(action, options);
			}
		}
	}));
}
