/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IconLabel, IIconLabelValueOptions } from '../../../../base/browser/ui/iconLabel/iconLabel.js';
import { renderAsPlaintext } from '../../../../base/browser/markdownRenderer.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { IDataSource, ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createMatches, FuzzyScore } from '../../../../base/common/filters.js';
import { escapeIcons } from '../../../../base/common/iconLabels.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { marked } from '../../../../base/common/marked/marked.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IWorkbenchDataTreeOptions } from '../../../../platform/list/browser/listService.js';
import { IBreadcrumbsDataSource, IBreadcrumbsOutlineElement, IOutline, IOutlineComparator, IOutlineListConfig, IQuickPickDataSource, IQuickPickOutlineElement, OutlineChangeEvent, OutlineTarget } from '../../../services/outline/browser/outline.js';
import { ChatTreeItem, IChatWidget } from './chat.js';
import { getExplicitFileOrImageAttachmentSummary } from '../common/attachments/chatVariableEntries.js';
import { isChatFollowup } from '../common/chatService/chatService.js';
import { IChatRequestViewModel, IChatResponseViewModel, isRequestVM, isResponseVM } from '../common/model/chatViewModel.js';

/**
 * Derives the display label for a chat request. Reads the prompt text the same
 * way the chat list renders it (followup message, else the parsed request
 * parts) rather than relying on `messageText`, which some providers (e.g.
 * agent-host sessions) leave empty. When there is no prompt text, falls back to
 * an attachment summary (matching the chat list) and finally a numbered label.
 * Collapses whitespace so multi-line prompts render on a single row. Returns raw
 * text; callers that render into an icon-parsing surface (e.g. the quick pick)
 * must escape `$(...)` codicon markup themselves via `escapeIcons`.
 */
export function getChatRequestLabel(request: IChatRequestViewModel, index: number): string {
	const message = request.message;
	let raw: string;
	if (isChatFollowup(message)) {
		raw = message.message ?? '';
	} else {
		raw = message.text || (Array.isArray(message.parts) ? message.parts.map(part => part.text).join('') : '');
	}
	const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
	if (text.length > 0) {
		return text;
	}
	return getExplicitFileOrImageAttachmentSummary(request.variables) ?? localize('chatOutline.emptyRequest', "Request {0}", index + 1);
}

export const enum ChatOutlineEntryKind {
	Request = 'request',
	Heading = 'heading',
	FileEdit = 'fileEdit',
}

/**
 * A single navigable element in a chat outline. Top-level entries map to user
 * requests (prompts); their children map to meaningful items inside the
 * response (markdown headings and file edits). Selecting an entry reveals its
 * chat row (the request row for a request, the response row for a child).
 */
export class ChatOutlineEntry {

	readonly children: ChatOutlineEntry[] = [];
	parent: ChatOutlineEntry | undefined;

	constructor(
		readonly id: string,
		readonly sortIndex: number,
		readonly label: string,
		readonly icon: ThemeIcon,
		readonly kind: ChatOutlineEntryKind,
		/** The chat row revealed when this entry is picked. */
		readonly revealTarget: ChatTreeItem,
	) { }

	addChild(child: ChatOutlineEntry): void {
		child.parent = this;
		this.children.push(child);
	}
}

/**
 * Builds the response-level child entries (markdown headings and file edits) for
 * a response, in document order. Each child reveals the response row.
 */
export function buildResponseChildren(response: IChatResponseViewModel, nextSortIndex: () => number): ChatOutlineEntry[] {
	const children: ChatOutlineEntry[] = [];
	let headingIndex = 0;
	let editIndex = 0;

	const addFileEdit = (uri: URI | undefined) => {
		if (!uri) {
			return;
		}
		children.push(new ChatOutlineEntry(
			`${response.id}#edit${editIndex++}`,
			nextSortIndex(),
			basename(uri) || uri.toString(),
			Codicon.symbolFile,
			ChatOutlineEntryKind.FileEdit,
			response,
		));
	};

	for (const part of response.response.value) {
		switch (part.kind) {
			case 'markdownContent': {
				for (const token of marked.lexer(part.content.value, { gfm: true })) {
					if (token.type === 'heading') {
						const text = renderAsPlaintext({ value: token.raw }).replace(/\s+/g, ' ').trim();
						if (text.length > 0) {
							children.push(new ChatOutlineEntry(
								`${response.id}#h${headingIndex++}`,
								nextSortIndex(),
								text,
								Codicon.symbolString,
								ChatOutlineEntryKind.Heading,
								response,
							));
						}
					}
				}
				break;
			}
			case 'textEditGroup':
			case 'notebookEditGroup':
				addFileEdit(part.uri);
				break;
			case 'workspaceEdit':
				for (const edit of part.edits) {
					addFileEdit(edit.newResource ?? edit.oldResource);
				}
				break;
		}
	}

	return children;
}

