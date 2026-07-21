/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IObservable, IObservableWithChange, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { OffsetRange } from '../../../../../editor/common/core/ranges/offsetRange.js';
import { StringText } from '../../../../../editor/common/core/text/abstractText.js';
import { IEditorWorkerService } from '../../../../../editor/common/services/editorWorker.js';
import { computeStringDiff } from '../../../../../editor/common/services/editorWebWorker.js';
import { EditSources, TextModelEditSource } from '../../../../../editor/common/textModelEditSource.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IObservableDocument, ObservableWorkspace, StringEditWithReason } from '../../browser/helpers/observableWorkspace.js';
import { IRandomService } from '../../browser/randomService.js';
import { IEditSourcesDetailsTelemetryData } from '../../browser/telemetry/editSourceTelemetry.js';
import { UnifiedEditSourceTracking } from '../../browser/telemetry/unifiedEditSourceTracking.js';

suite('Unified Edit Source Tracking', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('emits mixed local and Agent Host details once per long-term window', async () => {
		const context = createContext('base');
		const resource = context.document.uri;
		await context.tracking.applyAgentEdit({
			resource,
			before: 'base',
			after: 'baseA',
			source: agentSource(),
			correlation: 'tool-1',
			kind: 'edit',
		});
		context.document.apply(StringEditWithReason.replace(new OffsetRange(4, 4), 'A', EditSources.reloadFromDisk()));
		context.setDirty(true);
		context.document.apply(StringEditWithReason.replace(new OffsetRange(5, 5), 'U', EditSources.cursor({ kind: 'type' })));

		const first = await context.tracking.flushLongTermDetails(resource, 'hashChange', 'typescript', 'stats-1');
		const second = await context.tracking.flushLongTermDetails(resource, 'hashChange', 'typescript', 'stats-2');

		assert.deepStrictEqual({
			first,
			second,
			events: context.details.map(event => ({
				sourceKey: event.sourceKey,
				trigger: event.trigger,
				languageId: event.languageId,
				statsUuid: event.statsUuid,
				origin: event.origin,
				harness: event.harness,
				modifiedCount: event.modifiedCount,
				deltaModifiedCount: event.deltaModifiedCount,
				totalModifiedCount: event.totalModifiedCount,
			})),
		}, {
			first: {
				totalModifiedCount: 2,
				rows: [
					{
						sourceKey: 'source:Chat.applyEdits-$modelId:model-$harness:copilotcli-$origin:agentHost',
						cleanedSourceKey: 'source:Chat.applyEdits-$harness:copilotcli-$origin:agentHost',
						extensionId: undefined,
						extensionVersion: undefined,
						modelId: 'model',
						conversationId: 'session',
						requestId: 'request',
						origin: 'agentHost',
						harness: 'copilotcli',
						modifiedCount: 1,
						deltaModifiedCount: 1,
					},
					{
						sourceKey: 'source:cursor-kind:type',
						cleanedSourceKey: 'source:cursor-kind:type',
						extensionId: undefined,
						extensionVersion: undefined,
						modelId: undefined,
						conversationId: undefined,
						requestId: undefined,
						origin: undefined,
						harness: undefined,
						modifiedCount: 1,
						deltaModifiedCount: 1,
					},
				],
			},
			second: undefined,
			events: [
				{
					sourceKey: 'source:Chat.applyEdits-$modelId:model-$harness:copilotcli-$origin:agentHost',
					trigger: 'hashChange',
					languageId: 'typescript',
					statsUuid: 'stats-1',
					origin: 'agentHost',
					harness: 'copilotcli',
					modifiedCount: 1,
					deltaModifiedCount: 1,
					totalModifiedCount: 2,
				},
				{
					sourceKey: 'source:cursor-kind:type',
					trigger: 'hashChange',
					languageId: 'typescript',
					statsUuid: 'stats-1',
					origin: undefined,
					harness: undefined,
					modifiedCount: 1,
					deltaModifiedCount: 1,
					totalModifiedCount: 2,
				},
			],
		});
		context.disposables.dispose();
	});

	test('reconciles the current disk snapshot before emitting retained counts', async () => {
		const context = createContext('base');
		const resource = context.document.uri;
		await context.tracking.applyAgentEdit({
			resource,
			before: 'base',
			after: 'baseABCDEFGHIJ',
			source: agentSource(),
			correlation: 'tool-1',
			kind: 'edit',
		});
		context.document.apply(StringEditWithReason.replace(new OffsetRange(4, 4), 'ABCDEFGHIJ', EditSources.reloadFromDisk()));
		context.setDiskContent('baseABC');

		await context.tracking.flushLongTermDetails(resource, 'hashChange', 'typescript', 'stats-1');

		const agentEvent = context.details.find(event => event.origin === 'agentHost');
		assert.deepStrictEqual(agentEvent && {
			sourceKey: agentEvent.sourceKey,
			modifiedCount: agentEvent.modifiedCount,
			deltaModifiedCount: agentEvent.deltaModifiedCount,
			totalModifiedCount: agentEvent.totalModifiedCount,
		}, {
			sourceKey: 'source:Chat.applyEdits-$modelId:model-$harness:copilotcli-$origin:agentHost',
			modifiedCount: 3,
			deltaModifiedCount: 10,
			totalModifiedCount: 3,
		});
		context.disposables.dispose();
	});

	test('preserves exact model insertion counts without snapshot diffing', async () => {
		const context = createContext('base');
		context.setDirty(true);
		context.document.apply(StringEditWithReason.replace(
			OffsetRange.emptyAt(4),
			'ABCDEFGHIJ',
			EditSources.cursor({ kind: 'type' }),
		));

		await context.tracking.flushLongTermDetails(context.document.uri, 'hashChange', 'typescript', 'stats-1');

		assert.deepStrictEqual(context.details.map(event => ({
			sourceKey: event.sourceKey,
			modifiedCount: event.modifiedCount,
			deltaModifiedCount: event.deltaModifiedCount,
			totalModifiedCount: event.totalModifiedCount,
		})), [{
			sourceKey: 'source:cursor-kind:type',
			modifiedCount: 10,
			deltaModifiedCount: 10,
			totalModifiedCount: 10,
		}]);
		context.disposables.dispose();
	});

	test('waits for a pending reload to be attributed before flushing', async () => {
		const context = createContext('before');
		const resource = context.document.uri;
		context.document.apply(StringEditWithReason.replace(OffsetRange.ofLength(6), 'after', EditSources.reloadFromDisk()));

		const pending = await context.tracking.flushLongTermDetails(resource, 'hashChange', 'typescript');
		await context.tracking.applyAgentEdit({
			resource,
			before: 'before',
			after: 'after',
			source: agentSource(),
			correlation: 'tool-1',
			kind: 'edit',
		});
		context.setDiskContent('after');
		const attributed = await context.tracking.flushLongTermDetails(resource, 'hashChange', 'typescript', 'stats-1');

		assert.deepStrictEqual({
			pending,
			attributed: attributed?.rows.map(row => ({
				sourceKey: row.sourceKey,
				modifiedCount: row.modifiedCount,
			})),
			eventCount: context.details.length,
		}, {
			pending: undefined,
			attributed: [{
				sourceKey: 'source:Chat.applyEdits-$modelId:model-$harness:copilotcli-$origin:agentHost',
				modifiedCount: 5,
			}],
			eventCount: 1,
		});
		context.disposables.dispose();
	});

	test('waits for a late Agent Host transition chain before flushing', async () => {
		const context = createContext('a');
		const resource = context.document.uri;
		context.document.apply(StringEditWithReason.replace(OffsetRange.ofLength(1), 'abc', EditSources.reloadFromDisk()));
		context.setDiskContent('abc');
		await context.tracking.applyDiskSnapshot(resource, 'abc');
		await context.tracking.applyAgentEdit({
			resource,
			before: 'a',
			after: 'ab',
			source: agentSource(),
			correlation: 'tool-1',
			kind: 'edit',
		});

		const pending = await context.tracking.flushLongTermDetails(resource, 'hashChange', 'typescript');
		const pendingSnapshot = context.tracking.getSnapshot(resource);
		await context.tracking.applyAgentEdit({
			resource,
			before: 'ab',
			after: 'abc',
			source: agentSource(),
			correlation: 'tool-2',
			kind: 'edit',
		});
		const attributed = await context.tracking.flushLongTermDetails(resource, 'hashChange', 'typescript', 'stats-1');

		assert.deepStrictEqual({
			pending,
			pendingAgentTransitions: pendingSnapshot?.pendingAgentTransitions,
			pendingTransitionKinds: pendingSnapshot?.transitions.map(transition => transition.kind),
			attributed: attributed?.rows.map(row => ({
				sourceKey: row.sourceKey,
				modifiedCount: row.modifiedCount,
			})),
			eventCount: context.details.length,
		}, {
			pending: undefined,
			pendingAgentTransitions: true,
			pendingTransitionKinds: ['reloadFromDisk'],
			attributed: [{
				sourceKey: 'source:Chat.applyEdits-$modelId:model-$harness:copilotcli-$origin:agentHost',
				modifiedCount: 2,
			}],
			eventCount: 1,
		});
		context.disposables.dispose();
	});

	test('rebuilds live attribution when Agent Host claims a committed reload late', async () => {
		const context = createContext('before');
		const resource = context.document.uri;
		context.document.apply(StringEditWithReason.replace(OffsetRange.ofLength(6), 'after', EditSources.reloadFromDisk()));
		context.setDirty(true);
		context.document.apply(StringEditWithReason.replace(
			OffsetRange.emptyAt(5),
			' user',
			EditSources.cursor({ kind: 'type' }),
		));
		await context.tracking.applyAgentEdit({
			resource,
			before: 'before',
			after: 'after',
			source: agentSource(),
			correlation: 'tool-1',
			kind: 'edit',
		});

		await context.tracking.flushLongTermDetails(resource, 'hashChange', 'typescript', 'stats-1');

		assert.deepStrictEqual(context.details.map(event => ({
			sourceKey: event.sourceKey,
			modifiedCount: event.modifiedCount,
			deltaModifiedCount: event.deltaModifiedCount,
		})), [
			{
				sourceKey: 'source:Chat.applyEdits-$modelId:model-$harness:copilotcli-$origin:agentHost',
				modifiedCount: 5,
				deltaModifiedCount: 5,
			},
			{
				sourceKey: 'source:cursor-kind:type',
				modifiedCount: 5,
				deltaModifiedCount: 5,
			},
		]);
		context.disposables.dispose();
	});

	test('emits only the top thirty retained sources in descending order', async () => {
		const context = createContext('');
		context.setDirty(true);
		for (let i = 1; i <= 31; i++) {
			const content = 'x'.repeat(i);
			context.document.apply(StringEditWithReason.replace(
				OffsetRange.emptyAt(context.document.value.get().value.length),
				content,
				EditSources.unknown({ name: `source-${i}` }),
			));
		}

		await context.tracking.flushLongTermDetails(context.document.uri, 'hashChange', 'typescript');

		assert.deepStrictEqual({
			count: context.details.length,
			first: context.details[0]?.sourceKey,
			last: context.details.at(-1)?.sourceKey,
			containsSmallest: context.details.some(event => event.sourceKey === 'source:unknown-name:source-1'),
		}, {
			count: 30,
			first: 'source:unknown-name:source-31',
			last: 'source:unknown-name:source-2',
			containsSmallest: false,
		});
		context.disposables.dispose();
	});

	test('resets compact edits and the live tracker after every flush', async () => {
		const context = createContext('base');
		context.setDirty(true);
		for (let i = 0; i < 100; i++) {
			context.document.apply(StringEditWithReason.replace(
				OffsetRange.emptyAt(context.document.value.get().value.length),
				'x',
				EditSources.cursor({ kind: 'type' }),
			));
		}

		await context.tracking.flushLongTermDetails(context.document.uri, 'hashChange', 'typescript');

		assert.deepStrictEqual({
			transitionCount: context.tracking.getSnapshot(context.document.uri)?.transitions.length,
			trackedSources: context.tracking.project(context.document.uri)?.sources,
			contentLength: context.tracking.getSnapshot(context.document.uri)?.content.length,
		}, {
			transitionCount: 0,
			trackedSources: [],
			contentLength: 104,
		});
		context.disposables.dispose();
	});

	test('does not transfer tracker state when a rename destination conflicts', async () => {
		const context = createContext('content');
		const previousResource = context.document.uri;
		const resource = URI.file('C:\\repo\\existing.ts');
		await context.tracking.applyDiskSnapshot(resource, 'existing');

		const result = await context.tracking.applyAgentEdit({
			resource,
			previousResource,
			before: 'content',
			after: 'content',
			source: agentSource(),
			correlation: 'rename-1',
			kind: 'rename',
		});

		assert.deepStrictEqual({
			transferOutcome: result.transferResult?.outcome,
			previousContent: context.tracking.getSnapshot(previousResource)?.content,
			existingContent: context.tracking.getSnapshot(resource)?.content,
			previousTracked: !!context.tracking.project(previousResource),
			existingTracked: !!context.tracking.project(resource),
		}, {
			transferOutcome: 'conflict',
			previousContent: 'content',
			existingContent: 'existing',
			previousTracked: true,
			existingTracked: true,
		});
		context.disposables.dispose();
	});

	test('keeps a resource until local and Agent Host ownership end', async () => {
		const context = createContext('content');
		const resource = context.document.uri;
		context.tracking.retainLocalLongTermResource(resource);
		context.tracking.retainAgentResource(resource);
		context.workspace.setDocuments([]);
		await Promise.resolve();
		const whileRetained = !!context.tracking.getSnapshot(resource);

		context.tracking.releaseLocalLongTermResource(resource);
		context.tracking.releaseAgentResource(resource);
		await Promise.resolve();

		assert.deepStrictEqual({
			whileRetained,
			afterRelease: context.tracking.getSnapshot(resource),
		}, {
			whileRetained: true,
			afterRelease: undefined,
		});
		context.disposables.dispose();
	});
});

