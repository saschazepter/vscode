/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IObservable, IObservableWithChange, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { StringText } from '../../../../../editor/common/core/text/abstractText.js';
import { OffsetRange } from '../../../../../editor/common/core/ranges/offsetRange.js';
import { EditSources, TextModelEditSource } from '../../../../../editor/common/textModelEditSource.js';
import {
	applyUnifiedDocumentAgentEdit,
	IUnifiedDocumentModelAdapterResult,
	UnifiedDocumentModelAdapter,
} from '../../browser/helpers/unifiedDocumentAdapters.js';
import { createMinimalEdit } from '../../browser/helpers/unifiedDocumentReconciler.js';
import { IObservableDocument, StringEditWithReason } from '../../browser/helpers/observableWorkspace.js';
import { UnifiedDocumentRegistry } from '../../browser/helpers/unifiedDocumentRegistry.js';

suite('Unified Document Adapters', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('translates model lifecycle and attributed edits', () => {
		const disposables = new DisposableStore();
		const registry = createRegistry();
		const document = disposables.add(new TestObservableDocument('before'));
		let dirty = false;
		const results: IUnifiedDocumentModelAdapterResult<TextModelEditSource>[] = [];
		const adapter = disposables.add(new UnifiedDocumentModelAdapter(
			registry,
			document,
			'before',
			() => dirty,
			change => change.reason,
			result => results.push(result),
		));

		dirty = true;
		document.apply(StringEditWithReason.replace(OffsetRange.ofLength(6), 'after', EditSources.cursor({ kind: 'type' })));
		adapter.dispose();

		assert.deepStrictEqual(
			{
				inputs: results.map(result => result.inputKind),
				outcomes: results.map(result => result.result.outcome),
				model: registry.get(document.uri)?.reconciler.getSnapshot().model,
				sources: registry.get(document.uri)?.reconciler.getSnapshot().transitions.map(transition => transition.source.metadata.source),
			},
			{
				inputs: ['connected', 'edit', 'disconnected'],
				outcomes: ['applied', 'applied', 'applied'],
				model: undefined,
				sources: ['cursor'],
			},
		);
		disposables.dispose();
	});

	test('deduplicates an Agent Host edit followed by model reload', () => {
		const disposables = new DisposableStore();
		const registry = createRegistry();
		const resource = URI.file('C:\\repo\\file.ts');
		const agentResult = applyUnifiedDocumentAgentEdit(registry, {
			resource,
			before: 'before',
			after: 'after',
			edit: createMinimalEdit('before', 'after'),
			source: agentSource(),
			correlation: 'tool-1',
			kind: 'edit',
		});
		const document = disposables.add(new TestObservableDocument('before', resource));
		const results: IUnifiedDocumentModelAdapterResult<TextModelEditSource>[] = [];
		disposables.add(new UnifiedDocumentModelAdapter(
			registry,
			document,
			'before',
			() => false,
			change => change.reason,
			result => results.push(result),
		));

		document.apply(StringEditWithReason.replace(OffsetRange.ofLength(6), 'after', EditSources.reloadFromDisk()));

		assert.deepStrictEqual(
			{
				agentOutcome: agentResult.transitionResult.outcome,
				modelOutcomes: results.map(result => result.result.outcome),
				transitions: registry.get(resource)?.reconciler.getSnapshot().transitions.map(transition => ({
					kind: transition.kind,
					source: transition.source.metadata.source,
				})),
			},
			{
				agentOutcome: 'applied',
				modelOutcomes: ['applied', 'duplicate'],
				transitions: [{ kind: 'agentHost', source: 'Chat.applyEdits' }],
			},
		);
		disposables.dispose();
	});

	test('transfers registry identity for Agent Host rename', () => {
		const registry = createRegistry();
		const previousResource = URI.file('C:\\repo\\before.ts');
		const resource = URI.file('C:\\repo\\after.ts');
		registry.diskSnapshot(previousResource, 'content', createMinimalEdit('content', 'content'));
		const reconciler = registry.get(previousResource)?.reconciler;

		const result = applyUnifiedDocumentAgentEdit(registry, {
			resource,
			previousResource,
			before: 'content',
			after: 'content',
			edit: createMinimalEdit('content', 'content'),
			source: agentSource(),
			correlation: 'rename-1',
			kind: 'rename',
		});

		assert.deepStrictEqual(
			{
				transitionOutcome: result.transitionResult.outcome,
				transferOutcome: result.transferResult?.outcome,
				oldEntry: registry.get(previousResource),
				sameReconciler: registry.get(resource)?.reconciler === reconciler,
			},
			{
				transitionOutcome: 'applied',
				transferOutcome: 'applied',
				oldEntry: undefined,
				sameReconciler: true,
			},
		);
	});

	test('does not transfer a dirty rename conflict', () => {
		const registry = createRegistry();
		const previousResource = URI.file('C:\\repo\\before.ts');
		const resource = URI.file('C:\\repo\\after.ts');
		registry.modelConnected(previousResource, 'content', { content: 'dirty content', dirty: true });

		const result = applyUnifiedDocumentAgentEdit(registry, {
			resource,
			previousResource,
			before: 'content',
			after: 'content',
			edit: createMinimalEdit('content', 'content'),
			source: agentSource(),
			correlation: 'rename-1',
			kind: 'rename',
		});

		assert.deepStrictEqual(
			{
				transitionOutcome: result.transitionResult.outcome,
				transferResult: result.transferResult,
				oldEntryExists: !!registry.get(previousResource),
				newEntry: registry.get(resource),
			},
			{
				transitionOutcome: 'skippedDirty',
				transferResult: undefined,
				oldEntryExists: true,
				newEntry: undefined,
			},
		);
	});
});

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

function createRegistry(): UnifiedDocumentRegistry<TextModelEditSource> {
	return new UnifiedDocumentRegistry({
		externalSource: EditSources.reloadFromDisk(),
		canonicalize: resource => resource.with({ path: resource.path.toLowerCase() }),
		getComparisonKey: resource => resource.toString().toLowerCase(),
	});
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
