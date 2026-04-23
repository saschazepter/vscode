/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '../../../../base/common/observable.js';
import { createAiStatsHover, IAiStatsHoverData } from '../../../contrib/editTelemetry/browser/editStats/aiStatsStatusBar.js';
import { AiStatsRange, IAiStatsOverview } from '../../../contrib/editTelemetry/browser/editStats/aiStatsFeature.js';
import { Random } from '../../../../editor/test/common/core/random.js';
import { ComponentFixtureContext, defineComponentFixture, defineThemedFixtureGroup } from './fixtureUtils.js';

export default defineThemedFixtureGroup({ path: 'chat/' }, {
	AiStatsHover: defineComponentFixture({
		labels: { kind: 'screenshot' },
		render: (context) => renderAiStatsHover({ ...context, data: createSampleData() }),
	}),

	AiStatsHoverNoData: defineComponentFixture({
		labels: { kind: 'screenshot' },
		render: (context) => renderAiStatsHover({ ...context, data: createEmptyData() }),
	}),
});

function createSampleData(): IAiStatsHoverData {
	const random = Random.create(42);
	const heatmap: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
	for (let dow = 0; dow < 7; dow++) {
		for (let h = 0; h < 24; h++) {
			// Bias toward 9-17 weekdays
			const baseline = (dow > 0 && dow < 6 && h >= 9 && h <= 17) ? 5 : 1;
			heatmap[dow][h] = random.nextIntRange(0, baseline + 1);
		}
	}
	const overview: IAiStatsOverview = {
		sessions: 74,
		messages: 4_222,
		totalTokens: 93_600,
		activeDays: 30,
		currentStreak: 1,
		longestStreak: 8,
		peakHour: 13,
		favoriteModel: 'claude-opus-4-1',
		heatmap,
	};
	return {
		overview: observableValue('overview', overview),
		range: observableValue<AiStatsRange>('range', 'all'),
		triggerRecompute: () => { },
	};
}

function createEmptyData(): IAiStatsHoverData {
	const overview: IAiStatsOverview = {
		sessions: 0,
		messages: 0,
		totalTokens: 0,
		activeDays: 0,
		currentStreak: 0,
		longestStreak: 0,
		peakHour: undefined,
		favoriteModel: undefined,
		heatmap: Array.from({ length: 7 }, () => new Array<number>(24).fill(0)),
	};
	return {
		overview: observableValue('overview', overview),
		range: observableValue<AiStatsRange>('range', 'all'),
		triggerRecompute: () => { },
	};
}

interface RenderOptions extends ComponentFixtureContext {
	data: IAiStatsHoverData;
}

function renderAiStatsHover({ container, disposableStore, data }: RenderOptions): void {
	container.style.width = '360px';
	container.style.padding = '8px';
	container.style.backgroundColor = 'var(--vscode-editorHoverWidget-background)';
	container.style.border = '1px solid var(--vscode-editorHoverWidget-border)';
	container.style.borderRadius = '4px';
	container.style.color = 'var(--vscode-editorHoverWidget-foreground)';

	const hover = createAiStatsHover({
		data,
		onOpenSettings: () => console.log('Open settings clicked'),
	});

	const elem = hover.keepUpdated(disposableStore).element;
	container.appendChild(elem);
}
