/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService, CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';

const OPEN_AGENTS_WINDOW_COMMAND = 'workbench.action.openAgentsWindow';

type AgentsBannerClickedEvent = {
	source: string;
	action: string;
};

type AgentsBannerClickedClassification = {
	source: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Where the banner was clicked from.' };
	action: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The action taken on the banner.' };
	owner: 'benibenj';
	comment: 'Tracks clicks on the agents app banner across welcome pages.';
};

export interface IAgentsBannerResult {
	readonly element: HTMLElement;
	readonly disposables: DisposableStore;
}

/**
 * Returns whether the agents banner can be shown.
 * The banner requires the `workbench.action.openAgentsWindow` command
 * to be registered (desktop builds only) and is limited to Insiders quality.
 */
export function canShowAgentsBanner(productService: IProductService): boolean {
	return productService.quality !== 'stable'
		&& !!CommandsRegistry.getCommand(OPEN_AGENTS_WINDOW_COMMAND);
}

/**
 * Creates a banner that promotes the Agents app.
 * The banner contains a button that opens the Agents window.
 *
 * @param cssClass Dot-separated CSS classes for the banner container (e.g. 'my-banner' or 'foo.bar').
 * @param source Identifies where the banner is displayed (e.g. 'welcomePage', 'agentSessionsWelcome').
 * @param commandService Used to execute the open command.
 * @param telemetryService Used to log banner interactions.
 * @param onButtonClick Optional callback invoked when the banner button is clicked.
 */
export function createAgentsBanner(
	cssClass: string,
	source: string,
	commandService: ICommandService,
	telemetryService: ITelemetryService,
	onButtonClick?: () => void,
): IAgentsBannerResult {
	const disposables = new DisposableStore();

	const button = $('button.agents-banner-button', {
		title: localize('agentsBanner.tryAgentsApp', "Try out the new Agents app"),
	},
		$('.codicon.codicon-agent.icon-widget'),
		$('span.category-title', {}, localize('agentsBanner.tryAgentsAppLabel', "Try out the new Agents app")),
	);
	disposables.add(addDisposableListener(button, 'click', () => {
		onButtonClick?.();
		telemetryService.publicLog2<AgentsBannerClickedEvent, AgentsBannerClickedClassification>('agentsBanner.clicked', { source, action: 'openAgentsWindow' });
		commandService.executeCommand(OPEN_AGENTS_WINDOW_COMMAND, { forceNewWindow: true });
	}));

	const element = $(`.${cssClass}`, {}, button);

	return { element, disposables };
}
