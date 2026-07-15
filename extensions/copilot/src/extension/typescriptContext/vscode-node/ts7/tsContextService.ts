/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { type ContextItem, type RequestContext } from '../../../../platform/languageServer/common/languageContextService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { TSLanguageContextService } from '../tsContextService';

export class TS7LanguageContextService extends TSLanguageContextService {

	constructor(
		telemetryService: ITelemetryService,
		configurationService: IConfigurationService,
		experimentationService: IExperimentationService,
		logService: ILogService
	) {
		super(telemetryService, logService, configurationService, experimentationService);
	}

	public override dispose(): void {
		super.dispose();
	}

	async isActivated(documentOrLanguageId: vscode.TextDocument | string): Promise<boolean> {
		const languageId = typeof documentOrLanguageId === 'string' ? documentOrLanguageId : documentOrLanguageId.languageId;
		if (languageId !== 'typescript' && languageId !== 'typescriptreact') {
			return false;
		}
		return false;
	}

	async populateCache(document: vscode.TextDocument, position: vscode.Position, context: RequestContext): Promise<void> {
		return;
	}

	public async *getContext(document: vscode.TextDocument, position: vscode.Position, context: RequestContext, token: vscode.CancellationToken): AsyncIterable<ContextItem> {
		return;
	}

	public getContextOnTimeout(document: vscode.TextDocument, position: vscode.Position, context: RequestContext): readonly ContextItem[] | undefined {
		return undefined;
	}
}
