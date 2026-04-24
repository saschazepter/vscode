/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '../../../../base/common/observable.js';
import { createAiStatsHover, IAiStatsHoverData } from '../../../contrib/editTelemetry/browser/editStats/aiStatsView.js';
import { IAiStatsOverview } from '../../../contrib/editTelemetry/browser/editStats/aiStatsFeature.js';
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
	const overview: IAiStatsOverview = {
		totalTokens: 93_600,
		avgTokensPerDay: 4_680,
		currentStreak: 1,
		favoriteModel: 'claude-opus-4-1',
		topDay: { dateMs: new Date(2026, 3, 13).getTime(), tokens: 12_400 },
	};
	return {
		overview: observableValue('overview', overview),
		triggerRecompute: () => { },
	};
}

function createEmptyData(): IAiStatsHoverData {
	const overview: IAiStatsOverview = {
		totalTokens: 0,
		avgTokensPerDay: 0,
		currentStreak: 0,
		favoriteModel: undefined,
		topDay: undefined,
	};
	return {
		overview: observableValue('overview', overview),
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
	});

	const elem = hover.keepUpdated(disposableStore).element;
	container.appendChild(elem);
}
