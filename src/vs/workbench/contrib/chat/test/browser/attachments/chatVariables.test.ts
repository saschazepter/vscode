/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import { IDynamicVariable, toAttachedContextDynamicVariable } from '../../../common/attachments/chatVariables.js';
import { IChatWidget } from '../../../browser/chat.js';
import { applyPromptAttachmentReferences, getDynamicVariablesForWidget, getSelectedToolAndToolSetsForWidget, isReferenceToExistingAttachment } from '../../../browser/attachments/chatVariables.js';
import { ChatDynamicVariableModel } from '../../../browser/attachments/chatDynamicVariables.js';
import { ChatRequestVariableSet, IChatRequestVariableEntry } from '../../../common/attachments/chatVariableEntries.js';
import { IToolData, ToolDataSource, ToolAndToolSetEnablementMap } from '../../../common/tools/languageModelToolsService.js';
import { observableValue } from '../../../../../../base/common/observable.js';
import { ChatRequestDynamicVariablePart } from '../../../common/requestParser/chatParserTypes.js';
import { OffsetRange } from '../../../../../../editor/common/core/ranges/offsetRange.js';

function createMockVariable(overrides?: Partial<IDynamicVariable>): IDynamicVariable {
	return {
		id: 'var-1',
		fullName: 'test-var',
		range: new Range(1, 1, 1, 10),
		data: 'test-data',
		...overrides,
	};
}

function createMockAttachment(overrides?: Partial<IChatRequestVariableEntry>): IChatRequestVariableEntry {
	return {
		id: 'attach-1',
		name: 'test-attachment',
		kind: 'file',
		value: 'test-value',
		...overrides,
	} as IChatRequestVariableEntry;
}

function createMockWidget(options: {
	hasViewModel?: boolean;
	supportsFileReferences?: boolean;
	contribVariables?: IDynamicVariable[];
	editing?: boolean;
	attachments?: IChatRequestVariableEntry[];
	editorTextLength?: number;
}): IChatWidget {
	const {
		hasViewModel = true,
		supportsFileReferences = true,
		contribVariables = [],
		editing = false,
		attachments = [],
		editorTextLength = 100,
	} = options;

	const contribModel = {
		id: ChatDynamicVariableModel.ID,
		variables: contribVariables,
	};

	return {
		viewModel: hasViewModel ? { editing: editing ? {} : undefined } : undefined,
		supportsFileReferences,
		getContrib: (id: string) => id === ChatDynamicVariableModel.ID ? contribModel : undefined,
		input: {
			attachmentModel: { attachments },
		},
		inputEditor: {
			getModel: () => ({
				getValueLength: () => editorTextLength,
				getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
			}),
		},
	} as unknown as IChatWidget;
}

suite('getDynamicVariablesForWidget', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns empty when no viewModel', () => {
		const widget = createMockWidget({ hasViewModel: false });
		assert.deepStrictEqual(getDynamicVariablesForWidget(widget), []);
	});

	test('returns empty when file references not supported', () => {
		const widget = createMockWidget({ supportsFileReferences: false });
		assert.deepStrictEqual(getDynamicVariablesForWidget(widget), []);
	});

	test('returns contrib model variables when not editing', () => {
		const variables = [createMockVariable()];
		const widget = createMockWidget({ contribVariables: variables });
		assert.deepStrictEqual(getDynamicVariablesForWidget(widget), variables);
	});

	test('returns contrib model variables when editing with existing variables', () => {
		const variables = [createMockVariable()];
		const widget = createMockWidget({ editing: true, contribVariables: variables });
		assert.deepStrictEqual(getDynamicVariablesForWidget(widget), variables);
	});

	test('converts attachments to dynamic variables when editing with attachments and no contrib variables', () => {
		const attachments = [
			createMockAttachment({
				id: 'a1',
				name: 'file.ts',
				kind: 'file',
				value: 'file-value',
				range: { start: 0, endExclusive: 8 },
			}),
		];
		const widget = createMockWidget({ editing: true, attachments, contribVariables: [] });
		const result = getDynamicVariablesForWidget(widget);

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].id, 'a1');
		assert.strictEqual(result[0].fullName, 'file.ts');
		assert.strictEqual(result[0].isFile, true);
		assert.strictEqual(result[0].isDirectory, false);
		assert.strictEqual(result[0].data, 'file-value');
	});

	test('skips attachments without range when editing', () => {
		const attachments = [createMockAttachment({ range: undefined })];
		const widget = createMockWidget({ editing: true, attachments, contribVariables: [] });
		const result = getDynamicVariablesForWidget(widget);

		// No ranged attachments, falls back to contrib model variables (empty)
		assert.deepStrictEqual(result, []);
	});

	test('skips attachments with empty range', () => {
		const attachments = [createMockAttachment({ range: { start: 5, endExclusive: 5 } })];
		const widget = createMockWidget({ editing: true, attachments, contribVariables: [] });
		const result = getDynamicVariablesForWidget(widget);
		assert.deepStrictEqual(result, []);
	});

	test('skips attachments with out-of-bounds range', () => {
		const attachments = [createMockAttachment({ range: { start: 0, endExclusive: 200 } })];
		const widget = createMockWidget({ editing: true, attachments, editorTextLength: 100, contribVariables: [] });
		const result = getDynamicVariablesForWidget(widget);
		assert.deepStrictEqual(result, []);
	});

	test('skips attachments with negative start', () => {
		const attachments = [createMockAttachment({ range: { start: -1, endExclusive: 5 } })];
		const widget = createMockWidget({ editing: true, attachments, contribVariables: [] });
		const result = getDynamicVariablesForWidget(widget);
		assert.deepStrictEqual(result, []);
	});

	test('sets isDirectory for directory attachments', () => {
		const attachments = [
			createMockAttachment({
				kind: 'directory',
				range: { start: 0, endExclusive: 5 },
			}),
		];
		const widget = createMockWidget({ editing: true, attachments, contribVariables: [] });
		const result = getDynamicVariablesForWidget(widget);

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].isFile, false);
		assert.strictEqual(result[0].isDirectory, true);
	});
});

