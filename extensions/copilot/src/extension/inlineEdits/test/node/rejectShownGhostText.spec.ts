/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { outdent } from 'outdent';
import { afterAll, assert, beforeAll, describe, it } from 'vitest';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { DefaultsOnlyConfigurationService } from '../../../../platform/configuration/common/defaultsOnlyConfigurationService';
import { IGitExtensionService } from '../../../../platform/git/common/gitExtensionService';
import { NullGitExtensionService } from '../../../../platform/git/common/nullGitExtensionService';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { InlineEditRequestLogContext } from '../../../../platform/inlineEdits/common/inlineEditLogContext';
import { ObservableGit } from '../../../../platform/inlineEdits/common/observableGit';
import { MutableObservableWorkspace } from '../../../../platform/inlineEdits/common/observableWorkspace';
import { IStatelessNextEditProvider, NoNextEditReason, StatelessNextEditRequest, StatelessNextEditTelemetryBuilder, WithStatelessProviderTelemetry } from '../../../../platform/inlineEdits/common/statelessNextEditProvider';
import { NesHistoryContextProvider } from '../../../../platform/inlineEdits/common/workspaceEditTracker/nesHistoryContextProvider';
import { NesXtabHistoryTracker } from '../../../../platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker';
import { ILogger, ILogService, LogServiceImpl } from '../../../../platform/log/common/logService';
import { NullRequestLogger } from '../../../../platform/requestLogger/node/nullRequestLogger';
import { IRequestLogger } from '../../../../platform/requestLogger/node/requestLogger';
import { ISnippyService, NullSnippyService } from '../../../../platform/snippy/common/snippyService';
import { IExperimentationService, NullExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { mockNotebookService } from '../../../../platform/test/common/testNotebookService';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { Result } from '../../../../util/common/result';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { generateUuid } from '../../../../util/vs/base/common/uuid';
import { LineEdit, LineReplacement } from '../../../../util/vs/editor/common/core/edits/lineEdit';
import { StringEdit } from '../../../../util/vs/editor/common/core/edits/stringEdit';
import { LineRange } from '../../../../util/vs/editor/common/core/ranges/lineRange';
import { OffsetRange } from '../../../../util/vs/editor/common/core/ranges/offsetRange';
import { NESInlineCompletionContext, NextEditProvider } from '../../node/nextEditProvider';
import { NextEditProviderTelemetryBuilder } from '../../node/nextEditProviderTelemetry';

describe('rejectShownGhostTextEdit', () => {

	let configService: IConfigurationService;
	let snippyService: ISnippyService;
	let gitExtensionService: IGitExtensionService;
	let logService: ILogService;
	let expService: IExperimentationService;
	let disposableStore: DisposableStore;
	let workspaceService: IWorkspaceService;
	let requestLogger: IRequestLogger;

	beforeAll(() => {
		disposableStore = new DisposableStore();
		workspaceService = disposableStore.add(new TestWorkspaceService());
		configService = new DefaultsOnlyConfigurationService();
		snippyService = new NullSnippyService();
		gitExtensionService = new NullGitExtensionService();
		logService = new LogServiceImpl([]);
		expService = new NullExperimentationService();
		requestLogger = new NullRequestLogger();
	});

	afterAll(() => {
		disposableStore.dispose();
	});

	function createStatelessNextEditProvider(): IStatelessNextEditProvider {
		return {
			ID: 'TestNextEditProvider',
			provideNextEdit: async function* (request: StatelessNextEditRequest, _logger: ILogger, _logContext: InlineEditRequestLogContext, _cancellationToken: CancellationToken) {
				const telemetryBuilder = new StatelessNextEditTelemetryBuilder(request.headerRequestId);
				const lineEdit = LineEdit.createFromUnsorted([
					new LineReplacement(
						new LineRange(5, 5),
						['\t\tprivate readonly z: number,']
					),
				]);
				for (const edit of lineEdit.replacements) {
					yield new WithStatelessProviderTelemetry({ targetDocument: request.getActiveDocument().id, edit, isFromCursorJump: false }, telemetryBuilder.build(Result.ok(undefined)));
				}
				const noSuggestions = new NoNextEditReason.NoSuggestions(request.documentBeforeEdits, undefined);
				return new WithStatelessProviderTelemetry(noSuggestions, telemetryBuilder.build(Result.error(noSuggestions)));
			}
		};
	}

	function createProvider() {
		const obsWorkspace = new MutableObservableWorkspace();
		const obsGit = new ObservableGit(gitExtensionService);
		const statelessNextEditProvider = createStatelessNextEditProvider();
		const nextEditProvider = new NextEditProvider(
			obsWorkspace, statelessNextEditProvider,
			new NesHistoryContextProvider(obsWorkspace, obsGit),
			new NesXtabHistoryTracker(obsWorkspace, undefined, configService, expService),
			undefined, configService, snippyService, logService, expService, requestLogger,
		);

		const doc = obsWorkspace.addDocument({
			id: DocumentId.create(URI.file('/test/ghost.ts').toString()),
			initialValue: outdent`
			class Point {
				constructor(
					private readonly x: number,
					private readonly y: number,
				) { }
			}`.trimStart()
		});
		doc.setSelection([new OffsetRange(1, 1)], undefined);
		doc.applyEdit(StringEdit.insert(11, '3D'));

		return { nextEditProvider, doc, obsWorkspace };
	}

	function makeContext(): NESInlineCompletionContext {
		return {
			triggerKind: 1,
			selectedCompletionInfo: undefined,
			requestUuid: generateUuid(),
			requestIssuedDateTime: Date.now(),
			earliestShownDateTime: Date.now() + 200,
			enforceCacheDelay: false,
		};
	}

	it('trackShownAsGhostText marks edit so wasShownAsGhostText returns true', async () => {
		const { nextEditProvider, doc } = createProvider();

		const ctx = makeContext();
		const logCtx = new InlineEditRequestLogContext(doc.id.toString(), 1, ctx);
		const tb1 = new NextEditProviderTelemetryBuilder(gitExtensionService, mockNotebookService, workspaceService, nextEditProvider.ID, doc);

		// Get the edit
		const result1 = await nextEditProvider.getNextEdit(doc.id, ctx, logCtx, CancellationToken.None, tb1.nesBuilder);
		tb1.dispose();
		assert(result1.result?.edit, 'request should return an edit');

		// Before tracking: not marked as shown
		assert(!nextEditProvider.wasShownAsGhostText(doc.id, result1.result.edit), 'should not be marked before tracking');

		// Track as shown ghost text
		nextEditProvider.trackShownAsGhostText(doc.id, result1.result.edit);

		// After tracking: marked as shown
		assert(nextEditProvider.wasShownAsGhostText(doc.id, result1.result.edit), 'should be marked after tracking');
	});

	it('edit is still served from cache after being tracked as ghost text', async () => {
		const { nextEditProvider, doc } = createProvider();

		const ctx = makeContext();
		const logCtx = new InlineEditRequestLogContext(doc.id.toString(), 1, ctx);
		const tb1 = new NextEditProviderTelemetryBuilder(gitExtensionService, mockNotebookService, workspaceService, nextEditProvider.ID, doc);

		// Get the edit
		const result1 = await nextEditProvider.getNextEdit(doc.id, ctx, logCtx, CancellationToken.None, tb1.nesBuilder);
		tb1.dispose();
		assert(result1.result?.edit, 'first request should return an edit');

		// Track as shown ghost text
		nextEditProvider.trackShownAsGhostText(doc.id, result1.result.edit);

		// Second request: the edit is still served (provider doesn't block it;
		// filtering is done by the inlineCompletionProvider based on isInlineCompletion)
		const ctx2 = makeContext();
		const logCtx2 = new InlineEditRequestLogContext(doc.id.toString(), 1, ctx2);
		const tb2 = new NextEditProviderTelemetryBuilder(gitExtensionService, mockNotebookService, workspaceService, nextEditProvider.ID, doc);

		const result2 = await nextEditProvider.getNextEdit(doc.id, ctx2, logCtx2, CancellationToken.None, tb2.nesBuilder);
		tb2.dispose();
		assert(result2.result?.edit, 'edit should still be served from cache — filtering is at the presentation layer');
	});

	it('wasShownAsGhostText returns false when edit was not tracked', async () => {
		const { nextEditProvider, doc } = createProvider();

		const ctx = makeContext();
		const logCtx = new InlineEditRequestLogContext(doc.id.toString(), 1, ctx);
		const tb1 = new NextEditProviderTelemetryBuilder(gitExtensionService, mockNotebookService, workspaceService, nextEditProvider.ID, doc);

		// Get the edit but do NOT track it
		const result1 = await nextEditProvider.getNextEdit(doc.id, ctx, logCtx, CancellationToken.None, tb1.nesBuilder);
		tb1.dispose();
		assert(result1.result?.edit, 'request should return an edit');

		assert(!nextEditProvider.wasShownAsGhostText(doc.id, result1.result.edit), 'should not be marked when not tracked');
	});
});
