/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../../nls.js';
import { IDiffCommentsService, IDiffComment } from './diffCommentsService.js';
import { IChatWidgetService } from '../chat.js';
import { IDiffCommentsVariableEntry } from '../../common/attachments/chatVariableEntries.js';

const ATTACHMENT_ID_PREFIX = 'diffComments:';

/**
 * Keeps the "N comments" attachment in the chat input in sync with the
 * DiffCommentsService. One attachment per session resource, updated reactively.
 * Clears comments after the chat prompt is sent.
 */
export class DiffCommentsAttachmentContribution extends Disposable {

	static readonly ID = 'workbench.contrib.diffCommentsAttachment';

	/** Track onDidAcceptInput subscriptions per widget session */
	private readonly _widgetListeners = this._store.add(new DisposableMap<string>());

	/** Cache of resolved code snippets keyed by comment ID */
	private readonly _snippetCache = new Map<string, string | undefined>();

	constructor(
		@IDiffCommentsService private readonly _diffCommentsService: IDiffCommentsService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@ITextModelService private readonly _textModelService: ITextModelService,
	) {
		super();

		this._store.add(this._diffCommentsService.onDidChangeComments(e => {
			this._updateAttachment(e.sessionResource);
			this._ensureAcceptListener(e.sessionResource);
		}));
	}

	private async _updateAttachment(sessionResource: URI): Promise<void> {
		const widget = this._chatWidgetService.getWidgetBySessionResource(sessionResource);
		if (!widget) {
			return;
		}

		const comments = this._diffCommentsService.getComments(sessionResource);
		const attachmentId = ATTACHMENT_ID_PREFIX + sessionResource.toString();

		if (comments.length === 0) {
			widget.attachmentModel.delete(attachmentId);
			this._snippetCache.clear();
			return;
		}

		const value = await this._buildCommentsValue(comments);

		const entry: IDiffCommentsVariableEntry = {
			kind: 'diffComments',
			id: attachmentId,
			name: comments.length === 1
				? localize('diffComments.one', "1 comment")
				: localize('diffComments.many', "{0} comments", comments.length),
			icon: Codicon.comment,
			sessionResource,
			comments: comments.map(c => ({
				id: c.id,
				text: c.text,
				resourceUri: c.resourceUri,
				range: c.range,
			})),
			value,
		};

		// Upsert
		widget.attachmentModel.delete(attachmentId);
		widget.attachmentModel.addContext(entry);
	}

	/**
	 * Builds a rich string value for the diff comments attachment that includes
	 * the code snippet at each comment's location alongside the comment text.
	 * Uses a cache keyed by comment ID to avoid re-resolving snippets for
	 * comments that haven't changed.
	 */
	private async _buildCommentsValue(comments: readonly IDiffComment[]): Promise<string> {
		// Prune stale cache entries for comments that no longer exist
		const currentIds = new Set(comments.map(c => c.id));
		for (const cachedId of this._snippetCache.keys()) {
			if (!currentIds.has(cachedId)) {
				this._snippetCache.delete(cachedId);
			}
		}

		// Resolve only new (uncached) snippets
		const uncachedComments = comments.filter(c => !this._snippetCache.has(c.id));
		if (uncachedComments.length > 0) {
			await Promise.all(uncachedComments.map(async c => {
				const snippet = await this._getCodeSnippet(c.resourceUri, c.range);
				this._snippetCache.set(c.id, snippet);
			}));
		}

		// Build the final string from cache
		const parts: string[] = ['The following comments were made on the code changes:'];
		for (const comment of comments) {
			const codeSnippet = this._snippetCache.get(comment.id);
			const fileName = basename(comment.resourceUri);
			const lineRef = comment.range.startLineNumber === comment.range.endLineNumber
				? `${comment.range.startLineNumber}`
				: `${comment.range.startLineNumber}-${comment.range.endLineNumber}`;

			let part = `[${fileName}:${lineRef}]`;
			if (codeSnippet) {
				part += `\n\`\`\`\n${codeSnippet}\n\`\`\``;
			}
			part += `\nComment: ${comment.text}`;
			parts.push(part);
		}

		return parts.join('\n\n');
	}

	/**
	 * Resolves the text model for a resource and extracts the code in the given range.
	 * Returns undefined if the model cannot be resolved.
	 */
	private async _getCodeSnippet(resourceUri: URI, range: IRange): Promise<string | undefined> {
		try {
			const ref = await this._textModelService.createModelReference(resourceUri);
			try {
				return ref.object.textEditorModel.getValueInRange(range);
			} finally {
				ref.dispose();
			}
		} catch {
			return undefined;
		}
	}

	/**
	 * Ensure we listen for the chat widget's accept event so we can clear comments after send.
	 */
	private _ensureAcceptListener(sessionResource: URI): void {
		const key = sessionResource.toString();
		if (this._widgetListeners.has(key)) {
			return;
		}

		const widget = this._chatWidgetService.getWidgetBySessionResource(sessionResource);
		if (!widget) {
			return;
		}

		this._widgetListeners.set(key, widget.onDidAcceptInput(() => {
			this._diffCommentsService.clearComments(sessionResource);
			this._widgetListeners.deleteAndDispose(key);
		}));
	}
}
