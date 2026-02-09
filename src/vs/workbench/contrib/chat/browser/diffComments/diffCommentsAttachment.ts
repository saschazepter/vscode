/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IDiffCommentsService } from './diffCommentsService.js';
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

	constructor(
		@IDiffCommentsService private readonly _diffCommentsService: IDiffCommentsService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
	) {
		super();

		this._store.add(this._diffCommentsService.onDidChangeComments(e => {
			this._updateAttachment(e.sessionResource);
			this._ensureAcceptListener(e.sessionResource);
		}));
	}

	private _updateAttachment(sessionResource: URI): void {
		const widget = this._chatWidgetService.getWidgetBySessionResource(sessionResource);
		if (!widget) {
			return;
		}

		const comments = this._diffCommentsService.getComments(sessionResource);
		const attachmentId = ATTACHMENT_ID_PREFIX + sessionResource.toString();

		if (comments.length === 0) {
			widget.attachmentModel.delete(attachmentId);
			return;
		}

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
			value: comments.map(c => `[${c.resourceUri.path}:${c.range.startLineNumber}] ${c.text}`).join('\n'),
		};

		// Upsert
		widget.attachmentModel.delete(attachmentId);
		widget.attachmentModel.addContext(entry);
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
