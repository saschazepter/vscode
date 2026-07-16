/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { computeStringDiff } from '../../../../../editor/common/services/editorWebWorker.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { EditSources } from '../../../../../editor/common/textModelEditSource.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AgentHostTrackedFile, isDirtyOpenTextModel } from '../../browser/telemetry/agentHostEditSourceTracking.js';
import { IEditSourcesDetailsTelemetryData } from '../../browser/telemetry/editSourceTelemetry.js';

suite('Agent Host Edit Source Tracking', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('tracks AI edits separately from reconciliation edits', async () => {
		const disposables = new DisposableStore();
		let currentText = '';
		let uuid = 0;
		const sentTelemetry: { data: IEditSourcesDetailsTelemetryData; forwardToGitHub: boolean }[] = [];
		const trackedFile = disposables.add(new AgentHostTrackedFile(
			URI.file('C:\\repo\\file.ts'),
			'',
			async () => currentText,
			async (original, modified) => computeStringDiff(original, modified, { maxComputationTimeMs: 500 }, 'advanced'),
			() => undefined,
			() => `stats-${++uuid}`,
			(data, forwardToGitHub) => sentTelemetry.push({ data, forwardToGitHub }),
			new NullLogService(),
			() => { },
		));

		await trackedFile.applyEdit('', 'alpha\n', agentHostEditSource('copilotcli', 'session-1', 'turn-1'), 'typescript');
		await trackedFile.applyEdit('alpha\n', 'alpha\nbeta\n', agentHostEditSource('claude', 'session-1', 'turn-2'), 'typescript');
		currentText = 'alpha\nX\n';
		await trackedFile.flush('hashChange');
		await trackedFile.flush('hashChange');

		assert.deepStrictEqual(sentTelemetry, [
			{
				data: {
					mode: 'longterm',
					sourceKey: 'source:Chat.applyEdits-$harness:copilotcli-$origin:agentHost-$trackingScope:agentHostAIOnly',
					sourceKeyCleaned: 'source:Chat.applyEdits-$harness:copilotcli-$origin:agentHost-$trackingScope:agentHostAIOnly',
					extensionId: undefined,
					extensionVersion: undefined,
					modelId: undefined,
					trigger: 'hashChange',
					languageId: 'typescript',
					statsUuid: 'stats-1',
					conversationId: 'session-1',
					requestId: 'turn-1',
					origin: 'agentHost',
					harness: 'copilotcli',
					trackingScope: 'agentHostAIOnly',
					modifiedCount: 6,
					deltaModifiedCount: 6,
					totalModifiedCount: 7,
				},
				forwardToGitHub: true,
			},
			{
				data: {
					mode: 'longterm',
					sourceKey: 'source:Chat.applyEdits-$harness:claude-$origin:agentHost-$trackingScope:agentHostAIOnly',
					sourceKeyCleaned: 'source:Chat.applyEdits-$harness:claude-$origin:agentHost-$trackingScope:agentHostAIOnly',
					extensionId: undefined,
					extensionVersion: undefined,
					modelId: undefined,
					trigger: 'hashChange',
					languageId: 'typescript',
					statsUuid: 'stats-1',
					conversationId: 'session-1',
					requestId: 'turn-2',
					origin: 'agentHost',
					harness: 'claude',
					trackingScope: 'agentHostAIOnly',
					modifiedCount: 1,
					deltaModifiedCount: 5,
					totalModifiedCount: 7,
				},
				forwardToGitHub: false,
			},
		]);

		disposables.dispose();
	});

	test('only skips attribution for open dirty text models', () => {
		const resource = URI.file('C:\\repo\\file.ts');
		const model = Object.create(null) as ITextModel;

		assert.deepStrictEqual({
			closedDirty: isDirtyOpenTextModel(resource, { getModel: () => null }, { isDirty: () => true }),
			openClean: isDirtyOpenTextModel(resource, { getModel: () => model }, { isDirty: () => false }),
			openDirty: isDirtyOpenTextModel(resource, { getModel: () => model }, { isDirty: () => true }),
		}, {
			closedDirty: false,
			openClean: false,
			openDirty: true,
		});
	});

	test('provides a stable tracker snapshot at flush', async () => {
		const disposables = new DisposableStore();
		let currentText = '';
		const snapshots: { content: string; sources: readonly { sourceKey: string; insertedCount: number; retainedCount: number }[] }[] = [];
		const trackedFile = disposables.add(new AgentHostTrackedFile(
			URI.file('C:\\repo\\file.ts'),
			'',
			async () => currentText,
			async (original, modified) => computeStringDiff(original, modified, { maxComputationTimeMs: 500 }, 'advanced'),
			() => undefined,
			() => 'stats-1',
			() => { },
			new NullLogService(),
			() => { },
			(_resource, content, snapshot) => snapshots.push({
				content,
				sources: snapshot.sources.map(source => ({
					sourceKey: source.sourceKey,
					insertedCount: source.insertedCount,
					retainedCount: source.retainedCount,
				})),
			}),
		));

		currentText = 'agent';
		await trackedFile.applyEdit('', currentText, agentHostEditSource('copilotcli', 'session-1', 'turn-1'), 'typescript');
		await trackedFile.flush('hashChange');

		assert.deepStrictEqual(snapshots, [{
			content: 'agent',
			sources: [{
				sourceKey: 'source:Chat.applyEdits-$harness:copilotcli-$origin:agentHost-$trackingScope:agentHostAIOnly',
				insertedCount: 5,
				retainedCount: 5,
			}],
		}]);
		disposables.dispose();
	});
});

function agentHostEditSource(harness: string, sessionId: string, turnId: string) {
	return EditSources.chatApplyEdits({
		modelId: undefined,
		sessionId,
		requestId: turnId,
		languageId: 'typescript',
		mode: undefined,
		extensionId: undefined,
		codeBlockSuggestionId: undefined,
		harness,
		origin: 'agentHost',
		trackingScope: 'agentHostAIOnly',
	});
}
