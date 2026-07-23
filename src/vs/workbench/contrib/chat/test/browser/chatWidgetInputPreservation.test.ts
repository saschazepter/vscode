/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Range } from '../../../../../editor/common/core/range.js';
import { OffsetRange } from '../../../../../editor/common/core/ranges/offsetRange.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IChatWidget, setModelPreservingInputTypedWhileLoading } from '../../browser/chat.js';
import { ChatAgentLocation } from '../../common/constants.js';
import { ChatRequestSlashCommandPart, ChatRequestTextPart, IParsedChatRequest } from '../../common/requestParser/chatParserTypes.js';
import { getImmediateSlashCommandPart } from '../../browser/widget/chatWidget.js';

suite('setModelPreservingInputTypedWhileLoading', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * A minimal fake that models just the input editor of a chat widget. `bind`
	 * simulates the model binding resetting the editor to the session's own draft
	 * (mirroring `_syncFromModel` calling `setValue(state.inputText || '')`).
	 */
	class FakeInputWidget {
		constructor(private input: string, private readonly boundDraft: string) { }
		getInput(): string { return this.input; }
		setInput(query?: string): void { this.input = query ?? ''; }
		bind(): void { this.input = this.boundDraft; }
		asWidget(): IChatWidget { return this as unknown as IChatWidget; }
	}

	test('restores text typed during load onto an empty session', () => {
		const widget = new FakeInputWidget(/* initial */ '', /* boundDraft */ '');
		const inputBeforeLoad = widget.getInput(); // '' - editor was empty when load started
		widget.setInput('the'); // user types while loading

		setModelPreservingInputTypedWhileLoading(widget.asWidget(), inputBeforeLoad, () => widget.bind());

		assert.strictEqual(widget.getInput(), 'the');
	});

	test('does not clobber the loaded session\'s own persisted draft', () => {
		const widget = new FakeInputWidget('', 'session draft');
		const inputBeforeLoad = widget.getInput();
		widget.setInput('the'); // user types while loading

		setModelPreservingInputTypedWhileLoading(widget.asWidget(), inputBeforeLoad, () => widget.bind());

		assert.strictEqual(widget.getInput(), 'session draft');
	});

	test('does not carry a previous session\'s leftover draft over on a plain switch', () => {
		// Editor still holds the previous session's draft and the user did NOT type.
		const widget = new FakeInputWidget('previous draft', '');
		const inputBeforeLoad = widget.getInput(); // 'previous draft' == current input (no typing)

		setModelPreservingInputTypedWhileLoading(widget.asWidget(), inputBeforeLoad, () => widget.bind());

		assert.strictEqual(widget.getInput(), '');
	});

	test('identifies only leading execute-immediately slash commands', () => {
		const command = new ChatRequestSlashCommandPart(
			new OffsetRange(0, 7),
			new Range(1, 1, 1, 8),
			{
				command: 'models',
				detail: 'Open models',
				executeImmediately: true,
				locations: [ChatAgentLocation.Chat],
			},
		);
		const delayedCommand = new ChatRequestSlashCommandPart(
			new OffsetRange(0, 7),
			new Range(1, 1, 1, 8),
			{
				command: 'rename',
				detail: 'Rename chat',
				executeImmediately: false,
				locations: [ChatAgentLocation.Chat],
			},
		);
		const prefix = new ChatRequestTextPart(new OffsetRange(0, 1), new Range(1, 1, 1, 2), ' ');
		const shiftedCommand = new ChatRequestSlashCommandPart(
			new OffsetRange(1, 8),
			new Range(1, 2, 1, 9),
			command.slashCommand,
		);

		assert.deepStrictEqual([
			getImmediateSlashCommandPart({ text: '/models', parts: [command] } satisfies IParsedChatRequest)?.slashCommand.command,
			getImmediateSlashCommandPart({ text: '/rename', parts: [delayedCommand] } satisfies IParsedChatRequest)?.slashCommand.command,
			getImmediateSlashCommandPart({ text: ' /models', parts: [prefix, shiftedCommand] } satisfies IParsedChatRequest)?.slashCommand.command,
		], [
			'models',
			undefined,
			undefined,
		]);
	});
});