class ChatOutlineVirtualDelegate implements IListVirtualDelegate<ChatOutlineEntry> {
	getHeight(): number {
		return 22;
	}
	getTemplateId(): string {
		return ChatOutlineRenderer.templateId;
	}
}

interface IChatOutlineTemplate {
	readonly container: HTMLElement;
	readonly iconClass: HTMLElement;
	readonly iconLabel: IconLabel;
}

class ChatOutlineRenderer implements ITreeRenderer<ChatOutlineEntry, FuzzyScore, IChatOutlineTemplate> {

	static readonly templateId = 'ChatOutlineRenderer';
	readonly templateId = ChatOutlineRenderer.templateId;

	renderTemplate(container: HTMLElement): IChatOutlineTemplate {
		container.classList.add('chat-outline-element');
		const iconClass = document.createElement('div');
		container.append(iconClass);
		const iconLabel = new IconLabel(container, { supportHighlights: true });
		return { container, iconClass, iconLabel };
	}

	renderElement(node: ITreeNode<ChatOutlineEntry, FuzzyScore>, _index: number, template: IChatOutlineTemplate): void {
		const options: IIconLabelValueOptions = {
			matches: createMatches(node.filterData),
			labelEscapeNewLines: true,
		};
		template.iconClass.className = 'element-icon ' + ThemeIcon.asClassNameArray(node.element.icon).join(' ');
		template.iconLabel.setLabel(node.element.label, undefined, options);
	}

	disposeTemplate(template: IChatOutlineTemplate): void {
		template.iconLabel.dispose();
	}
}

class ChatOutlineAccessibility implements IListAccessibilityProvider<ChatOutlineEntry> {
	getAriaLabel(element: ChatOutlineEntry): string {
		return element.label;
	}
	getWidgetAriaLabel(): string {
		return localize('chatOutline', "Chat Outline");
	}
}

class ChatOutlineComparator implements IOutlineComparator<ChatOutlineEntry> {
	compareByPosition(a: ChatOutlineEntry, b: ChatOutlineEntry): number {
		return a.sortIndex - b.sortIndex;
	}
	compareByType(a: ChatOutlineEntry, b: ChatOutlineEntry): number {
		return a.kind === b.kind ? a.sortIndex - b.sortIndex : a.kind.localeCompare(b.kind);
	}
	compareByName(a: ChatOutlineEntry, b: ChatOutlineEntry): number {
		return a.label.localeCompare(b.label);
	}
}

class ChatOutlineTreeDataSource implements IDataSource<ChatOutline, ChatOutlineEntry> {
	getChildren(element: ChatOutline | ChatOutlineEntry): Iterable<ChatOutlineEntry> {
		return element instanceof ChatOutline ? element.entries : element.children;
	}
}

class ChatOutlineQuickPickDataSource implements IQuickPickDataSource<ChatOutlineEntry> {
	constructor(private readonly _outline: ChatOutline) { }
	getQuickPickElements(): IQuickPickOutlineElement<ChatOutlineEntry>[] {
		const result: IQuickPickOutlineElement<ChatOutlineEntry>[] = [];
		const flatten = (entries: readonly ChatOutlineEntry[]) => {
			for (const entry of entries) {
				result.push({
					element: entry,
					// Codicons cannot be passed via `iconClasses` in this quick pick
					// (only file icons can); embed the icon inline in the label
					// instead and escape only the text so `$(...)` stays literal.
					label: `$(${entry.icon.id}) ${escapeIcons(entry.label)}`,
					ariaLabel: entry.label,
					// Show the owning request as context for response children.
					description: entry.parent ? entry.parent.label : undefined,
				});
				flatten(entry.children);
			}
		};
		flatten(this._outline.entries);
		return result;
	}
}

class ChatOutlineBreadcrumbsDataSource implements IBreadcrumbsDataSource<ChatOutlineEntry> {
	constructor(private readonly _outline: ChatOutline) { }
	getBreadcrumbElements(): readonly IBreadcrumbsOutlineElement<ChatOutlineEntry>[] {
		const path: IBreadcrumbsOutlineElement<ChatOutlineEntry>[] = [];
		let entry = this._outline.activeElement;
		while (entry) {
			path.unshift({ element: entry, label: entry.label });
			entry = entry.parent;
		}
		return path;
	}
}

export class ChatOutline implements IOutline<ChatOutlineEntry> {

	readonly outlineKind = 'chat';