function createContext(initialContent: string) {
	const disposables = new DisposableStore();
	const workspace = new TestWorkspace();
	const document = disposables.add(new TestObservableDocument(initialContent));
	workspace.setDocuments([document]);
	const details: IEditSourcesDetailsTelemetryData[] = [];
	let dirty = false;
	let diskContent = initialContent;
	let uuid = 0;
	const instantiationService = disposables.add(new TestInstantiationService(new ServiceCollection(), false, undefined, true));
	instantiationService.stub(IFileService, {
		hasProvider: () => true,
		readFile: async resource => {
			const value = VSBuffer.fromString(diskContent);
			return {
				resource,
				name: 'file.ts',
				size: value.byteLength,
				mtime: 0,
				ctime: 0,
				etag: '',
				readonly: false,
				locked: false,
				executable: false,
				value,
			};
		},
	});
	instantiationService.stub(ITextFileService, { isDirty: () => dirty });
	instantiationService.stub(IUriIdentityService, { extUri, asCanonicalUri: resource => resource });
	instantiationService.stub(IEditorWorkerService, {
		computeStringEditFromDiff: (original, modified) => computeStringDiff(original, modified, { maxComputationTimeMs: 500 }, 'advanced'),
	});
	instantiationService.stub(IRandomService, {
		_serviceBrand: undefined,
		generateUuid: () => `stats-${++uuid}`,
		generatePrefixedUuid: namespace => `${namespace}-${++uuid}`,
	});
	instantiationService.stub(ITelemetryService, {
		publicLog2(eventName, data) {
			if (eventName === 'editTelemetry.editSources.details') {
				details.push(data as IEditSourcesDetailsTelemetryData);
			}
		},
	});
	instantiationService.stub(ILogService, new NullLogService());
	const tracking = disposables.add(instantiationService.createInstance(UnifiedEditSourceTracking, workspace));
	return {
		disposables,
		workspace,
		document,
		tracking,
		details,
		setDirty(value: boolean) {
			dirty = value;
		},
		setDiskContent(value: string) {
			diskContent = value;
		},
	};
}

