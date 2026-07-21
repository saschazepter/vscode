/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { OutlineTarget } from '../../../../services/outline/browser/outline.js';
import { buildResponseChildren, ChatOutline, ChatOutlineEntryKind, getChatRequestLabel } from '../../browser/chatOutline.js';
import { ChatTreeItem, IChatWidget } from '../../browser/chat.js';
import { IChatRequestViewModel, IChatResponseViewModel } from '../../common/model/chatViewModel.js';
import { IChatRequestVariableEntry } from '../../common/attachments/chatVariableEntries.js';

function req(message: object, variables: IChatRequestVariableEntry[] = []): IChatRequestViewModel {
	return { id: 'r', message, variables } as unknown as IChatRequestViewModel;
}

function reqVM(id: string, text: string): IChatRequestViewModel {
	return { id, message: { text, parts: [{ text }] }, variables: [] } as unknown as IChatRequestViewModel;
}

function respVM(id: string, value: object[]): IChatResponseViewModel {
	// `setVote` presence is what `isResponseVM` keys off.
	return { id, setVote: () => { }, response: { value } } as unknown as IChatResponseViewModel;
}

class TestViewModel {
	readonly onChange = new Emitter<null>();
	readonly onDidChange: Event<null> = this.onChange.event;
	readonly sessionResource = URI.parse('chat-session:/test');
	items: ChatTreeItem[] = [];
	getItems(): ChatTreeItem[] {
		return this.items;
	}
}

class TestWidget {
	readonly onChangeVM = new Emitter<void>();
	readonly onDidChangeViewModel: Event<void> = this.onChangeVM.event;
	focusItem: ChatTreeItem | undefined;
	readonly revealed: ChatTreeItem[] = [];
	readonly focused: ChatTreeItem[] = [];
	constructor(readonly viewModel: TestViewModel) { }
	getFocus(): ChatTreeItem | undefined {
		return this.focusItem;
	}
	reveal(item: ChatTreeItem): void {
		this.revealed.push(item);
	}
	focus(item: ChatTreeItem): void {
		this.focused.push(item);
	}
}

function setup(store: Pick<DisposableStore, 'add'>, items: ChatTreeItem[]) {
	const viewModel = new TestViewModel();
	viewModel.items = items;
	store.add(viewModel.onChange);
	const widget = new TestWidget(viewModel);
	store.add(widget.onChangeVM);
	const outline = store.add(new ChatOutline(widget as unknown as IChatWidget, OutlineTarget.QuickPick));
	return { viewModel, widget, outline };
}

suite('ChatOutline', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('getChatRequestLabel derives text, parts, followup, and attachment fallbacks', () => {
		const labels = [
			getChatRequestLabel(req({ text: 'hello world', parts: [{ text: 'hello world' }] }), 0),
			getChatRequestLabel(req({ text: '', parts: [{ text: 'what ' }, { text: 'is ' }, { text: 'this' }] }), 1),
			getChatRequestLabel(req({ kind: 'reply', message: 'do the thing', agentId: 'agent' }), 2),
			getChatRequestLabel(req({ text: '', parts: [] }, [{ kind: 'file' } as unknown as IChatRequestVariableEntry]), 3),
			getChatRequestLabel(req({ text: '', parts: [] }, [{ kind: 'image' } as unknown as IChatRequestVariableEntry]), 4),
			getChatRequestLabel(req({ text: '', parts: [] }), 5),
			getChatRequestLabel(req({ text: 'line1\n\nline2', parts: [{ text: 'line1\n\nline2' }] }), 6),
		];

		assert.deepStrictEqual(labels, [
			'hello world',
			'what is this',
			'do the thing',
			'Attached 1 file',
			'Attached 1 image',
			'Request 6',
			'line1 line2',
		]);
	});

	test('buildResponseChildren extracts headings and file edits in order', () => {
		let sortIndex = 0;
		const response = respVM('resp1', [
			{ kind: 'markdownContent', content: { value: '# Title\n\nsome text\n\n## Section' } },
			{ kind: 'textEditGroup', uri: URI.file('/a/foo.ts') },
			{ kind: 'workspaceEdit', edits: [{ newResource: URI.file('/a/bar.ts') }] },
		]);

		const children = buildResponseChildren(response, () => sortIndex++);

		assert.deepStrictEqual(children.map(child => ({ label: child.label, kind: child.kind })), [
			{ label: 'Title', kind: ChatOutlineEntryKind.Heading },
			{ label: 'Section', kind: ChatOutlineEntryKind.Heading },
			{ label: 'foo.ts', kind: ChatOutlineEntryKind.FileEdit },
			{ label: 'bar.ts', kind: ChatOutlineEntryKind.FileEdit },
		]);
	});

	test('requests become top-level entries with response children', () => {
		const { outline } = setup(store, [
			reqVM('r1', 'first'),
			respVM('resp1', [{ kind: 'markdownContent', content: { value: '## Heading A' } }]),
			reqVM('r2', 'second'),
			respVM('resp2', [{ kind: 'textEditGroup', uri: URI.file('/a/edit.ts') }]),
		]);

		assert.deepStrictEqual(outline.entries.map(entry => ({
			label: entry.label,
			children: entry.children.map(child => child.label),
		})), [
			{ label: 'first', children: ['Heading A'] },
			{ label: 'second', children: ['edit.ts'] },
		]);
	});

	test('quick pick flattens children and escapes codicon markup', () => {
		const { outline } = setup(store, [
			reqVM('r1', '$(bug) fix'),
			respVM('resp1', [{ kind: 'markdownContent', content: { value: '## Details' } }]),
		]);

		const elements = outline.config.quickPickDataSource.getQuickPickElements();

		assert.deepStrictEqual(elements.map(e => ({ ariaLabel: e.ariaLabel, description: e.description })), [
			{ ariaLabel: '$(bug) fix', description: undefined },
			{ ariaLabel: 'Details', description: '$(bug) fix' },
		]);
		assert.ok(elements[0].label.includes('\\$(bug)'), elements[0].label);
	});

	test('only fires onDidChange when entries change', () => {
		const { viewModel, outline } = setup(store, [reqVM('r1', 'first'), reqVM('r2', 'second')]);

		let changes = 0;
		store.add(outline.onDidChange(() => changes++));

		// A view-model update with the same requests/children must not refresh.
		viewModel.onChange.fire(null);
		assert.strictEqual(changes, 0);

		// A new request must refresh the outline.
		viewModel.items = [...viewModel.items, reqVM('r3', 'third')];
		viewModel.onChange.fire(null);
		assert.strictEqual(changes, 1);

		assert.deepStrictEqual(outline.entries.map(entry => entry.label), ['first', 'second', 'third']);
	});

	test('reveal and preview navigate the chat widget', () => {
		const request = reqVM('r1', 'first');
		const response = respVM('resp1', [{ kind: 'markdownContent', content: { value: '## Child' } }]);
		const { widget, outline } = setup(store, [request, response]);
		const requestEntry = outline.entries[0];
		const childEntry = requestEntry.children[0];

		outline.reveal(requestEntry, {}, false, false);
		assert.deepStrictEqual(widget.revealed, [request]);
		assert.deepStrictEqual(widget.focused, [request]);

		// A child reveals the response row.
		outline.reveal(childEntry, {}, false, false);
		assert.deepStrictEqual(widget.revealed, [request, response]);

		store.add(outline.preview(childEntry));
		assert.deepStrictEqual(widget.revealed, [request, response, response]);
	});
});
