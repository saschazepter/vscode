/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { type ContextItem, type RequestContext } from '../../../../platform/languageServer/common/languageContextService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import * as protocol from '../../common/serverProtocol';
import { ContextItemResultBuilder, ResolvedRunnableResult, type OnCachePopulatedEvent, type OnContextComputedEvent, type OnContextComputedOnTimeoutEvent } from '../types';
import { CharacterBudget, ContextItemUsageMode, currentTokenBudget, InflightRequestInfo, OnTimeoutData, PendingRequestInfo, TSLanguageContextService } from '../languageContextService';

enum ExecutionTarget {
	Semantic,
	Syntax
}

type ExecConfig = {
	readonly lowPriority?: boolean;
	readonly nonRecoverable?: boolean;
	readonly cancelOnResourceChange?: vscode.Uri;
	readonly executionTarget?: ExecutionTarget;
};

type ComputeContextRequestArgs = Omit<protocol.ComputeContextRequestArgs, 'file' | 'projectFileName' | 'line' | 'offset'> & {
	file: vscode.Uri;
	line: number;
	offset: number;
	$traceId?: string;
};
namespace ComputeContextRequestArgs {
	export function create(document: vscode.TextDocument, position: vscode.Position, context: RequestContext, startTime: number, timeBudget: number, willLogRequestTelemetry: boolean, neighborFiles: readonly string[] | undefined, clientSideRunnableResults: readonly protocol.CachedContextRunnableResult[] | undefined, includeDocumentation: boolean): ComputeContextRequestArgs {
		return {
			file: vscode.Uri.file(document.fileName),
			line: position.line + 1,
			offset: position.character + 1,
			startTime: startTime,
			timeBudget: timeBudget,
			primaryCharacterBudget: (context.tokenBudget ?? 7 * 1024) * 4,
			secondaryCharacterBudget: (currentTokenBudget * 4),
			includeDocumentation: includeDocumentation,
			neighborFiles: neighborFiles !== undefined && neighborFiles.length > 0 ? neighborFiles : undefined,
			clientSideRunnableResults: clientSideRunnableResults,
			$traceId: willLogRequestTelemetry ? context.requestId : undefined
		};
	}
}

export class TS7LanguageContextService extends TSLanguageContextService {

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
		@ILogService private readonly logService: ILogService
	) {
		super(telemetryService, logService);
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