function agentSource(): TextModelEditSource {
	return EditSources.chatApplyEdits({
		modelId: 'model',
		sessionId: 'session',
		requestId: 'request',
		languageId: 'typescript',
		mode: 'agent',
		extensionId: undefined,
		codeBlockSuggestionId: undefined,
		harness: 'copilotcli',
		origin: 'agentHost',
	});
}

class TestWorkspace extends ObservableWorkspace {
	private readonly _documents = observableValue<readonly IObservableDocument[]>(this, []);
	override readonly documents: IObservable<readonly IObservableDocument[]> = this._documents;

	setDocuments(documents: readonly IObservableDocument[]): void {
		this._documents.set(documents, undefined);
	}
}

class TestObservableDocument extends Disposable implements IObservableDocument {
	private readonly _value: ISettableObservable<StringText, StringEditWithReason>;
	readonly value: IObservableWithChange<StringText, StringEditWithReason>;
	readonly version: IObservable<number>;
	readonly languageId: IObservable<string>;

	constructor(initialContent: string, readonly uri = URI.file('C:\\repo\\file.ts')) {
		super();
		this.value = this._value = observableValue(this, new StringText(initialContent));
		this.version = observableValue(this, 1);
		this.languageId = observableValue(this, 'typescript');
	}

	apply(edit: StringEditWithReason): void {
		this._value.set(edit.applyOnText(this._value.get()), undefined, edit);
	}
}