suite('getSelectedToolAndToolSetsForWidget', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns the entriesMap from the selected tools model', () => {
		const toolData: IToolData = {
			id: 'tool-1',
			toolReferenceName: 'myTool',
			displayName: 'My Tool',
			modelDescription: 'A test tool',
			canBeReferencedInPrompt: true,
			source: ToolDataSource.Internal,
		};
		const expectedMap = ToolAndToolSetEnablementMap.fromEntries([[toolData, true]]);
		const entriesMap = observableValue('test', expectedMap);

		const widget = {
			input: {
				selectedToolsModel: { entriesMap },
			},
		} as unknown as IChatWidget;

		const result = getSelectedToolAndToolSetsForWidget(widget);
		assert.strictEqual(result, expectedMap);
	});
});

suite('applyPromptAttachmentReferences', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('identifies mentions of existing attachments without changing them', () => {
		const attachment = createMockAttachment();
		const reference = { ...attachment, range: { start: 7, endExclusive: 24 } };

		assert.deepStrictEqual({
			isReference: isReferenceToExistingAttachment(reference, [attachment]),
			attachmentRange: attachment.range,
		}, {
			isReference: true,
			attachmentRange: undefined,
		});
	});

	test('keeps large attachment payloads out of inline reference state', () => {
		const attachment = createMockAttachment({
			kind: 'image',
			value: new Uint8Array(1024 * 1024),
		});
		const reference = toAttachedContextDynamicVariable(attachment, new Range(1, 1, 1, 20));

		assert.deepStrictEqual({
			data: reference.data,
			attachment: reference.attachment,
			hasCompactSerializedState: JSON.stringify(reference).length < 500,
		}, {
			data: undefined,
			attachment: undefined,
			hasCompactSerializedState: true,
		});
	});

	test('applies the prompt range to a request copy while preserving the attachment', () => {
		const imageData = new Uint8Array([1, 2, 3]);
		const attachment = createMockAttachment({
			id: 'attach-1',
			name: 'screenshot.png',
			kind: 'image',
			value: imageData,
			mimeType: 'image/png',
			references: [{ reference: URI.file('/screenshot.png'), kind: 'reference' }],
		});
		const context = new ChatRequestVariableSet([attachment]);
		const part = new ChatRequestDynamicVariablePart(
			new OffsetRange(7, 24),
			new Range(1, 8, 1, 25),
			'#attachment:screenshot.png',
			attachment.id,
			attachment.modelDescription,
			undefined,
			attachment.name,
			attachment.icon,
		);

		applyPromptAttachmentReferences(context, [part]);

		const requestAttachment = context.asArray()[0];
		assert.deepStrictEqual({
			attachmentRange: attachment.range,
			requestKind: requestAttachment.kind,
			requestValue: requestAttachment.value,
			requestMimeType: requestAttachment.kind === 'image' ? requestAttachment.mimeType : undefined,
			requestReferences: requestAttachment.references,
			requestRange: requestAttachment.range && { start: requestAttachment.range.start, endExclusive: requestAttachment.range.endExclusive },
		}, {
			attachmentRange: undefined,
			requestKind: 'image',
			requestValue: imageData,
			requestMimeType: 'image/png',
			requestReferences: [{ reference: URI.file('/screenshot.png'), kind: 'reference' }],
			requestRange: { start: 7, endExclusive: 24 },
		});
	});
});