	private readonly _disposables = new DisposableStore();
	private readonly _onDidChange = this._disposables.add(new Emitter<OutlineChangeEvent>());
	readonly onDidChange: Event<OutlineChangeEvent> = this._onDidChange.event;

	private _entries: ChatOutlineEntry[] = [];
	readonly config: IOutlineListConfig<ChatOutlineEntry>;

	constructor(
		private readonly _widget: IChatWidget,
		target: OutlineTarget,
	) {
		this._recomputeEntries();

		this._disposables.add(this._widget.onDidChangeViewModel(() => {
			const changed = this._recomputeEntries();
			this._registerViewModelListener();
			if (changed) {
				this._onDidChange.fire({});
			}
		}));
		this._registerViewModelListener();

		const options: IWorkbenchDataTreeOptions<ChatOutlineEntry, FuzzyScore> = {
			collapseByDefault: target === OutlineTarget.Breadcrumbs,
			expandOnlyOnTwistieClick: true,
			multipleSelectionSupport: false,
			accessibilityProvider: new ChatOutlineAccessibility(),
			identityProvider: { getId: element => element.id },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: element => element.label },
		};

		this.config = {
			treeDataSource: new ChatOutlineTreeDataSource(),
			quickPickDataSource: new ChatOutlineQuickPickDataSource(this),
			breadcrumbsDataSource: new ChatOutlineBreadcrumbsDataSource(this),
			delegate: new ChatOutlineVirtualDelegate(),
			renderers: [new ChatOutlineRenderer()],
			comparator: new ChatOutlineComparator(),
			options,
		};
	}

	private readonly _viewModelDisposables = this._disposables.add(new DisposableStore());
	private _registerViewModelListener(): void {
		this._viewModelDisposables.clear();
		const viewModel = this._widget.viewModel;
		if (viewModel) {
			this._viewModelDisposables.add(viewModel.onDidChange(() => {
				// The view model fires on every response update (including each
				// streamed chunk). The signature check below keeps the outline
				// stable unless the request/heading/edit set actually changes.
				if (this._recomputeEntries()) {
					this._onDidChange.fire({});
				}
			}));
		}
	}

	private _entriesSignature = '';
	private _recomputeEntries(): boolean {
		const items = this._widget.viewModel?.getItems() ?? [];
		const entries: ChatOutlineEntry[] = [];
		let sortIndex = 0;
		const nextSortIndex = () => sortIndex++;

		let requestIndex = 0;
		let current: ChatOutlineEntry | undefined;
		for (const item of items) {
			if (isRequestVM(item)) {
				current = new ChatOutlineEntry(
					item.id,
					nextSortIndex(),
					getChatRequestLabel(item, requestIndex++),
					Codicon.commentDiscussion,
					ChatOutlineEntryKind.Request,
					item,
				);
				entries.push(current);
			} else if (isResponseVM(item) && current) {
				for (const child of buildResponseChildren(item, nextSortIndex)) {
					current.addChild(child);
				}
			}
		}

		const signature = entries.map(serializeEntrySignature).join('\u0001');
		if (signature === this._entriesSignature) {
			return false;
		}

		this._entries = entries;
		this._entriesSignature = signature;
		return true;
	}

	get entries(): ChatOutlineEntry[] {
		return this._entries;
	}

	get uri(): URI | undefined {
		return this._widget.viewModel?.sessionResource;
	}

	get isEmpty(): boolean {
		return this._entries.length === 0;
	}

	get activeElement(): ChatOutlineEntry | undefined {
		const focus = this._widget.getFocus();
		if (!focus) {
			return undefined;
		}
		// A focused request matches its own entry; a focused response matches its
		// first child (so breadcrumbs show the request path), else the request.
		for (const entry of this._entries) {
			if (entry.revealTarget === focus) {
				return entry;
			}
			const child = entry.children.find(c => c.revealTarget === focus);
			if (child) {
				return child;
			}
		}
		return undefined;
	}

	reveal(entry: ChatOutlineEntry, _options: IEditorOptions, _sideBySide: boolean, _select: boolean): void {
		this._widget.reveal(entry.revealTarget);
		this._widget.focus(entry.revealTarget);
	}

	preview(entry: ChatOutlineEntry): IDisposable {
		this._widget.reveal(entry.revealTarget);
		return Disposable.None;
	}

	captureViewState(): IDisposable {
		return Disposable.None;
	}

	dispose(): void {
		this._disposables.dispose();
	}
}

function serializeEntrySignature(entry: ChatOutlineEntry): string {
	const children = entry.children.map(serializeEntrySignature).join('\u0002');
	return `${entry.id}\u0000${entry.label}\u0000${children}`;
}
