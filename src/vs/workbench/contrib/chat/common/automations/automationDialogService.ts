/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IAutomation } from './automation.js';
import { ICreateAutomationOptions, IUpdateAutomationOptions } from './automationService.js';

export interface IShowAutomationDialogOptions {
	readonly existing?: IAutomation;
	/** Values applied over the create defaults or existing automation before the dialog is shown. */
	readonly initialValues?: IUpdateAutomationOptions;
	/** Whether the dialog is reviewing values proposed by an agent. */
	readonly isAgentProposal?: boolean;
	/** Keep an initial target visible while its provider/session type is temporarily unavailable. */
	readonly preserveUnavailableInitialTarget?: boolean;
	/** Closes the dialog without saving when the originating operation is cancelled. */
	readonly cancellationToken?: CancellationToken;
}

export type IAutomationDialogResult =
	| { readonly kind: 'create'; readonly value: ICreateAutomationOptions }
	| { readonly kind: 'update'; readonly id: string; readonly value: IUpdateAutomationOptions };

export const IAutomationDialogService = createDecorator<IAutomationDialogService>('automationDialogService');

/**
 * Bridges the workbench Automations UI (list widget) to the Sessions-layer
 * dialog implementation without a cross-layer import: the widget depends only
 * on this interface, while {@link AutomationDialogService} (sessions) provides it.
 */
export interface IAutomationDialogService {
	readonly _serviceBrand: undefined;
	showAutomationDialog(options: IShowAutomationDialogOptions): Promise<IAutomationDialogResult | undefined>;
}
